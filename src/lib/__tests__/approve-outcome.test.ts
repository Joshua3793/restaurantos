import { describe, it, expect } from 'vitest'
import {
  decideLinePrice, approveBlocks, lineQtyOf,
  type ApproveLineInput, type ApproveItemInput,
} from '@/lib/invoice/approve-outcome'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'
import { freezeFormat } from '@/lib/invoice/approve-format'
import type { OfferFormat } from '@/lib/invoice/line-format'

// A scan line with every field null — each test states only what its invoice prints.
const line = (over: Partial<ApproveLineInput>): ApproveLineInput => ({
  rawQty: null, rawUnit: null, rawUnitPrice: null, rawLineTotal: null, newPrice: null,
  totalQty: null, totalQtyUOM: null, rate: null, rateUOM: null, pricingMode: null,
  qtyOrdered: null, invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
  supplierItemCode: null, rawDescription: 'LINE', action: 'UPDATE_PRICE', matchedItemId: 'item', newItemData: null,
  ...over,
})
const item = (over: Partial<ApproveItemInput>): ApproveItemInput => ({
  id: 'item', itemName: 'Item', dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  ...over,
})
const decide = (l: ApproveLineInput, i: ApproveItemInput, lineOffer: OfferFormat | null = null, o: { itemHasOffers?: boolean; sessionHasSupplier?: boolean; supplierName?: string | null } = {}) =>
  decideLinePrice({
    line: l, item: i, lineOffer,
    itemHasOffers: o.itemHasOffers ?? !!lineOffer,
    sessionHasSupplier: o.sessionHasSupplier ?? true,
    supplierName: o.supplierName ?? 'Sysco',
  })

// Cleveland Meats' bison: "15.775 @ $25", no unit anywhere on the line.
const bisonLine = line({
  rawDescription: 'BISON BURGER', rawQty: '15.775', rate: '25', rawUnitPrice: '25', rawLineTotal: '394.38', pricingMode: 'per_weight',
})

describe('decideLinePrice — bug A: an unlabelled weight follows its box', () => {
  const bison = item({ itemName: 'Bison burger', countUnit: 'kg', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } })
  const box: OfferFormat = { supplierId: 'cleveland', isPrimary: true, packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } }

  it('reads 15.775 in the unit the box is priced in: $25/kg, 15,775 g received, nothing flagged', () => {
    const d = decide(bisonLine, bison, box, { supplierName: 'Cleveland Meats' })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.isUomMode).toBe(true)
    expect(d.weightUnit).toEqual({ unit: 'kg', source: 'box', assumed: true })
    expect(d.newPricing).toEqual({ mode: 'RATE', rate: 25, rateUnit: 'kg' })
    expect(d.newPricePerBase).toBeCloseTo(0.025, 9)
    expect(lineReceivedBaseUnits(lineQtyOf(bisonLine), freezeFormat(d.speaks, d.newPricing))).toBeCloseTo(15775)
    expect(d.receiveBase).toBeCloseTo(15775)
    expect(d.implausible).toBeNull()
  })

  it('with no box to go on (PACK item counted in cases) it falls to grams — and the 1,000× price is flagged', () => {
    const packBison = item({ itemName: 'Bison burger', countUnit: 'case', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 25 } })
    const d = decide(bisonLine, packBison, null, { itemHasOffers: false, supplierName: 'Cleveland Meats' })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.weightUnit?.source).toBe('base-unit')
    expect(d.newPricing).toEqual({ mode: 'RATE', rate: 25, rateUnit: 'g' })
    expect(d.implausible).not.toBeNull()
    expect(d.implausible!.ratio).toBeCloseTo(1000, 6)
    expect(d.implausible!.currentPpb).toBeCloseTo(0.025, 9)
  })
})

