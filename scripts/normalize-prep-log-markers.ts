/**
 * Normalise PrepLog.logDate onto the canonical marker: UTC midnight of the
 * restaurant day (src/lib/prep-day.ts).
 *
 * A batch of rows sit at 07:00Z — Pacific midnight — written by a Pacific-local
 * server under the old `setHours(0,0,0,0)` rule. They land on the right DAY, so
 * reports and range queries look fine, but they are not the marker the app
 * writes now, and @@unique([prepItemId, logDate]) does NOT see them as duplicates
 * of the canonical 00:00Z row for the same day. That is the same duplicate-pair
 * problem the merge pass fixed, in a disguise the database cannot catch.
 *
 * Every move here is WITHIN a day (07:00Z → 00:00Z of the same date), so unlike
 * the merge pass there are no cross-day chains: grouping by (item, day) makes
 * each group's target slot unique by construction, and the ordering hazard that
 * needs a fixpoint elsewhere cannot arise.
 *
 * Within a group the canonical row survives (else the earliest-created one); the
 * others are folded into it and deleted, quantities SUMMED so recorded
 * production is conserved — asserted before anything is written.
 *
 *   npx tsx scripts/normalize-prep-log-markers.ts          # dry run
 *   npx tsx scripts/normalize-prep-log-markers.ts --apply  # writes
 */
import { writeFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'

const APPLY = process.argv.includes('--apply')
const COMPLETED = new Set(['DONE', 'PARTIAL'])
const RANK = ['SKIPPED', 'NOT_STARTED', 'IN_PROGRESS', 'PARTIAL', 'DONE']
const num = (v: unknown) => (v == null ? 0 : Number(v))
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const marker = (key: string) => new Date(`${key}T00:00:00.000Z`)
const isCanonical = (d: Date) => d.toISOString().slice(11) === '00:00:00.000Z'

const SELECT = {
  id: true, prepItemId: true, logDate: true, createdAt: true, completedAt: true,
  startedAt: true, postedAt: true, status: true, actualPrepQty: true, requiredQty: true,
  listOrder: true, note: true, assignedTo: true, inventoryAdjusted: true,
  prepItem: { select: { name: true, unit: true } },
} as const
const fetchAll = () => prisma.prepLog.findMany({ select: SELECT })
type Row = Awaited<ReturnType<typeof fetchAll>>[number]

const totalYield = (rows: Row[]) =>
  rows.filter(r => COMPLETED.has(r.status)).reduce((a, r) => a + num(r.actualPrepQty), 0)

function fold(survivor: Row, victim: Row) {
  const qty = num(survivor.actualPrepQty) + num(victim.actualPrepQty)
  const pick = <T>(a: T | null, b: T | null) => (a != null ? a : b)
  const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b))
  const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b))
  const notes = [survivor.note, victim.note].filter(Boolean) as string[]
  return {
    status: RANK.indexOf(victim.status) > RANK.indexOf(survivor.status) ? victim.status : survivor.status,
    actualPrepQty: qty > 0 ? qty : null,
    requiredQty: pick(survivor.requiredQty, victim.requiredQty),
    startedAt: earliest(survivor.startedAt, victim.startedAt),
    completedAt: latest(survivor.completedAt, victim.completedAt),
    postedAt: latest(survivor.postedAt, victim.postedAt),
    listOrder: pick(survivor.listOrder, victim.listOrder),
    assignedTo: pick(survivor.assignedTo, victim.assignedTo),
    note: notes.length ? [...new Set(notes)].join(' · ') : null,
    inventoryAdjusted: survivor.inventoryAdjusted || victim.inventoryAdjusted,
  }
}

async function main() {
  const before = await fetchAll()

  const groups = new Map<string, Row[]>()
  for (const r of before) {
    const k = `${r.prepItemId}|${dayKey(r.logDate)}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }

  const plan: { survivor: Row; victims: Row[]; data: Record<string, unknown>; label: string }[] = []
  for (const [, rows] of groups) {
    const needsMerge = rows.length > 1
    const needsMove = rows.some(r => !isCanonical(r.logDate))
    if (!needsMerge && !needsMove) continue

    // Canonical row wins; otherwise the earliest-created one.
    const sorted = [...rows].sort((a, b) =>
      Number(isCanonical(b.logDate)) - Number(isCanonical(a.logDate)) ||
      a.createdAt.getTime() - b.createdAt.getTime())
    const [survivor, ...victims] = sorted

    let data: Record<string, unknown> = {}
    let merged = { ...survivor }
    for (const v of victims) {
      const next = fold(merged as Row, v)
      merged = { ...merged, ...next } as Row
      data = { ...data, ...next }
    }
    const day = dayKey(survivor.logDate)
    if (!isCanonical(survivor.logDate)) data.logDate = marker(day)
    if (Object.keys(data).length === 0) continue

    plan.push({
      survivor, victims, data,
      label: `${day} ${survivor.prepItem.name.slice(0, 32).padEnd(33)}` +
        (victims.length
          ? `merge ${victims.length + 1} rows → ${merged.status}/${num(merged.actualPrepQty) || '-'} ${survivor.prepItem.unit}`
          : `re-stamp ${survivor.logDate.toISOString().slice(11, 19)} → 00:00:00`),
    })
  }

  const victimIds = new Set(plan.flatMap(p => p.victims.map(v => v.id)))
  const afterRows = before
    .filter(r => !victimIds.has(r.id))
    .map(r => {
      const p = plan.find(x => x.survivor.id === r.id)
      return p ? ({ ...r, ...p.data } as Row) : r
    })
  const drift = totalYield(afterRows) - totalYield(before)

  for (const p of plan) console.log('  ' + p.label)
  console.log(`\nrows touched: ${plan.length}   rows deleted: ${victimIds.size}`)
  console.log(`recorded yield: ${totalYield(before)} → ${totalYield(afterRows)} ${Math.abs(drift) < 1e-9 ? '(unchanged)' : '(DRIFT)'}`)

  if (Math.abs(drift) > 1e-9) { console.log('\nABORT — production would change. Nothing written.'); return }
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `prep-log-marker-backup-${stamp}.json`
  writeFileSync(backup, JSON.stringify(plan, null, 2))
  console.log(`\nbackup written: ${backup}`)

  for (const p of plan) {
    // Victims first: the survivor's move can only land once its slot is free.
    await prisma.$transaction([
      ...p.victims.map(v => prisma.prepLog.delete({ where: { id: v.id } })),
      prisma.prepLog.update({ where: { id: p.survivor.id }, data: p.data }),
    ])
  }

  const after = await fetchAll()
  const dupes = new Map<string, number>()
  for (const r of after) {
    const k = `${r.prepItemId}|${dayKey(r.logDate)}`
    dupes.set(k, (dupes.get(k) ?? 0) + 1)
  }
  console.log(`\nAPPLIED. rows: ${before.length} → ${after.length}`)
  console.log(`off-midnight markers: ${after.filter(r => !isCanonical(r.logDate)).length}`)
  console.log(`item+day duplicates:  ${[...dupes.values()].filter(n => n > 1).length}`)
  console.log(`recorded yield:       ${totalYield(after)} (was ${totalYield(before)})`)
}

main().finally(() => prisma.$disconnect())
