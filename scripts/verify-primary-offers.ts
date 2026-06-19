// scripts/verify-primary-offers.ts
// Read-only. Asserts the primary-offer invariant across all items:
//   1. every item WITH offers has exactly one primary  (enforced for ALL items)
//   2. item headline ppb == its primary offer's computed ppb (≤0.5% tolerance)
//      — enforced only for items NOT flagged needsReview. Items the backfill
//        quarantined (suspect offer chain) are reported separately, not failed.
// Exits non-zero only if assertion 1 fails for any item, or assertion 2 fails
// for any non-needsReview item.
//
// Run: TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/verify-primary-offers.ts

import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { offerPricePerBase } from '../src/lib/supplier-offers'

async function main() {
  const itemIds = (await prisma.inventorySupplierPrice.findMany({
    select: { inventoryItemId: true },
    distinct: ['inventoryItemId'],
  })).map((r) => r.inventoryItemId)

  let badPrimaryCount = 0
  let ppbMismatch = 0
  let quarantined = 0

  for (const id of itemIds) {
    const offers = await prisma.inventorySupplierPrice.findMany({
      where: { inventoryItemId: id },
      // pricePerBaseUnit column was retired (#13) — offer ppb derives from chain.
      select: { id: true, isPrimary: true, packChain: true, pricing: true },
    })
    const primaries = offers.filter((o) => o.isPrimary)
    if (primaries.length !== 1) {
      badPrimaryCount++
      console.error(`[FAIL primary] item ${id}: ${primaries.length} primaries (expected 1)`)
      continue
    }
    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      select: { itemName: true, dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true, needsReview: true },
    })
    if (!item) continue
    // Quarantined items (suspect offer chain) are knowingly item≠offer until the
    // offer data is repaired — count them, but don't assert ppb-match.
    if (item.needsReview) { quarantined++; continue }
    const itemPpb = pricePerBaseUnit(asChainItem(item))
    const offerPpb = offerPricePerBase(primaries[0])
    const rel = offerPpb > 0 ? Math.abs(itemPpb - offerPpb) / offerPpb : (itemPpb === 0 ? 0 : 1)
    if (rel > 0.005) {
      ppbMismatch++
      console.error(`[FAIL ppb] ${item.itemName}: item ${itemPpb.toFixed(5)} vs primary offer ${offerPpb.toFixed(5)} (${(rel * 100).toFixed(1)}%)`)
    }
  }

  console.log('\n──────── verify ────────')
  console.log(`items with offers:        ${itemIds.length}`)
  console.log(`wrong primary count:      ${badPrimaryCount}`)
  console.log(`quarantined (needsReview):${quarantined}`)
  console.log(`ppb mismatch (>0.5%):     ${ppbMismatch}`)
  const ok = badPrimaryCount === 0 && ppbMismatch === 0
  console.log(ok ? '\nINVARIANT HOLDS ✓' : '\nINVARIANT VIOLATED ✗')
  if (!ok) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