describe('decideLinePrice — the guards', () => {
  it('Baking Powder: a 3 kg box, a line printing 1 × 20 kg → PACK_DISAGREES, still receivable at 20 kg', () => {
    const bp = item({ itemName: 'Baking Powder', countUnit: 'case', packChain: [{ unit: 'case', per: 3000 }], pricing: { mode: 'PACK', purchasePrice: 16.92 } })
    const d = decide(line({ rawQty: '1', rawUnit: 'CS', rawUnitPrice: '112.83', rawLineTotal: '112.83', pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '20', invoicePackUOM: 'kg' }), bp, null, { itemHasOffers: false })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('PACK_DISAGREES')
    expect(d.receivable).toBe(true)
    expect(d.receiveBase).toBeCloseTo(20000)
    expect(d.message).toBe("Baking Powder's box is a case of 3 kg. This line says 1 × 20 kg. Fix the case size, or receive the stock and keep the old price.")
  })

  it('Cilantro: Sysco’s box is 4 × 1 lb, the line says 1 × 1 lb → PACK_DISAGREES, receives 1 lb', () => {
    const chain = [{ unit: 'case', per: 4 }, { unit: 'each', per: 453.592 }]
    const cil = item({ itemName: 'Cilantro', countUnit: 'case', packChain: chain, pricing: { mode: 'PACK', purchasePrice: 30 } })
    const box = { supplierId: 'sysco', isPrimary: true, packChain: chain, pricing: { mode: 'PACK', purchasePrice: 30 }, packQty: 4, packSize: 1, packUOM: 'lb' }
    const d = decide(line({ rawDescription: 'CILANTRO CLEAN WASH FRES', rawQty: '1', rawUnit: 'CS', rawUnitPrice: '9.5', rawLineTotal: '9.5', pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '1', invoicePackUOM: 'LB' }), cil, box)
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('PACK_DISAGREES')
    expect(d.receiveBase).toBeCloseTo(453.592)
    expect(d.message).toBe("Sysco's box for Cilantro is a case of 4 × 1 lb (1.81 kg). This line says 1 × 1 lb (454 g). Fix the case size, or receive the stock and keep the old price.")
  })

  const pineapple = item({ itemName: 'Pineapple', dimension: 'COUNT', baseUnit: 'each', countUnit: 'each', packChain: [{ unit: 'case', per: 8 }], pricing: { mode: 'PACK', purchasePrice: 40 } })
  const perKg = line({ rawQty: '1', rawUnit: 'CS', rate: '2.2', rateUOM: 'kg', totalQty: '12', totalQtyUOM: 'kg', rawUnitPrice: '26.4', rawLineTotal: '26.4', pricingMode: 'per_weight' })

  it('a $/kg line on an each-item with no weight per each → RATE_UNCOSTABLE', () => {
    const d = decide(perKg, pineapple, null, { itemHasOffers: false })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('RATE_UNCOSTABLE')
    // The 12 kg cannot be turned into pineapples, so "1 case = 8" is a guess: no receive-only.
    expect(d.receivable).toBe(false)
    expect(d.receiveBase).toBe(8)
    expect(d.message).toBe("This line is priced per kg, but Pineapple is counted in each and has no weight per each. Can't receive this without knowing how much one weighs — add it in Edit.")
  })

  it('Eggplant (each, 24 per case, no weight per each), "12 lb @ $3.49/lb" → refused, and NOT receivable (not 288 each)', () => {
    const eggplant = item({ itemName: 'Eggplant', dimension: 'COUNT', baseUnit: 'each', countUnit: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 } })
    const l = line({ rawDescription: 'EGGPLANT', rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', rawUnitPrice: '3.49', rawLineTotal: '41.88', pricingMode: 'per_weight' })
    const d = decide(l, eggplant, null, { itemHasOffers: false })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('RATE_UNCOSTABLE')
    expect(d.received?.needsBridge).toBe(true)
    expect(d.receivable).toBe(false)
    expect(d.message).toMatch(/Can't receive this without knowing how much one weighs — add it in Edit\.$/)
    expect(d.message).not.toMatch(/receive the stock and keep the old price/)
    const b = approveBlocks({
      lines: [{ ...l, id: 'egg', matchedItemId: 'item', matchedItem: eggplant }], offersByItem: new Map(),
      supplier: { id: 'sup', supplierId: 'sup', supplierName: 'Sysco', canonicalName: 'Sysco' },
      receiveWithoutPrice: new Set(['egg']), priceConfirmed: new Set(),
    })
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ reason: 'RATE_UNCOSTABLE', canReceiveWithoutPrice: false })
  })

  it('the same line once one pineapple is known to weigh 400 g → priced per each through the bridge', () => {
    const d = decide(perKg, { ...pineapple, eachMeasureQty: '400', eachMeasureUnit: 'g' }, null, { itemHasOffers: false })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.newPricing).toEqual({ mode: 'RATE', rate: 2.2, rateUnit: 'kg' })
    expect(d.newPricePerBase).toBeCloseTo(0.88, 9)
    expect(d.receiveBase).toBeCloseTo(30)
  })

  it('a $0 price → NO_PRICE', () => {
    const d = decide(line({ rawQty: '2', rawUnit: 'CS', rawUnitPrice: '0', pricingMode: 'per_case' }), item({}), null, { itemHasOffers: false })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('NO_PRICE')
    expect(d.receiveBase).toBe(2000)
    expect(d.message).toBe('This line has no price. Enter the price, or receive the stock and keep the old price.')
  })

  it('no price anywhere on the line (Limes) → NO_PRICE, not a silent fall-through', () => {
    const d = decide(line({ rawDescription: 'LIMES', rawQty: '1', rawUnit: 'CS', pricingMode: 'per_case' }), item({ itemName: 'Limes' }), null, { itemHasOffers: false })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.reason).toBe('NO_PRICE')
    expect(d.receivable).toBe(true)
    expect(d.receiveBase).toBe(1000)
  })

  it('a supplier with no box on an item that has boxes → no pack guard (their pack becomes their box)', () => {
    const romaine = item({ itemName: 'Romaine', dimension: 'COUNT', baseUnit: 'each', countUnit: 'case', packChain: [{ unit: 'case', per: 48 }], pricing: { mode: 'PACK', purchasePrice: 96 } })
    const d = decide(line({ rawQty: '1', rawUnit: 'CS', rawUnitPrice: '30', pricingMode: 'per_case', invoicePackQty: '12', invoicePackSize: '1', invoicePackUOM: 'each' }), romaine, null, { itemHasOffers: true })
    expect(d.ok).toBe(true)
  })
})

