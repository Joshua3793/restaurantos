import { prisma } from '../../../src/lib/prisma'
import { UNIT_FACTORS, canonicalUom, convertQty } from '../../../src/lib/uom'
import { asChainItem, pricePerBaseUnit, PRICING_SELECT, dimensionOf } from '../../../src/lib/item-model'
const isM = (u?: string | null) => { if (!u) return false; const f = UNIT_FACTORS[canonicalUom(u)]; return !!f && f.dim !== 'count' }
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
;(async () => {
  // weight-billed lines (rate in a weight/volume unit, reconciling) matched to COUNT items
  const ls = await prisma.invoiceScanItem.findMany({
    where: { approved: true, splitToSessionId: null, matchedItemId: { not: null }, session: { status: 'APPROVED' }, matchedItem: { dimension: 'COUNT' } },
    select: { rawDescription: true, rawQty: true, rawUnit: true, rawUnitPrice: true, rawLineTotal: true, totalQty: true, totalQtyUOM: true, rate: true, rateUOM: true, newPrice: true, action: true,
      session: { select: { supplierName: true, supplierId: true, purchaseDate: true } },
      matchedItem: { select: { id: true, itemName: true, ...PRICING_SELECT, supplierPrices: { select: { supplierName: true, supplierId: true, isPrimary: true, lastPrice: true, packChain: true, pricing: true } }, _count: { select: { recipeIngredients: true } } } } },
  })
  const seen = new Map<string, { item: any; lines: any[] }>()
  for (const l of ls) {
    const rate = n(l.rate) || n(l.rawUnitPrice), billed = n(l.totalQty), total = n(l.rawLineTotal)
    const byWeight = isM(l.totalQtyUOM) && billed > 0 && total > 0 && Math.abs(rate * billed - total) <= Math.max(0.02, total * 0.02)
    const shipped = isM(l.rawUnit) && n(l.rawQty) > 0
    if (!byWeight && !shipped) continue
    const k = l.matchedItem!.id
    if (!seen.has(k)) seen.set(k, { item: l.matchedItem, lines: [] })
    seen.get(k)!.lines.push(l)
  }
  console.log('COUNT items with weight-billed lines:', seen.size, '\n')
  for (const { item, lines } of seen.values()) {
    const ci = asChainItem(item); const ppb = pricePerBaseUnit(ci)
    const em = ci.eachMeasure
    const gPerEach = em ? convertQty(em.qty, em.unit, dimensionOf(em.unit) === 'VOLUME' ? 'ml' : 'g') : null
    console.log(`=== ${item.itemName} · base ${item.baseUnit} · chain ${JSON.stringify(item.packChain)} · pricing ${JSON.stringify(item.pricing)} → $${ppb.toFixed(4)}/each · each-measure ${em ? em.qty + ' ' + em.unit : 'NONE'} · used in ${item._count.recipeIngredients} recipe line(s)`)
    for (const o of item.supplierPrices) console.log(`    offer ${o.supplierName}${o.isPrimary ? ' *PRIMARY*' : ''}: lastPrice ${o.lastPrice} chain ${JSON.stringify(o.packChain)} pricing ${JSON.stringify(o.pricing)}`)
    for (const l of lines) {
      const rate = n(l.rate) || n(l.rawUnitPrice)
      const rateUnit = l.rateUOM ?? l.totalQtyUOM ?? l.rawUnit
      const right = gPerEach && isM(rateUnit) ? rate / convertQty(1, canonicalUom(rateUnit), dimensionOf(canonicalUom(rateUnit)) === 'VOLUME' ? 'ml' : 'g') * gPerEach : null
      console.log(`    line ${l.session.purchaseDate?.toISOString().slice(0, 10)} ${String(l.session.supplierName).slice(0, 16)} · ${l.rawQty} ${l.rawUnit} · rate ${l.rate}/${l.rateUOM} · unitPrice ${l.rawUnitPrice} · total ${l.rawLineTotal} · action ${l.action} → TRUE $/each = ${right ? '$' + right.toFixed(3) : 'n/a (no bridge)'}`)
    }
  }
  await prisma.$disconnect()
})()
