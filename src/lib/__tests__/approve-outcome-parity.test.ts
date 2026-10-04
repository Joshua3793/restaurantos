// Parity: decideLinePrice must write exactly what the approve route's inline
// decision wrote at 409b1295 for every line shape the route has been fixed for.
// The expected numbers are LITERALS snapshotted by running that inline code
// (copied verbatim) over these same lines — not recomputed through the new code.
import { describe, it, expect } from 'vitest'
import { decideLinePrice, type ApproveLineInput, type ApproveItemInput } from '@/lib/invoice/approve-outcome'
import type { OfferFormat } from '@/lib/invoice/line-format'
import type { Pricing } from '@/lib/item-model'

const L = (over: Partial<ApproveLineInput>): ApproveLineInput => ({
  rawQty: null, rawUnit: null, rawUnitPrice: null, rawLineTotal: null, newPrice: '1',
  totalQty: null, totalQtyUOM: null, rate: null, rateUOM: null, pricingMode: null,
  qtyOrdered: null, invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
  supplierItemCode: null, rawDescription: 'LINE', action: 'UPDATE_PRICE', matchedItemId: 'item', newItemData: null,
  ...over,
})
const I = (over: Partial<ApproveItemInput>): ApproveItemInput => ({
  id: 'item', itemName: 'Item', dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  ...over,
})
// Eggplant: 24 each per case, one each = 181.4368 g (0.4 lb).
const eggplant = I({ itemName: 'Eggplant', dimension: 'COUNT', baseUnit: 'each', countUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 }, eachMeasureQty: '181.4368', eachMeasureUnit: 'g' })

type Expected =
  | { newPricing: Pricing; newPricePerBase: number; spineNewPpb: number | null; frozen: number; density: number }
  | { skipped: 'PACK_DISAGREES' }