describe('approveBlocks — the preflight list', () => {
  const bp = item({ id: 'bp', itemName: 'Baking Powder', countUnit: 'case', packChain: [{ unit: 'case', per: 3000 }], pricing: { mode: 'PACK', purchasePrice: 16.92 } })
  const packBison = item({ id: 'bison', itemName: 'Bison burger', countUnit: 'case', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 25 } })
  const blockedPack = { ...line({ rawDescription: 'BAKING POWDER 20KG', matchedItemId: 'bp', rawQty: '1', rawUnit: 'CS', rawUnitPrice: '112.83', pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '20', invoicePackUOM: 'kg' }), id: 'l1', matchedItem: bp }
  const implausible = { ...bisonLine, matchedItemId: 'bison', id: 'l2', matchedItem: packBison }
  const createNew = { ...line({ action: 'CREATE_NEW', matchedItemId: null, rawDescription: 'NEW THING' }), id: 'l3', matchedItem: null }
  const unlinked = { ...line({ matchedItemId: null, rawDescription: 'MYSTERY' }), id: 'l4', matchedItem: null }
  const skipped = { ...line({ action: 'SKIP', matchedItemId: null }), id: 'l5', matchedItem: null }
  const lines = [blockedPack, implausible, createNew, unlinked, skipped]
  const run = (receiveWithoutPrice: string[] = [], priceConfirmed: string[] = []) => approveBlocks({
    lines, offersByItem: new Map(),
    supplier: { id: 'sup', supplierId: 'sup', supplierName: 'Cleveland Meats', canonicalName: 'Cleveland Meats' },
    receiveWithoutPrice: new Set(receiveWithoutPrice), priceConfirmed: new Set(priceConfirmed),
  })

  it('lists every line approve would refuse, with what the reviewer may do', () => {
    const b = run()
    expect(b.map(x => [x.scanItemId, x.reason])).toEqual([
      ['l1', 'PACK_DISAGREES'], ['l2', 'PRICE_IMPLAUSIBLE'], ['l3', 'CREATE_NEW_NOT_SET_UP'], ['l4', 'NOT_LINKED'],
    ])
    expect(b[0]).toMatchObject({ itemName: 'Baking Powder', description: 'BAKING POWDER 20KG', canReceiveWithoutPrice: true, canConfirmPrice: false })
    // A price that looks off clears only by "The price is right" — never by receive-only.
    expect(b[1]).toMatchObject({ canReceiveWithoutPrice: false, canConfirmPrice: true })
    // Bison prints no unit (assumed g), so it reads as an assumed-unit check.
    expect(b[1].message).toBe("The unit was assumed; the price is 1,000× off the box — confirm the unit. This line works out at $25,000.00 per kg; Bison burger's box is $25.00 per kg.")
    expect(b[2]).toMatchObject({ canReceiveWithoutPrice: false, canConfirmPrice: false, itemName: null })
    expect(b[3]).toMatchObject({ canReceiveWithoutPrice: false, message: "This line isn't linked to a product. Link it, create a product, or skip it." })
  })

  it('drops a blocked line the reviewer chose to receive without the price', () => {
    expect(run(['l1']).map(x => x.scanItemId)).toEqual(['l2', 'l3', 'l4'])
  })

  it('drops an implausible price only once the reviewer confirmed it — receive-only alone does not clear it', () => {
    expect(run([], ['l2']).map(x => x.scanItemId)).toEqual(['l1', 'l3', 'l4'])
    expect(run(['l2']).map(x => x.scanItemId)).toEqual(['l1', 'l2', 'l3', 'l4'])
    expect(run(['l2'], ['l2']).map(x => x.scanItemId)).toEqual(['l1', 'l3', 'l4'])
  })

  it('a confirmation only clears PRICE_IMPLAUSIBLE — never a pack disagreement', () => {
    expect(run([], ['l1']).map(x => x.scanItemId)).toContain('l1')
  })

  it('keeps a CREATE_NEW refusal even when its id is in receiveWithoutPrice (no product to receive into)', () => {
    expect(run(['l3', 'l4']).map(x => x.scanItemId)).toEqual(['l1', 'l2', 'l3', 'l4'])
  })

  it('CREATE_NEW: a shouty name and a by-weight COUNT product without an each-measure are refused', () => {
    const named = (d: object, over: Partial<ApproveLineInput> = {}) => ({ ...line({ action: 'CREATE_NEW', matchedItemId: null, rawDescription: 'RED GRAPES 4KG', newItemData: JSON.stringify(d), ...over }), id: 'n', matchedItem: null })
    const one = (l: ReturnType<typeof named>) => approveBlocks({ lines: [l], offersByItem: new Map(), supplier: { id: null, supplierId: null }, receiveWithoutPrice: new Set(), priceConfirmed: new Set() })
    expect(one(named({ itemName: 'RED GRAPES 4KG', allowShouty: false }))[0].reason).toBe('CREATE_NEW_NAME')
    const shape = one(named(
      { itemName: 'Red grapes', dimension: 'COUNT', packChain: [{ unit: 'case', per: 1 }], pricing: { mode: 'PACK', purchasePrice: 9 }, countUnit: 'each' },
      { pricingMode: 'per_weight', rateUOM: 'kg', rate: '3', rawQty: '4' },
    ))
    expect(shape[0].reason).toBe('CREATE_NEW_SHAPE')
    expect(shape[0].message).not.toMatch(/Delete this invoice/)
    expect(one(named({ itemName: 'Red grapes', dimension: 'MASS', packChain: [{ unit: 'case', per: 4000 }], pricing: { mode: 'PACK', purchasePrice: 9 }, countUnit: 'kg' }))).toEqual([])
  })
})

