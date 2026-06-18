/**
 * Safety gate for dropping InventorySupplierPrice.pricePerBaseUnit.
 * After the chain-only refactor + backfill, the stored column is unused and
 * offerPricePerBase() derives from packChain+pricing. This asserts no offer is
 * left without a usable chain (which would silently price at 0 once the
 * stored-column fallback is removed). Read-only. Run BEFORE the column drop.
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-ppb-parity.ts
 */
import { prisma } from '../src/lib/prisma'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const offers = await prisma.inventorySupplierPrice.findMany()
  let noChain = 0, badPpb = 0
  for (const o of offers) {
    const chain = Array.isArray(o.packChain) ? o.packChain : []
    if (!chain.length || !o.pricing) {
      noChain++
      console.log(`NO-CHAIN  ${o.supplierName} / ${o.inventoryItemId}`)
      continue
    }
    const ppb = offerPricePerBase(o)
    if (!Number.isFinite(ppb) || ppb <= 0) {
      badPpb++
      console.log(`BAD-PPB   ${o.supplierName} / ${o.inventoryItemId}  ppb=${ppb}`)
    }
  }
  console.log(`\n${offers.length} offers · ${noChain} without chain · ${badPpb} with non-positive ppb`)
  if (noChain > 0 || badPpb > 0) { console.error('NOT SAFE TO DROP — every offer must carry a valid chain first.'); process.exit(1) }
  console.log('SAFE TO DROP pricePerBaseUnit.')
  await prisma.$disconnect()
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
