/**
 * READ-ONLY. Dump $/base for every item and every supplier offer, so a change to
 * the price formula can be PROVEN to move no live number.
 *   npx tsx scripts/audit-ppb-snapshot.ts > /tmp/ppb-<label>.json
 * Run it on main and on the branch, then `diff` the two files.
 */
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const items = await prisma.inventoryItem.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, itemName: true, ...PRICING_SELECT, supplierPrices: { orderBy: { id: 'asc' }, select: { id: true, supplierName: true, packChain: true, pricing: true } } },
  })
  const out = items.map(i => ({
    id: i.id, item: i.itemName, ppb: +pricePerBaseUnit(asChainItem(i)).toFixed(10),
    offers: i.supplierPrices.map(o => ({ id: o.id, supplier: o.supplierName, ppb: +offerPricePerBase(o, i).toFixed(10) })),
  }))
  process.stdout.write(JSON.stringify(out, null, 1) + '\n')
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
