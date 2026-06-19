// scripts/backfill-primary-offers.ts
// Establishes the primary-offer invariant on existing data. Idempotent.
//
// For each item WITH offers: ensure exactly one primary (most-recently-updated
// wins where none is set). Then, UNLESS the primary offer's derived price
// diverges wildly from the item's current price, sync the item spine from it.
//
// Divergence guard — a reconciliation backfill must NEVER silently overwrite a
// sane price with a wildly different one. The historical offer `packChain` data
// is partly corrupt (degenerate / dimension-mismatched chains), so any item
// whose offer-derived ppb is >DIVERGENCE_FACTOR× off the current ppb is
// QUARANTINED: flagged `needsReview=true` and left at its current price for a
// human (or the offer-data repair) to resolve. The clean majority still syncs.
//
// Dry:   TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts
// Apply: APPLY=1 TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-primary-offers.ts
// Tune:  DIVERGENCE_FACTOR=2 APPLY=1 … (default 1.5)

import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'
import { ensurePrimary, syncPrimaryOfferToItem } from '../src/lib/primary-offer'

const APPLY = process.env.APPLY === '1'
const DIVERGENCE_FACTOR = Number(process.env.DIVERGENCE_FACTOR ?? '1.5')
const money = (n: number) => `$${n.toFixed(2)}`

async function main() {
  const itemIds = (await prisma.inventorySupplierPrice.findMany({
    select: { inventoryItemId: true },
    distinct: ['inventoryItemId'],
  })).map((r) => r.inventoryItemId)

  let synced = 0
  let quarantined = 0
  let valueBefore = 0
  let valueAfter = 0

  for (const id of itemIds) {
    const before = await prisma.inventoryItem.findUnique({
      where: { id },
      select: { itemName: true, dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true, stockOnHand: true },
    })
    if (!before) continue
    const oldPpb = pricePerBaseUnit(asChainItem(before))
    const stock = Number(before.stockOnHand || 0)

    // The effective primary offer (mirrors ensurePrimary's most-recent tiebreak),
    // and the price the item WOULD take from it.
    const primary = await prisma.inventorySupplierPrice.findFirst({
      where: { inventoryItemId: id, isPrimary: true },
      orderBy: { lastUpdated: 'desc' },
      select: { packChain: true, pricing: true },
    })
    const eff = primary ?? await prisma.inventorySupplierPrice.findFirst({
      where: { inventoryItemId: id },
      orderBy: { lastUpdated: 'desc' },
      select: { packChain: true, pricing: true },
    })
    let newPpb = oldPpb
    if (eff && Array.isArray(eff.packChain) && eff.pricing) {
      const cand = pricePerBaseUnit({
        dimension: before.dimension as 'MASS' | 'VOLUME' | 'COUNT',
        baseUnit: before.baseUnit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        packChain: eff.packChain as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pricing: eff.pricing as any,
      })
      if (Number.isFinite(cand) && cand > 0) newPpb = cand
    }

    const ratio = oldPpb > 0 && newPpb > 0 ? Math.max(newPpb / oldPpb, oldPpb / newPpb) : Infinity
    const divergent = oldPpb > 0 && ratio > DIVERGENCE_FACTOR

    // Promoting/deduping the primary flag is always safe (no price effect).
    if (APPLY) await ensurePrimary(id)

    if (divergent) {
      quarantined++
      valueBefore += stock * oldPpb
      valueAfter += stock * oldPpb // price unchanged — we did NOT sync
      console.log(`[SKIP-REVIEW] ${before.itemName.padEnd(32)} ppb ${oldPpb.toFixed(5)} → ${newPpb.toFixed(5)}  (×${ratio.toFixed(1)} — offer suspect, flagged needsReview)`)
      if (APPLY) await prisma.inventoryItem.update({ where: { id }, data: { needsReview: true } })
      continue
    }

    // Clean: adopt the primary offer's price/format.
    valueBefore += stock * oldPpb
    valueAfter += stock * newPpb
    if (Math.abs(newPpb - oldPpb) > 1e-9) {
      synced++
      console.log(`[${APPLY ? 'SYNCED' : 'would sync'}] ${before.itemName.padEnd(32)} ppb ${oldPpb.toFixed(5)} → ${newPpb.toFixed(5)}`)
    }
    if (APPLY) await syncPrimaryOfferToItem(id)
  }

  console.log('\n──────── summary ────────')
  console.log(`items with offers:      ${itemIds.length}`)
  console.log(`divergence factor:      ${DIVERGENCE_FACTOR}×`)
  console.log(`clean spine ppb synced: ${synced}`)
  console.log(`quarantined (review):   ${quarantined}`)
  console.log(`valuation (clean only): ${money(valueBefore)} → ${money(valueAfter)}  (Δ ${money(valueAfter - valueBefore)})`)
  console.log(APPLY ? '\nAPPLIED.' : '\nDRY RUN — pass APPLY=1 to write.')
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
