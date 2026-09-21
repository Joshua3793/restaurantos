import { prisma } from '../../../src/lib/prisma'
import { PRICING_SELECT, asChainItem, eachMeasureOf, pricePerBaseUnit, ratePerBase } from '../../../src/lib/item-model'
import { lineReceived } from '../../../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../../../src/lib/invoice/line-format'
import { pricingBasisFor } from '../../../src/lib/invoice/approve-format'
import { derivePricingMode } from '../../../src/lib/invoice/predicates'
const s = (v: unknown) => (v == null ? null : String(v)); const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
;(async () => {
  const ls = await prisma.invoiceScanItem.findMany({
    where: { approved: true, splitToSessionId: null, matchedItemId: { not: null }, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] }, session: { status: 'APPROVED', parentSessionId: null } },
    select: { rawDescription: true, pricingMode: true, qtyOrdered: true, rawQty: true, rawUnit: true, rawUnitPrice: true, rawLineTotal: true, totalQty: true, totalQtyUOM: true, rate: true, rateUOM: true, invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierId: true, supplierName: true, purchaseDate: true, supplier: { select: { name: true } } } },
      matchedItem: { select: { itemName: true, ...PRICING_SELECT, supplierPrices: { select: { supplierId: true, supplierName: true, isPrimary: true, packChain: true, pricing: true } }, _count: { select: { recipeIngredients: true } } } } },
  })
  const groups = new Map<string, { n: number; primary: boolean; recipes: number; ex: string }>()
  let flipped = 0
  for (const l of ls) {
    const item = asChainItem(l.matchedItem!)
    const ref = { supplierId: l.session.supplierId, supplierName: l.session.supplierName, canonicalName: l.session.supplier?.name ?? null }
    const offer = pickOffer(l.matchedItem!.supplierPrices, ref)
    const speaks = resolveLineFormat(item, offer)
    const got = lineReceived({ rawQty: s(l.rawQty), rawUnit: l.rawUnit, totalQty: s(l.totalQty), totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM, rate: s(l.rate), rawUnitPrice: s(l.rawUnitPrice), rawLineTotal: s(l.rawLineTotal), invoicePackQty: s(l.invoicePackQty), invoicePackSize: s(l.invoicePackSize), invoicePackUOM: l.invoicePackUOM }, speaks)
    const bridge = !!eachMeasureOf(l.matchedItem!)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ocrPW = derivePricingMode(l as any) === 'per_weight'
    const oldBasis = ocrPW && !bridge ? 'WEIGHT' : 'CASE'
    const newBasis = pricingBasisFor({ via: got.via, ocrPerWeight: ocrPW, itemHasEachMeasure: bridge })
    if (oldBasis === newBasis) continue
    flipped++
    const rate = n(l.rate) || n(l.rawUnitPrice); const unit = l.rateUOM ?? l.totalQtyUOM ?? l.rawUnit ?? ''
    const newPpb = ratePerBase(rate, unit, item); const total = n(l.rawLineTotal)
    const k = `${l.matchedItem!.itemName} | ${l.session.supplier?.name ?? l.session.supplierName}`
    const g = groups.get(k) ?? { n: 0, primary: !!offer?.isPrimary, recipes: l.matchedItem!._count.recipeIngredients, ex: '' }
    g.n++; g.ex = `${l.rawQty} ${l.rawUnit} · billed ${l.totalQty ?? '-'}${l.totalQtyUOM ?? ''} · rate ${l.rate ?? '-'}/${l.rateUOM ?? '-'} · unitPrice ${l.rawUnitPrice} · total ${l.rawLineTotal} · ocr ${l.pricingMode} · via ${got.via} · ${oldBasis}→${newBasis} · item now $${pricePerBaseUnit(item).toPrecision(4)}/${item.baseUnit} · by-weight $${newPpb.toPrecision(4)}/${item.baseUnit} · qty×price=${(got.base * newPpb).toFixed(2)} vs total ${total.toFixed(2)}`
    groups.set(k, g)
  }
  console.log(`${ls.length} approved lines · ${flipped} would switch pricing basis under the new rule\n`)
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) console.log(`${g.primary ? 'PRIMARY ' : '        '}x${String(g.n).padStart(2)} · ${g.recipes} recipe line(s) · ${k}\n           ${g.ex}`)
  await prisma.$disconnect()
})()
