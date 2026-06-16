// Backfill per-offer pack chains (the design's ItemOffer semantics) onto every
// existing InventorySupplierPrice row. Each offer gets its OWN packChain +
// pricing reconstructed from its own legacy fields (packQty/packSize/packUOM +
// lastPrice), denominated against the PARENT item's baseUnit/dimension, so the
// offer's pricePerBaseUnit derives on read and matches the stored column.
//
// DRY-RUN by default — prints what WOULD change and drift stats. Set APPLY=1 to
// write packChain/pricing (no legacy columns touched). Json writes go through
// the ORM (prisma.inventorySupplierPrice.update).
//
// Run (dry):   npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-offer-chains.ts
// Run (apply): APPLY=1 npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/backfill-offer-chains.ts
import { prisma } from '../src/lib/prisma'
import { formToChain } from '../src/lib/item-model-form'
import { pricePerBaseUnit } from '../src/lib/item-model'
import { getUnitConv, isMeasuredUnit } from '../src/lib/utils'

const APPLY = process.env.APPLY === '1'

async function main() {
  const offers = await prisma.inventorySupplierPrice.findMany({
    include: {
      inventoryItem: { select: { baseUnit: true, dimension: true, pricing: true } },
    },
  })

  let checked = 0
  let drift = 0
  let written = 0
  let skipped = 0
  const driftExamples: string[] = []

  for (const o of offers) {
    const parent = o.inventoryItem
    if (!parent) { skipped++; continue }

    const baseUnit = parent.baseUnit || 'each'
    const lastPrice = Number(o.lastPrice)
    const packUOM = o.packUOM ?? 'each'

    // PACK vs RATE: default PACK. Use RATE only when the PARENT item is RATE.
    // (Secondary signal: the offer's packUOM is measured AND the stored ppb
    //  ≈ lastPrice/conv(packUOM) — i.e. the offer reads as a per-weight rate.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parentPricing = parent.pricing as any
    const parentIsRate = parentPricing && parentPricing.mode === 'RATE'
    let isRate = !!parentIsRate
    if (!isRate && isMeasuredUnit(packUOM)) {
      const conv = getUnitConv(packUOM)
      const storedPpb = Number(o.pricePerBaseUnit)
      if (conv > 0 && storedPpb > 0) {
        const rateGuess = lastPrice / conv
        if (Math.abs(rateGuess - storedPpb) <= storedPpb * 0.01) isRate = true
      }
    }

    const chain = formToChain({
      purchaseUnit:       'case',
      purchasePrice:      lastPrice,
      qtyPerPurchaseUnit: Number(o.packQty ?? 1) || 1,
      packSize:           Number(o.packSize ?? 1) || 1,
      packUOM,
      qtyUOM:             'each',
      innerQty:           null,
      countUOM:           'each',
      priceType:          isRate ? 'UOM' : 'CASE',
      baseUnit,
    })

    // VERIFY: chain ppb vs stored offer.pricePerBaseUnit. The stored column is
    // already in SI base ($/g, $/ml, $/each), same as the chain computes — but
    // normalize by the parent baseUnit conv when it's a non-SI unit (e.g. kg).
    const chainPpb = pricePerBaseUnit({
      dimension: chain.dimension,
      baseUnit: chain.baseUnit,
      packChain: chain.packChain,
      pricing: chain.pricing,
    })
    const storedRaw = Number(o.pricePerBaseUnit)
    const conv = getUnitConv(baseUnit)
    const storedPpb = conv > 0 ? storedRaw / conv : storedRaw

    checked++
    const within1 = storedPpb > 0
      ? Math.abs(chainPpb - storedPpb) <= storedPpb * 0.01
      : chainPpb === 0
    if (!within1) {
      drift++
      if (driftExamples.length < 12) {
        driftExamples.push(
          `DRIFT ${o.supplierName} [${o.inventoryItemId}] mode=${isRate ? 'RATE' : 'PACK'} ` +
          `pack=${o.packQty}×${o.packSize}${packUOM} last=${lastPrice} ` +
          `chain=${chainPpb.toPrecision(6)} stored=${storedPpb.toPrecision(6)} (base ${baseUnit})`
        )
      }
    }

    if (APPLY) {
      await prisma.inventorySupplierPrice.update({
        where: { id: o.id },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          packChain: chain.packChain as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pricing: chain.pricing as any,
        },
      })
      written++
    }
  }

  console.log('')
  console.log(`Offers total:   ${offers.length}`)
  console.log(`Checked:        ${checked}`)
  console.log(`Skipped:        ${skipped} (no parent item)`)
  console.log(`Within 1%:      ${checked - drift}`)
  console.log(`Drift (>1%):    ${drift}`)
  if (driftExamples.length) {
    console.log('\nDrift examples:')
    for (const d of driftExamples) console.log('  ' + d)
  }
  console.log(APPLY ? `\nAPPLIED — wrote chain to ${written} offers.` : '\nDRY-RUN — no rows written. Set APPLY=1 to write.')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
