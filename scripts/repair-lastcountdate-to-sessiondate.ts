/**
 * One-off repair: `lastCountDate` was historically stamped with the count's
 * FINALIZE timestamp instead of its `sessionDate` (the effective count date).
 * That pushed baselines forward and caused theoretical stock to drop sales that
 * fell between the real count date and the approval date.
 *
 * Fix: for every item, set `lastCountDate` to the sessionDate of the LATEST
 * finalized count session that counted it with a non-skipped line. This pulls
 * the big "Full Count Jun 1st" items back to June 1 while leaving items that were
 * legitimately recounted mid-period (quick counts) at their real recount date.
 *
 * Dry-run by default. Set APPLY=1 to write.
 */
import { prisma } from '../src/lib/prisma'

async function main() {
  const apply = process.env.APPLY === '1'

  const sessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    select: {
      id: true, label: true, sessionDate: true, finalizedAt: true,
      lines: { select: { inventoryItemId: true, countedQty: true } },
    },
  })

  // Per item -> the session with the max finalizedAt that has a counted (non-skipped) line.
  // A skipped line has countedQty == null and does NOT update lastCountDate on finalize,
  // so we mirror that here.
  const best = new Map<string, { sessionDate: Date; finalizedAt: Date; label: string }>()
  for (const s of sessions) {
    if (!s.finalizedAt) continue
    for (const line of s.lines) {
      if (line.countedQty == null) continue // skipped — didn't stamp lastCountDate
      const cur = best.get(line.inventoryItemId)
      if (!cur || s.finalizedAt > cur.finalizedAt) {
        best.set(line.inventoryItemId, { sessionDate: s.sessionDate, finalizedAt: s.finalizedAt, label: s.label })
      }
    }
  }

  const items = await prisma.inventoryItem.findMany({
    where: { lastCountDate: { not: null } },
    select: { id: true, itemName: true, lastCountDate: true },
  })

  let changed = 0, unchanged = 0, noSession = 0
  const byTarget = new Map<string, number>()
  for (const item of items) {
    const b = best.get(item.id)
    if (!b) { noSession++; continue }
    const cur = item.lastCountDate as Date
    if (cur.getTime() === b.sessionDate.getTime()) { unchanged++; continue }
    changed++
    const k = `${b.label} -> ${b.sessionDate.toISOString().slice(0,10)}`
    byTarget.set(k, (byTarget.get(k) ?? 0) + 1)
    if (apply) {
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { lastCountDate: b.sessionDate } })
    }
  }

  console.log(`${apply ? 'APPLIED' : 'DRY-RUN'} repair of lastCountDate`)
  console.log(`  items examined (had a lastCountDate): ${items.length}`)
  console.log(`  would change: ${changed}`)
  console.log(`  already correct: ${unchanged}`)
  console.log(`  no matching finalized session (left as-is): ${noSession}`)
  console.log(`  change breakdown (source count -> new date):`)
  for (const [k, n] of [...byTarget.entries()].sort((a,b)=>b[1]-a[1])) console.log(`    ${n.toString().padStart(4)}  ${k}`)
  if (!apply) console.log(`\n  Re-run with APPLY=1 to write.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