const CASES: Array<{ name: string; line: ApproveLineInput; item: ApproveItemInput; lineOffer: OfferFormat | null; itemOffers: number; supplierId: string | null; expected: Expected }> = [
  { name: 'Butter 2 CS @ $172.79 with a stray 2.86 kg (and an inflated stored newPrice)', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Butter', countUnit: 'case', packChain: [{ unit: 'case', per: 25 }, { unit: 'each', per: 454 }], pricing: { mode: 'PACK', purchasePrice: 170 } }),
    line: L({ rawQty: '2', rawUnit: 'CS', rawUnitPrice: '172.79', rawLineTotal: '345.58', totalQty: '2.86', totalQtyUOM: 'kg', newPrice: '4319.75', pricingMode: 'per_case', invoicePackQty: '25', invoicePackSize: '454', invoicePackUOM: 'g' }),
    expected: { newPricing: { mode: 'PACK', purchasePrice: 172.79 }, newPricePerBase: 0.015223788546255506, spineNewPpb: 0.015223788546255506, frozen: 22700, density: 0 } },
  { name: 'Sausage billed 14.6 kg @ $15.95/kg', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Sausage', countUnit: 'kg', packChain: [{ unit: 'case', per: 7000 }], pricing: { mode: 'PACK', purchasePrice: 60 } }),
    line: L({ rawQty: '2', rawUnit: 'CS', rawUnitPrice: '116.44', rawLineTotal: '232.87', totalQty: '14.6', totalQtyUOM: 'kg', rate: '15.95', rateUOM: 'kg', pricingMode: 'per_weight', invoicePackQty: '1', invoicePackSize: '7', invoicePackUOM: 'kg' }),
    expected: { newPricing: { mode: 'RATE', rate: 15.95, rateUnit: 'kg' }, newPricePerBase: 0.01595, spineNewPpb: null, frozen: 14600, density: 0 } },
  { name: 'Eggplant 12 lb @ $3.49 on a bridged each-item', supplierId: 'sup', itemOffers: 0, lineOffer: null, item: eggplant,
    line: L({ rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', rawUnitPrice: '3.49', rawLineTotal: '41.88', pricingMode: 'per_weight' }),
    expected: { newPricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }, newPricePerBase: 1.3960000000000001, spineNewPpb: null, frozen: 29.999999999999996, density: 0 } },
  { name: 'Brioche 2 CS of 8 × 1100 g (a case price, not a weight)', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Brioche', dimension: 'COUNT', baseUnit: 'each', countUnit: 'case', packChain: [{ unit: 'case', per: 8 }], pricing: { mode: 'PACK', purchasePrice: 40 }, eachMeasureQty: '1100', eachMeasureUnit: 'g' }),
    line: L({ rawQty: '2', rawUnit: 'CS', rawUnitPrice: '42', rawLineTotal: '84', invoicePackQty: '8', invoicePackSize: '1100', invoicePackUOM: 'g' }),
    expected: { newPricing: { mode: 'PACK', purchasePrice: 42 }, newPricePerBase: 5.25, spineNewPpb: 5.25, frozen: 16, density: 0 } },
  { name: 'reverse bridge: 1 cs = 70 each on a g item (1 each = 150 g)', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Dinner rolls', countUnit: 'kg', packChain: [{ unit: 'case', per: 10000 }], pricing: { mode: 'PACK', purchasePrice: 50 }, eachMeasureQty: '150', eachMeasureUnit: 'g' }),
    line: L({ rawQty: '1', rawUnit: 'CS', rawUnitPrice: '52.5', rawLineTotal: '52.5', pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '70', invoicePackUOM: 'each' }),
    expected: { newPricing: { mode: 'PACK', purchasePrice: 52.5 }, newPricePerBase: 0.005, spineNewPpb: null, frozen: 10500, density: 0 } },
  { name: '18.4 KG — a supplier’s first per-weight invoice on a case item', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Beef chuck', countUnit: 'case', packChain: [{ unit: 'case', per: 9072 }], pricing: { mode: 'PACK', purchasePrice: 200 } }),
    line: L({ rawQty: '18.4', rawUnit: 'KG', rate: '22', rateUOM: 'kg', rawLineTotal: '404.8', pricingMode: 'per_weight' }),
    expected: { newPricing: { mode: 'RATE', rate: 22, rateUnit: 'kg' }, newPricePerBase: 0.022, spineNewPpb: null, frozen: 18400, density: 0 } },
  { name: 'Tamari printed 1 × 1.89 L against a 6 × 1.89 L case — refused', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Tamari', dimension: 'VOLUME', baseUnit: 'ml', countUnit: 'case', packChain: [{ unit: 'case', per: 6 }, { unit: 'each', per: 1890 }], pricing: { mode: 'PACK', purchasePrice: 60 } }),
    line: L({ rawQty: '1', rawUnit: 'CS', rawUnitPrice: '61', rawLineTotal: '61', pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '1.89', invoicePackUOM: 'l' }),
    expected: { skipped: 'PACK_DISAGREES' } },
  { name: 'a per-case "rate" (rateUOM CS) 41.88 shipped as 12 LB', supplierId: 'sup', itemOffers: 0, lineOffer: null, item: eggplant,
    line: L({ rawQty: '12', rawUnit: 'LB', rate: '41.88', rateUOM: 'CS', rawUnitPrice: '3.49', rawLineTotal: '41.88', pricingMode: 'per_weight' }),
    expected: { newPricing: { mode: 'RATE', rate: 3.49, rateUnit: 'lb' }, newPricePerBase: 1.3960000000000001, spineNewPpb: null, frozen: 29.999999999999996, density: 0 } },
  { name: 'density cross: $12/kg on an ml item (olive oil, library 0.91 g/ml)', supplierId: 'sup', itemOffers: 0, lineOffer: null,
    item: I({ itemName: 'Olive oil', dimension: 'VOLUME', baseUnit: 'ml', countUnit: 'l', packChain: [{ unit: 'case', per: 4000 }], pricing: { mode: 'PACK', purchasePrice: 40 } }),
    line: L({ rawQty: '1', rawUnit: 'CS', rate: '12', rateUOM: 'kg', totalQty: '3.64', totalQtyUOM: 'kg', rawLineTotal: '43.68', pricingMode: 'per_weight' }),
    expected: { newPricing: { mode: 'RATE', rate: 12, rateUnit: 'kg' }, newPricePerBase: 0.010920000000000001, spineNewPpb: null, frozen: 4000, density: 0.91 } },
  { name: 'a non-primary supplier with its own 12-each case (item’s case is 48)', supplierId: 'sup-b', itemOffers: 2,
    lineOffer: { supplierId: 'sup-b', isPrimary: false, packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 30 } },
    item: I({ itemName: 'Romaine', dimension: 'COUNT', baseUnit: 'each', countUnit: 'each', packChain: [{ unit: 'case', per: 48 }], pricing: { mode: 'PACK', purchasePrice: 100 } }),
    line: L({ rawQty: '2', rawUnit: 'case', rawUnitPrice: '30', rawLineTotal: '60', pricingMode: 'per_case' }),
    expected: { newPricing: { mode: 'PACK', purchasePrice: 30 }, newPricePerBase: 2.5, spineNewPpb: 0.625, frozen: 24, density: 0 } },
]

describe('decideLinePrice — parity with the route’s inline decision at 409b1295', () => {
  for (const c of CASES) it(c.name, () => {
    const d = decideLinePrice({
      line: c.line, item: c.item, lineOffer: c.lineOffer,
      itemHasOffers: c.itemOffers > 0, sessionHasSupplier: !!c.supplierId, supplierName: 'Sysco',
    })
    if ('skipped' in c.expected) {
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.reason).toBe(c.expected.skipped)
      return
    }
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.newPricing).toEqual(c.expected.newPricing)
    expect(d.newPricePerBase).toBe(c.expected.newPricePerBase)
    expect(d.spineNewPpb).toBe(c.expected.spineNewPpb)
    expect(d.receiveBase).toBe(c.expected.frozen)
    expect(d.density).toBe(c.expected.density)
  })
})
