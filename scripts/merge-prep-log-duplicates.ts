/**
 * Merge the PrepLog pairs that repair-prep-log-dates.ts could not re-date.
 *
 * The old server-local day rule (UTC on Vercel) stamped anything written after
 * 5pm Pacific with the NEXT day. Where the item already had a row on the real
 * day, that produced TWO rows for one job on one restaurant day: the morning row
 * (posted / started, usually no yield) and the evening row that actually carries
 * the work. The schema allows one row per item per day — @@unique([prepItemId,
 * logDate]) — so these can only be fixed by merging, not by re-dating.
 *
 * The row already sitting on the true day survives; the mis-dated row is folded
 * into it and deleted:
 *   status         most resolved wins  (DONE/PARTIAL > IN_PROGRESS > NOT_STARTED > SKIPPED)
 *   actualPrepQty  SUMMED — see below
 *   startedAt      earliest      completedAt  latest
 *   postedAt       whichever is set (later wins)
 *   requiredQty / listOrder / assignedTo / note  survivor's, else the other's
 *
 * Quantities are SUMMED, never dropped. Both rows count toward theoretical stock
 * today, so summing keeps the stock total identical while moving the production
 * onto the day it happened; deleting one would silently remove that yield from
 * inventory. Where both rows carry a yield they are two real batches on one day
 * (hours apart, e.g. 15.8 lb at 12:25 and 15 lb at 17:15) and the day's total is
 * the sum. The script asserts per-item conservation before it writes.
 *
 * It also normalises rows whose logDate is not at UTC midnight: 48 rows sit at
 * 07:00Z (Pacific midnight), written by a Pacific-local server under the same
 * old rule. The unique index does not see those as duplicates of the canonical
 * 00:00Z row for the same day, so they are the same duplicate-pair problem in a
 * disguise the database cannot catch.
 *
 *   npx tsx scripts/merge-prep-log-duplicates.ts          # dry run, writes nothing
 *   npx tsx scripts/merge-prep-log-duplicates.ts --apply  # writes
 */
import { writeFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'
import { prepDayKey } from '../src/lib/prep-day'

const APPLY = process.argv.includes('--apply')
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const COMPLETED = new Set(['DONE', 'PARTIAL'])
const RANK = ['SKIPPED', 'NOT_STARTED', 'IN_PROGRESS', 'PARTIAL', 'DONE']
const num = (v: unknown) => (v == null ? 0 : Number(v))

const SELECT = {
  id: true, prepItemId: true, revenueCenterId: true, logDate: true, createdAt: true,
  completedAt: true, startedAt: true, postedAt: true, status: true, actualPrepQty: true,
  requiredQty: true, listOrder: true, note: true, assignedTo: true, inventoryAdjusted: true,
  prepItem: { select: { name: true, unit: true } },
} as const
type Row = Awaited<ReturnType<typeof fetchAll>>[number]
const fetchAll = () => prisma.prepLog.findMany({ select: SELECT })

const belongsOn = (l: { status: string; completedAt: Date | null; createdAt: Date }) =>
  prepDayKey(COMPLETED.has(l.status) && l.completedAt ? l.completedAt : l.createdAt)

/** The canonical stored marker for a day key. */
const marker = (key: string) => new Date(`${key}T00:00:00.000Z`)
/** A row is correctly stamped only if it sits exactly on its day's marker. */
const isStamped = (l: Row) => l.logDate.getTime() === marker(belongsOn(l)).getTime()

/** Total recorded yield per item — must not change. */
function yieldByItem(rows: Row[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    if (!COMPLETED.has(r.status)) continue
    m.set(r.prepItemId, (m.get(r.prepItemId) ?? 0) + num(r.actualPrepQty))
  }
  return m
}

function fold(survivor: Row, victim: Row) {
  const qty = num(survivor.actualPrepQty) + num(victim.actualPrepQty)
  const status = RANK.indexOf(victim.status) > RANK.indexOf(survivor.status) ? victim.status : survivor.status
  const pick = <T>(a: T | null, b: T | null) => (a != null ? a : b)
  const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b))
  const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b))
  const notes = [survivor.note, victim.note].filter(Boolean) as string[]
  return {
    status,
    // A merged row that ends up resolved must keep its yield; an unresolved one
    // has none to keep.
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
  const beforeYield = yieldByItem(before)

  // Work oldest-first off a live in-memory view: merging can leave the survivor
  // itself mis-dated (a chain), and it must then be re-examined, not skipped.
  const live = new Map(before.map(r => [r.id, { ...r }]))
  const slot = (itemId: string, day: string) => `${itemId}|${day}`
  const bySlot = new Map([...live.values()].map(r => [slot(r.prepItemId, dayKey(r.logDate)), r]))

  // `was` snapshots the survivor BEFORE the fold — the survivor object is mutated
  // in place to keep the in-memory view honest, so reporting off it afterwards
  // would show every pair as already merged and misclassify all of them.
  const merges: {
    survivor: Row; victim: Row; next: ReturnType<typeof fold>
    was: { status: string; qty: number }
  }[] = []
  const redates: { row: Row; to: string }[] = []
  // Planned order is the ONLY safe execution order: a re-date can be possible
  // only because an earlier merge deleted the row that was blocking that slot.
  // Running all re-dates first hits the unique (prepItemId, logDate).
  const ops: Array<{ kind: 'redate'; row: Row; to: string } | { kind: 'merge'; i: number }> = []

  for (const row of [...live.values()].sort((a, b) => a.logDate.getTime() - b.logDate.getTime())) {
    if (!live.has(row.id)) continue // already merged away
    const to = belongsOn(row)
    if (isStamped(row)) continue

    const occupant = bySlot.get(slot(row.prepItemId, to))
    if (!occupant || occupant.id === row.id) {
      // Nothing in the way (a chain can free a slot) — a plain re-date.
      redates.push({ row, to })
      ops.push({ kind: 'redate', row, to })
      bySlot.delete(slot(row.prepItemId, dayKey(row.logDate)))
      row.logDate = marker(to)
      bySlot.set(slot(row.prepItemId, to), row)
      continue
    }
    const next = fold(occupant, row)
    merges.push({
      survivor: occupant, victim: row, next,
      was: { status: occupant.status, qty: num(occupant.actualPrepQty) },
    })
    ops.push({ kind: 'merge', i: merges.length - 1 })
    Object.assign(occupant, next)
    bySlot.delete(slot(row.prepItemId, dayKey(row.logDate)))
    live.delete(row.id)
  }

  // Conservation: the merged view must record exactly the same yield per item.
  const afterYield = yieldByItem([...live.values()])
  const drift: string[] = []
  for (const [itemId, qty] of beforeYield) {
    const now = afterYield.get(itemId) ?? 0
    if (Math.abs(now - qty) > 1e-9) drift.push(`${itemId}: ${qty} → ${now}`)
  }

  const cls = (m: (typeof merges)[number]) =>
    num(m.victim.actualPrepQty) > 0 && m.was.qty > 0 ? 'TWO YIELDS SUMMED'
    : num(m.victim.actualPrepQty) > 0 ? 'yield kept, orphan row dropped'
    : m.was.qty > 0 ? 'inert row dropped, yield untouched'
    : 'duplicate list row dropped'

  console.log(`merges: ${merges.length}   plain re-dates freed by a chain: ${redates.length}`)
  for (const m of merges) {
    console.log(
      `  ${dayKey(m.survivor.logDate)} ${m.survivor.prepItem.name.slice(0, 32).padEnd(33)}` +
      ` ${m.victim.status}/${num(m.victim.actualPrepQty) || '-'} + ${m.was.status}/${m.was.qty || '-'}` +
      ` → ${m.next.status}/${num(m.next.actualPrepQty) || '-'} ${m.survivor.prepItem.unit}   (${cls(m)})`)
  }
  console.log(`\nyield conservation per item: ${drift.length === 0 ? 'OK — unchanged' : 'DRIFT ' + drift.join(', ')}`)
  const leftover = [...live.values()].filter(r => !isStamped(r)).length
  console.log(`rows still mis-stamped after the pass: ${leftover}`)

  if (drift.length > 0) {
    console.log('\nABORT — a merge would change recorded production. Nothing written.')
    return
  }
  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `prep-log-merge-backup-${stamp}.json`
  writeFileSync(backup, JSON.stringify({ merges, redates }, null, 2))
  console.log(`\nbackup written: ${backup}`)

  for (const op of ops) {
    if (op.kind === 'redate') {
      await prisma.prepLog.update({
        where: { id: op.row.id },
        data: { logDate: marker(op.to) },
      })
    } else {
      const m = merges[op.i]
      await prisma.$transaction([
        prisma.prepLog.update({ where: { id: m.survivor.id }, data: m.next }),
        prisma.prepLog.delete({ where: { id: m.victim.id } }),
      ])
    }
  }

  const after = await fetchAll()
  const afterReal = yieldByItem(after)
  const realDrift = [...beforeYield].filter(([id, q]) => Math.abs((afterReal.get(id) ?? 0) - q) > 1e-9)
  console.log(`\nAPPLIED. rows: ${before.length} → ${after.length} (−${before.length - after.length})`)
  console.log(`recorded yield per item: ${realDrift.length === 0 ? 'unchanged' : 'DRIFT ' + realDrift.length + ' items'}`)
  console.log(`rows still mis-stamped: ${after.filter(r => !isStamped(r)).length}`)
}

main().finally(() => prisma.$disconnect())
