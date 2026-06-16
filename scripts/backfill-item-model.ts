// One-time backfill: legacy pricing fields → packChain/pricing/dimension/countUnit.
// Reuses formToChain (the single chain-reconstruction source) so the result
// reproduces today's pricePerBaseUnit exactly. Prints a DRY-RUN plan by default;
// pass APPLY=1 to write. Rows whose reconstructed ppb can't match the stored ppb
// (e.g. the known non-SI-baseUnit bug) are flagged needsReview.
//
// DRY RUN:  npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-item-model.ts
// APPLY:    APPLY=1 npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-item-model.ts
import { prisma } from '../src/lib/prisma'
import { formToChain } from '../src/lib/item-model-form'
import { pricePerBaseUnit } from '../src/lib/item-model'
import { getUnitConv } from '../src/lib/utils'

const APPLY = process.env.APPLY === '1'

async function main() {
  const items = await prisma.inventoryItem.findMany()
  let drift = 0
  let flagged = 0
  const driftRows: string[] = []

  for (const it of items) {
    const shape = formToChain({
      purchaseUnit: it.purchaseUnit || 'case',
      purchasePrice: Number(it.purchasePrice),
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit),
      qtyUOM: it.qtyUOM,
      innerQty: it.innerQty != null ? Number(it.innerQty) : null,
      packSize: Number(it.packSize),
      packUOM: it.packUOM,
      priceType: it.priceType === 'UOM' ? 'UOM' : 'CASE',
      countUOM: it.countUOM || 'each',
      baseUnit: it.baseUnit, // honour the already-stored baseUnit for dimension
    })

    const newPpb = pricePerBaseUnit(shape)
    // The TRUE parity contract is "recipe costs don't move". A reader computes
    // cost as convertQty(qty, unit, baseUnit) × ppb, so the stored ppb is
    // denominated per its OWN (possibly non-SI) baseUnit. Normalise it to a
    // per-SI-base figure before comparing to the chain's SI-base ppb.
    const oldPpbRaw = Number(it.pricePerBaseUnit)
    const oldPpbSI = oldPpbRaw / (getUnitConv(it.baseUnit) || 1)
    const matches = oldPpbSI === 0 || Math.abs(newPpb - oldPpbSI) <= Math.max(1e-9, oldPpbSI * 1e-4)
    if (!matches) {
      drift++
      driftRows.push(
        `  DRIFT  ${it.itemName.padEnd(34)} oldSI=${oldPpbSI.toPrecision(6)} new=${newPpb.toPrecision(6)} ` +
        `[${it.priceType} qtyUOM=${it.qtyUOM} packUOM=${it.packUOM} base=${it.baseUnit}]`,
      )
    }
    const needsReview = it.needsReview || !matches
    if (needsReview) flagged++

    if (APPLY) {
      await prisma.inventoryItem.update({
        where: { id: it.id },
        data: {
          // new chain model
          dimension: shape.dimension,
          baseUnit: shape.baseUnit,
          packChain: shape.packChain as any,
          pricing: shape.pricing as any,
          countUnit: shape.countUnit,
          needsReview,
          // keep the LEGACY spine consistent with the chain so dual-write readers
          // stay correct after baseUnit is canonicalised to SI. For the 414
          // already-SI items this is a no-op; for the 8 non-SI items it
          // normalises baseUnit→g/ml and ppb→per-SI-base (fixing the 2 underpriced).
          pricePerBaseUnit: newPpb,
        },
      })
    }
  }

  if (driftRows.length) {
    console.log(`\nReconstruction drift (${drift} rows — these would flag needsReview):`)
    driftRows.slice(0, 50).forEach((r) => console.log(r))
    if (driftRows.length > 50) console.log(`  …and ${driftRows.length - 50} more`)
  }
  console.log(
    `\n${items.length} items · ${drift} drift · ${flagged} flagged needsReview · ${APPLY ? 'APPLIED' : 'DRY RUN'}`,
  )
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
