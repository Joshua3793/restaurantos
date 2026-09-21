/**
 * READ-ONLY. How would a "line-first" receiving rule differ from what is frozen?
 *
 * Line-first: when the line's quantity carries a WEIGHT or VOLUME unit, that IS
 * what was received — convert it to the item's base unit (through the item's own
 * each-measure / density bridge when dimensions differ) and ignore item/offer
 * pricing mode and every pack chain. Anything else → the current rule.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../../../src/lib/prisma'
import { PRICING_SELECT, asChainItem, dimensionOf, type ChainItem } from '../../../src/lib/item-model'
import { UNIT_FACTORS, canonicalUom, convertQty, convertQtyBridged } from '../../../src/lib/uom'
import { lineReceivedBaseUnits } from '../../../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../../../src/lib/invoice/line-format'

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** qty+unit → item base, or null when the unit is not a measure or cannot be bridged. */
function measured(qty: number, unit: string | null | undefined, item: ChainItem): { base: number; bridged: boolean } | null {
  if (!unit || !(qty > 0)) return null
  const u = canonicalUom(unit)
  const f = UNIT_FACTORS[u]
  if (!f || f.dim === 'count') return null // containers + each are NOT measures
  const from = dimensionOf(u), to = dimensionOf(item.baseUnit)
  if (from === to) return { base: convertQty(qty, u, item.baseUnit), bridged: false }
  const each = item.eachMeasure, d = item.densityGPerMl
  const viaDensity = from !== 'COUNT' && to !== 'COUNT' && !!d && d > 0
  const viaEach = to === 'COUNT' && !!each && each.qty > 0 && dimensionOf(each.unit) === from
  if (!viaDensity && !viaEach) return null
  return { base: convertQtyBridged(qty, u, item.baseUnit, each, d), bridged: true }
}

async function main() {
  const lines = await prisma.invoiceScanItem.findMany({
    where: { approved: true, matchedItemId: { not: null }, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] }, session: { status: 'APPROVED' } },
    select: {
      id: true, rawDescription: true, receivedQtyBase: true, splitToSessionId: true, pricingMode: true, isCatchweight: true,
      rawQty: true, rawUnit: true, rawLineTotal: true, totalQty: true, totalQtyUOM: true, rateUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierId: true, supplierName: true, invoiceNumber: true, purchaseDate: true, supplier: { select: { name: true } } } },
      matchedItem: { select: { itemName: true, ...PRICING_SELECT, supplierPrices: { select: { supplierId: true, supplierName: true, packChain: true, pricing: true } } } },
    },
  })

  const out: Record<string, unknown>[] = []
  let applicable = 0, unbridgeable = 0
  for (const l of lines) {
    if (!l.matchedItem) continue
    const item = asChainItem(l.matchedItem)
    const input = {
      rawQty: l.rawQty?.toString() ?? null, rawUnit: l.rawUnit, totalQty: l.totalQty?.toString() ?? null,
      totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM, invoicePackQty: l.invoicePackQty?.toString() ?? null,
      invoicePackSize: l.invoicePackSize?.toString() ?? null, invoicePackUOM: l.invoicePackUOM,
    }
    const current = l.receivedQtyBase != null ? num(l.receivedQtyBase)
      : lineReceivedBaseUnits(input, resolveLineFormat(item, pickOffer(l.matchedItem.supplierPrices, { supplierId: l.session.supplierId, supplierName: l.session.supplierName, canonicalName: l.session.supplier?.name ?? null })))

    // billed total first (it is the measured quantity), then the shipped qty's own unit
    const hasMeasureUnit = [l.totalQtyUOM, l.rawUnit].some(u => { const f = u ? UNIT_FACTORS[canonicalUom(u)] : null; return !!f && f.dim !== 'count' })
    const m = measured(num(l.totalQty), l.totalQtyUOM, item) ?? measured(num(l.rawQty), l.rawUnit, item)
    if (!m) { if (hasMeasureUnit && (num(l.totalQty) > 0 || num(l.rawQty) > 0)) unbridgeable++; continue }
    applicable++
    if (Math.abs(m.base - current) <= Math.max(0.001, current * 0.01)) continue

    const hasPack = num(l.invoicePackQty) > 0 && num(l.invoicePackSize) > 0
    out.push({
      item: l.matchedItem.itemName, base: item.baseUnit, itemMode: item.pricing.mode,
      supplier: l.session.supplierName, invoice: l.session.invoiceNumber, date: l.session.purchaseDate?.toISOString().slice(0, 10),
      line: l.rawDescription, qty: `${l.rawQty ?? '∅'} ${l.rawUnit ?? '∅'}`, billed: `${l.totalQty ?? '∅'} ${l.totalQtyUOM ?? '∅'}`,
      pack: hasPack ? `${l.invoicePackQty}x${l.invoicePackSize}${l.invoicePackUOM}` : null,
      ocrMode: l.pricingMode, catchweight: l.isCatchweight, clonedParent: !!l.splitToSessionId, bridged: m.bridged,
      total$: num(l.rawLineTotal), current, lineFirst: +m.base.toFixed(2), ratio: current > 0 ? +(m.base / current).toFixed(3) : null,
      // The quirk to fear: a printed pack whose total disagrees with the "measured" qty.
      suspectQuirk: hasPack && !l.isCatchweight,
    })
  }
  const file = 'docs/audits/2026-09-20-line-first-receiving/line-first-diff.json'
  writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`${lines.length} approved lines · ${applicable} carry a usable weight/volume quantity · ${unbridgeable} carry one but cannot be converted (COUNT item, no each-measure) · ${out.length} would CHANGE under line-first`)
  console.log('diff →', file)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
