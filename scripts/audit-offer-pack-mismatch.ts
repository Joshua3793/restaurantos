/**
 * Cross-check every item's pack chain against its PRIMARY supplier offer's own
 * stated purchase format.
 *
 * `InventorySupplierPrice.{packQty,packSize,packUOM}` is the human purchase
 * format the supplier quotes ("1 × 12 lb", "6 × 2.841 L"). `InventoryItem.
 * packChain` is the normalized collapse of that format into base units. The two
 * are written by the same invoice-approve path, so they must agree — when they
 * do not, one of them is wrong and every cost derived from the chain is off by
 * exactly their ratio.
 *
 * This check uses NO market judgement: it is the data contradicting itself.
 *
 * READ-ONLY. Run:
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/audit-offer-pack-mismatch.ts [outDir]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, basePerPurchase, pricePerBaseUnit } from '../src/lib/item-model'
import { canonicalUom, unitKind, UNIT_FACTORS } from '../src/lib/uom'

const TOL = 0.02 // 2% — absorbs rounding in stored pack sizes

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: { supplierPrices: true },
  })

  type Row = {
    id: string; name: string; category: string
    supplier: string; offerFormat: string; offerPrice: number
    chain: unknown; chainBaseTotal: number; offerBaseTotal: number
    factor: number                 // chainBaseTotal / offerBaseTotal
    pricingMode: string
    currentPpb: number; impliedPpb: number | null
    currentPerDisplay: string; impliedPerDisplay: string | null
    /** PACK pricing divides by the chain total, so a wrong total is a wrong
     *  cost. RATE pricing sets $/base directly from the rate — there the wrong
     *  total corrupts pack/stock conversions only, not the unit cost. */
    impact: 'COST_AND_STOCK' | 'STOCK_ONLY'
    direction: 'OVER-COSTED' | 'UNDER-COSTED' | 'PACK_TOTAL_WRONG'
  }

  const rows: Row[] = []
  let checked = 0
  const skipped: string[] = []

  for (const it of items) {
    const offer = it.supplierPrices.find((o) => o.isPrimary) ?? null
    if (!offer) continue
    if (offer.packQty == null || offer.packSize == null || !offer.packUOM) continue

    const uom = canonicalUom(offer.packUOM)
    if (unitKind(uom) !== 'measurement') {
      // 'each'/'dozen' resolve via UNIT_FACTORS; containers do not convert.
      skipped.push(`${it.itemName} (offer packUOM '${offer.packUOM}' is not a measurement unit)`)
      continue
    }
    const factorToBase = UNIT_FACTORS[uom].toBase

    const ci = asChainItem(it)
    // Only compare when the offer's UOM shares the item's dimension — a count
    // offer against a mass item needs the eachMeasure bridge, out of scope here.
    const offerDim = UNIT_FACTORS[uom].dim
    const itemDim = ci.dimension === 'MASS' ? 'weight' : ci.dimension === 'VOLUME' ? 'volume' : 'count'
    if (offerDim !== itemDim) {
      skipped.push(`${it.itemName} (offer is ${offerDim}, item is ${itemDim} — needs a bridge)`)
      continue
    }

    const offerBaseTotal = Number(offer.packQty) * Number(offer.packSize) * factorToBase
    const chainBaseTotal = basePerPurchase(ci.packChain)
    if (!(offerBaseTotal > 0) || !(chainBaseTotal > 0)) continue

    checked++
    const factor = chainBaseTotal / offerBaseTotal
    if (Math.abs(factor - 1) <= TOL) continue

    const currentPpb = pricePerBaseUnit(ci)
    const dispFactor = ci.dimension === 'COUNT' ? 1 : 1000
    const dispUnit = ci.dimension === 'MASS' ? 'kg' : ci.dimension === 'VOLUME' ? 'L' : 'each'
    const mode = (ci.pricing as { mode?: string })?.mode ?? 'PACK'
    const isPack = mode === 'PACK'

    // Under RATE pricing `lastPrice` is a $/unit rate, not a pack price — so it
    // must not be divided by the pack total to imply a corrected cost.
    const impliedPpb = isPack ? Number(offer.lastPrice) / offerBaseTotal : null

    rows.push({
      id: it.id, name: it.itemName, category: it.category,
      supplier: offer.supplierName,
      offerFormat: `${offer.packQty} × ${offer.packSize} ${offer.packUOM}`,
      offerPrice: Number(offer.lastPrice),
      chain: ci.packChain, chainBaseTotal, offerBaseTotal, factor,
      pricingMode: mode,
      currentPpb, impliedPpb,
      currentPerDisplay: `$${(currentPpb * dispFactor).toFixed(2)}/${dispUnit}`,
      impliedPerDisplay: impliedPpb != null ? `$${(impliedPpb * dispFactor).toFixed(2)}/${dispUnit}` : null,
      impact: isPack ? 'COST_AND_STOCK' : 'STOCK_ONLY',
      direction: !isPack ? 'PACK_TOTAL_WRONG' : factor < 1 ? 'OVER-COSTED' : 'UNDER-COSTED',
    })
  }

  rows.sort((a, b) => Math.max(b.factor, 1 / b.factor) - Math.max(a.factor, 1 / a.factor))

  const costWrong = rows.filter((r) => r.impact === 'COST_AND_STOCK')
  const stockOnly = rows.filter((r) => r.impact === 'STOCK_ONLY')

  console.log(`Items with a primary offer carrying a comparable pack format: ${checked}`)
  console.log(`Chain disagrees with the offer's own format: ${rows.length}`)
  console.log(`  → PACK-priced (the $/unit cost is wrong by that factor): ${costWrong.length}`)
  console.log(`  → RATE-priced (cost is set by the rate; counts/stock wrong): ${stockOnly.length}\n`)

  console.log('══ PACK-priced — cost is wrong ══\n')
  for (const r of costWrong) {
    const mult = r.factor < 1 ? `${(1 / r.factor).toFixed(1)}× TOO HIGH` : `${r.factor.toFixed(1)}× TOO LOW`
    console.log(
      `${r.name.slice(0, 34).padEnd(35)} ${r.supplier.padEnd(13)} offer "${r.offerFormat}" @ $${r.offerPrice}\n` +
        `${''.padEnd(35)} chain total ${r.chainBaseTotal} vs offer total ${r.offerBaseTotal.toFixed(2)} → cost is ${mult}\n` +
        `${''.padEnd(35)} now ${r.currentPerDisplay}  →  should be ${r.impliedPerDisplay}\n`,
    )
  }

  console.log('\n══ RATE-priced — $/unit is correct, pack total is not (counts & stock only) ══\n')
  for (const r of stockOnly) {
    console.log(
      `${r.name.slice(0, 34).padEnd(35)} ${r.supplier.padEnd(13)} offer "${r.offerFormat}" | rate holds at ${r.currentPerDisplay}\n` +
        `${''.padEnd(35)} chain total ${r.chainBaseTotal} vs offer total ${r.offerBaseTotal.toFixed(2)} (${r.factor.toFixed(2)}×)\n`,
    )
  }

  if (skipped.length) {
    console.log(`\nNot comparable (${skipped.length}):`)
    for (const s of skipped) console.log(`  - ${s}`)
  }

  const out = path.resolve(process.cwd(), process.argv[2] || 'scratch')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'offer-pack-mismatch.json'), JSON.stringify(rows, null, 2))
  console.log(`\nWrote ${path.join(out, 'offer-pack-mismatch.json')}`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