describe('decideLinePrice — an ASSUMED unit asks earlier (3×, not 20×)', () => {
  // Flour: the box is $50 a case of 10 kg ($5/kg). "2 @ $50", per weight, no unit
  // anywhere: the unit is assumed (kg — the item is counted in kg) → $50/kg, 10× the box.
  const flour = item({ itemName: 'Flour', countUnit: 'kg', packChain: [{ unit: 'case', per: 10000 }], pricing: { mode: 'PACK', purchasePrice: 50 } })
  const flourLine = line({ rawDescription: 'FLOUR', rawQty: '2', rate: '50', rawUnitPrice: '50', rawLineTotal: '100', pricingMode: 'per_weight' })

  it('the Flour case: unit assumed, 10× off → flagged, with its own sentence', () => {
    const d = decide(flourLine, flour, null, { itemHasOffers: false })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.weightUnit).toMatchObject({ unit: 'kg', assumed: true })
    expect(d.implausible).not.toBeNull()
    expect(d.implausible!.ratio).toBeCloseTo(10, 6)
    expect(d.implausible!.assumed).toBe(true)
    const b = approveBlocks({
      lines: [{ ...flourLine, id: 'f', matchedItemId: 'item', matchedItem: flour }], offersByItem: new Map(),
      supplier: { id: null, supplierId: null }, receiveWithoutPrice: new Set(), priceConfirmed: new Set(),
    })
    expect(b).toHaveLength(1)
    expect(b[0].reason).toBe('PRICE_IMPLAUSIBLE')
    expect(b[0].message).toBe("The unit was assumed; the price is 10× off the box — confirm the unit. This line works out at $50.00 per kg; Flour's box is $5.00 per kg.")
  })

  it('the same 10× with the unit PRINTED on the line is not flagged (20× still applies there)', () => {
    const d = decide({ ...flourLine, rateUOM: 'kg' }, flour, null, { itemHasOffers: false })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.weightUnit).toMatchObject({ unit: 'kg', assumed: false })
    expect(d.implausible).toBeNull()
  })

  it('a PRINTED unit 30× off is flagged with the 20× wording', () => {
    const l = { ...flourLine, rateUOM: 'kg', rate: '150', rawUnitPrice: '150', rawLineTotal: '300' }
    const b = approveBlocks({
      lines: [{ ...l, id: 'f', matchedItemId: 'item', matchedItem: flour }], offersByItem: new Map(),
      supplier: { id: null, supplierId: null }, receiveWithoutPrice: new Set(), priceConfirmed: new Set(),
    })
    expect(b[0].message).toBe("Price looks about 30× off — check the unit. This line works out at $150.00 per kg; Flour's box is $5.00 per kg.")
  })

  it('an assumed unit under 3× off is clear', () => {
    const d = decide({ ...flourLine, rate: '12', rawUnitPrice: '12', rawLineTotal: '24' }, flour, null, { itemHasOffers: false })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.implausible).toBeNull()
  })
})
