/**
 * Repair PrepLog.logDate rows mis-stamped by the old server-local day rule.
 *
 * Until src/lib/prep-day.ts landed, a log's day was `new Date().setHours(0,0,0,0)`
 * on the server — UTC in production. Anything written between 5pm Pacific and
 * midnight therefore got stamped with the NEXT day, so an evening prep reads as
 * the following day's production in /reports/prep and windows a day late in the
 * theoretical-stock engine (prepEventCounts in count-expected.ts).
 *
 * The repair re-dates each row to the restaurant day the work belongs to:
 * `completedAt` for a finished prep (production is dated when it was produced —
 * the same rule the completion handler now applies to a carried log), else
 * `createdAt`. It is idempotent (a repaired row no longer matches), skips any
 * move that would collide with the unique (prepItemId, logDate), and writes a
 * backup JSON of every change first.
 *
 *   npx tsx scripts/repair-prep-log-dates.ts          # dry run, writes nothing
 *   npx tsx scripts/repair-prep-log-dates.ts --apply  # writes
 */
import { writeFileSync } from 'fs'
import { prisma } from '../src/lib/prisma'
import { prepDayKey } from '../src/lib/prep-day'

const APPLY = process.argv.includes('--apply')
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const marker = (key: string) => new Date(`${key}T00:00:00.000Z`)

async function main() {
  const logs = await prisma.prepLog.findMany({
    select: {
      id: true, prepItemId: true, logDate: true, createdAt: true, completedAt: true,
      status: true, actualPrepQty: true, prepItem: { select: { name: true } },
    },
    orderBy: { logDate: 'asc' },
  })

  // A finished prep belongs to the day it was finished; anything else to the day
  // its row was opened.
  const COMPLETED = new Set(['DONE', 'PARTIAL'])
  const belongsOn = (l: { status: string; completedAt: Date | null; createdAt: Date }) =>
    prepDayKey(COMPLETED.has(l.status) && l.completedAt ? l.completedAt : l.createdAt)

  const moves = logs
    .map(l => ({ log: l, from: dayKey(l.logDate), to: belongsOn(l) }))
    .filter(m => m.from !== m.to)

  // A move onto a day the item already has a row for would break the unique
  // (prepItemId, logDate). Those rows are reported and left alone — merging two
  // logs is a judgement call, not a mechanical repair.
  //
  // Run to a fixpoint: a target occupied by a row that is itself blocked never
  // frees up, so blocking one move can block the one behind it. Testing this in
  // a single pass reports moves as safe that then fail on the constraint.
  const occupied = new Set(logs.map(l => `${l.prepItemId}|${dayKey(l.logDate)}`))
  const slot = (prepItemId: string, day: string) => `${prepItemId}|${day}`
  let safe = moves
  for (;;) {
    const vacating = new Set(safe.map(m => slot(m.log.prepItemId, m.from)))
    const next = safe.filter(m => {
      const target = slot(m.log.prepItemId, m.to)
      return !occupied.has(target) || vacating.has(target)
    })
    if (next.length === safe.length) break
    safe = next
  }
  const collisions = moves.filter(m => !safe.includes(m))

  // Every shift is backwards a day, so freeing a slot before filling it just
  // means applying in date order.
  safe = [...safe].sort((a, b) => a.from.localeCompare(b.from))

  const stockAffecting = safe.filter(m => m.log.status === 'DONE' || m.log.status === 'PARTIAL')
  const shifts = new Map<number, number>()
  for (const m of safe) {
    const days = Math.round((marker(m.to).getTime() - marker(m.from).getTime()) / 86_400_000)
    shifts.set(days, (shifts.get(days) ?? 0) + 1)
  }

  console.log(`PrepLog rows:            ${logs.length}`)
  console.log(`mis-stamped:             ${moves.length}`)
  console.log(`  repairable:            ${safe.length}`)
  console.log(`  skipped (would clash): ${collisions.length}`)
  console.log(`  of the repairable, stock-affecting (DONE/PARTIAL): ${stockAffecting.length}`)
  console.log(`shift in days → rows:    ${[...shifts.entries()].map(([d, n]) => `${d > 0 ? '+' : ''}${d}: ${n}`).join(', ')}`)

  // What the blocked moves are actually up against — printed in full, because a
  // silent "47 skipped" reads as "repaired" when it isn't.
  if (collisions.length > 0) {
    const byKey = new Map(logs.map(l => [`${l.prepItemId}|${dayKey(l.logDate)}`, l]))
    console.log(`\nBLOCKED (${collisions.length}) — the target day already has a row for that item:`)
    for (const c of collisions) {
      const sitting = byKey.get(`${c.log.prepItemId}|${c.to}`)!
      const qty = (l: typeof sitting) => (l.actualPrepQty ? ` ${l.actualPrepQty}` : '')
      console.log(
        `   ${c.log.prepItem.name.padEnd(38)} ${c.from} [${c.log.status}${qty(c.log)}]` +
        ` → ${c.to} occupied by [${sitting.status}${qty(sitting)}]`,
      )
    }
  }

  console.log('\nsample:')
  for (const m of safe.slice(0, 10)) {
    console.log(`   ${m.log.prepItem.name.padEnd(34)} ${m.from} → ${m.to}  ${m.log.status}  created ${m.log.createdAt.toISOString()}`)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `prep-log-date-repair-backup-${stamp}.json`
  writeFileSync(backup, JSON.stringify(
    safe.map(m => ({
      id: m.log.id, prepItemId: m.log.prepItemId, name: m.log.prepItem.name,
      status: m.log.status, from: m.log.logDate.toISOString(), to: marker(m.to).toISOString(),
      createdAt: m.log.createdAt.toISOString(),
    })), null, 2))
  console.log(`\nbackup written: ${backup}`)

  let done = 0
  for (const batch of chunk(safe, 25)) {
    await prisma.$transaction(batch.map(m =>
      prisma.prepLog.update({ where: { id: m.log.id }, data: { logDate: marker(m.to) } })))
    done += batch.length
    console.log(`  updated ${done}/${safe.length}`)
  }

  const after = await prisma.prepLog.findMany({
    select: { logDate: true, createdAt: true, completedAt: true, status: true },
  })
  const left = after.filter(l => dayKey(l.logDate) !== belongsOn(l)).length
  console.log(`\nAPPLIED. Rows still mis-stamped: ${left} (expected ${collisions.length} — the clashes).`)
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

main().finally(() => prisma.$disconnect())
