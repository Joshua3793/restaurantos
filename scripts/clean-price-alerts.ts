// Clean up corrupted/duplicate PriceAlert rows left by the buggy approvals.
// Deletes unacknowledged alerts whose stored newPrice no longer matches the
// (repaired) inventory item's current purchasePrice — those are stale fossils —
// and dedupes identical (item, prev, new) alerts. Dry by default; APPLY=1.
import { prisma } from '../src/lib/prisma'
const APPLY = process.env.APPLY === '1'
async function main() {
  const alerts = await prisma.priceAlert.findMany({
    where: { acknowledged: false },
    include: { inventoryItem: { select: { itemName: true, purchasePrice: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const toDelete: string[] = []
  const seen = new Set<string>()
  for (const a of alerts) {
    const np = Number(a.newPrice), cur = Number(a.inventoryItem?.purchasePrice ?? 0)
    const stale = cur > 0 && Math.abs(np - cur) / cur > 0.05
    const key = `${a.inventoryItemId}|${np.toFixed(2)}|${Number(a.previousPrice).toFixed(2)}`
    const dup = seen.has(key)
    seen.add(key)
    if (stale) { toDelete.push(a.id); console.log(`DELETE stale  ${a.inventoryItem?.itemName} new $${np.toFixed(2)} (item now $${cur.toFixed(2)})`) }
    else if (dup) { toDelete.push(a.id); console.log(`DELETE dup    ${a.inventoryItem?.itemName} new $${np.toFixed(2)}`) }
    else { console.log(`KEEP          ${a.inventoryItem?.itemName} new $${np.toFixed(2)} (${a.changePct}%)`) }
  }
  console.log(`\n${toDelete.length} to delete, ${alerts.length - toDelete.length} kept${APPLY ? ' (APPLYING)' : ' (DRY)'}`)
  if (APPLY && toDelete.length) {
    await prisma.priceAlert.deleteMany({ where: { id: { in: toDelete } } })
    console.log('Deleted.')
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})
