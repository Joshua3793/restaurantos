// The review screen reads every line through the SAME decision the approve
// preflight uses (`decideLinePrice`), so a line approve would refuse — or a price
// that works out 1,000× off — shows on screen, blocks the Approve button, and
// clears exactly when approve would accept it.
// (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 4)
import { describe, it, expect } from 'vitest'
import { lineReasons, lineUnresolved, type ResolveOpts } from '@/lib/invoice/resolution'
import { decisionForScanItem, unitCheckSuggestion, unitFixPatch, weightUnitForScanItem } from '@/lib/invoice/approve-outcome-client'
import type { ScanItem } from '@/components/invoices/types'

const base = (over: Partial<ScanItem>): ScanItem => ({
  id: 'l1', rawDescription: 'LINE', rawQty: null, rawUnit: null,
  rawUnitPrice: null, rawLineTotal: null, matchedItemId: 'i1', matchedItem: null,
  matchConfidence: 'HIGH', matchScore: 100, action: 'UPDATE_PRICE', approved: false,
  isNewItem: false, newItemData: null, previousPrice: null, newPrice: null, priceDiffPct: null,
  invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
  totalQty: null, totalQtyUOM: null, sortOrder: 0,
  ...over,
})
const opts = (over: Partial<ResolveOpts> = {}): ResolveOpts => ({ priceAck: false, confAck: false, ...over })
const kinds = (item: ScanItem, o: ResolveOpts, ref: object) => lineReasons(item, o, ref).map(r => ({ kind: r.kind, resolved: r.resolved }))
const reason = (item: ScanItem, o: ResolveOpts, ref: object, kind: string) => lineReasons(item, o, ref).find(r => r.kind === kind)

// ── Cilantro: Sysco's box is a case of 4 × 1 lb; the line prints 1 × 1 lb. ──────
const cilChain = [{ unit: 'case', per: 4 }, { unit: 'each', per: 453.592 }]
const sysco = { supplierId: 'sysco', supplierName: 'Sysco', canonicalName: 'Sysco' }
const cilantro = {
  id: 'i1', itemName: 'Cilantro', pricePerBaseUnit: '0', purchasePrice: '30',
  baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: cilChain, pricing: { mode: 'PACK', purchasePrice: 30 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  supplierPrices: [{
    id: 'o1', supplierId: 'sysco', supplierName: 'Sysco', isPrimary: true,
    lastPrice: 30, pricePerBaseUnit: 0, packQty: 4, packSize: 1, packUOM: 'lb',
    packChain: cilChain, pricing: { mode: 'PACK', purchasePrice: 30 },
  }],
} as unknown as ScanItem['matchedItem']
const cilLine = base({
  rawDescription: 'CILANTRO CLEAN WASH FRES', matchedItem: cilantro,
  rawQty: '1', rawUnit: 'CS', rawUnitPrice: '30', rawLineTotal: '30', pricingMode: 'per_case',
  invoicePackQty: '1', invoicePackSize: '1', invoicePackUOM: 'LB',
})

describe('a line approve would refuse shows as "blocked"', () => {
  it('Cilantro (case size changed) → one unresolved blocked reason with the decision’s message', () => {
    const blocked = lineReasons(cilLine, opts(), sysco).filter(r => r.kind === 'blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0].resolved).toBe(false)
    expect(blocked[0].title).toBe('Case size changed')
    expect(blocked[0].summary).toMatch(/^Sysco's box for Cilantro is a case of 4 × 1 lb/)
    expect(lineUnresolved(cilLine, opts(), sysco)).toBe(true)
  })

  it('choosing "Receive the stock, keep the old price" resolves it (and the price move it would no longer write)', () => {
    expect(reason(cilLine, opts({ receiveOnly: true }), sysco, 'blocked')?.resolved).toBe(true)
    expect(lineUnresolved(cilLine, opts({ receiveOnly: true }), sysco)).toBe(false)
  })

  it('staging the box’s real case (4 × 1 lb) clears it — the line no longer blocks', () => {
    const fixed = { ...cilLine, invoicePackQty: '4' }
    expect(reason(fixed, opts(), sysco, 'blocked')).toBeUndefined()
    expect(lineUnresolved(fixed, opts(), sysco)).toBe(false)
  })

  it('a block the server sent stays until the line changes, and is resolved by receive-only', () => {
    const clean = { ...cilLine, invoicePackQty: '4' }
    const serverBlock = {
      scanItemId: 'l1', description: 'CILANTRO', itemName: 'Cilantro', reason: 'NO_PRICE' as const,
      message: 'This line has no price. Enter the price, or receive the stock and keep the old price.',
      canReceiveWithoutPrice: true, canConfirmPrice: false,
    }
    const r = reason(clean, opts({ serverBlock }), sysco, 'blocked')
    expect(r).toMatchObject({ title: 'No price', resolved: false })
    expect(reason(clean, opts({ serverBlock, receiveOnly: true }), sysco, 'blocked')?.resolved).toBe(true)
  })

  it('receive-only cannot clear a block that has nothing to receive into', () => {
    const serverBlock = {
      scanItemId: 'l1', description: 'NEW THING', itemName: null, reason: 'CREATE_NEW_NOT_SET_UP' as const,
      message: 'Set up the new product first.', canReceiveWithoutPrice: false, canConfirmPrice: false,
    }
    const clean = { ...cilLine, invoicePackQty: '4' }
    expect(reason(clean, opts({ serverBlock, receiveOnly: true }), sysco, 'blocked')).toMatchObject({ title: 'New product not set up', resolved: false })
  })
})

// ── Bison: "15.775 @ $25", no unit, under a PACK box on an item counted in cases. ──
const cleveland = { supplierId: 'cleveland', supplierName: 'Cleveland Meats', canonicalName: 'Cleveland Meats' }
const packBison = {
  id: 'i1', itemName: 'Bison burger', pricePerBaseUnit: '0.025', purchasePrice: '25',
  baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 25 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  supplierPrices: [{
    id: 'o1', supplierId: 'cleveland', supplierName: 'Cleveland Meats', isPrimary: true,
    lastPrice: 25, pricePerBaseUnit: 0.025, packQty: null, packSize: null, packUOM: null,
    packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 25 },
  }],
} as unknown as ScanItem['matchedItem']
const bisonLine = base({
  rawDescription: 'BISON BURGER', matchedItem: packBison,
  rawQty: '15.775', rate: '25', rawUnitPrice: '25', rawLineTotal: '394.38', pricingMode: 'per_weight',
})

describe('a price that works out 1,000× off shows as "unit"', () => {
  it('the unit-less bison line → one unresolved unit reason, in plain English', () => {
    const r = reason(bisonLine, opts(), cleveland, 'unit')
    expect(r).toBeDefined()
    expect(r!.resolved).toBe(false)
    expect(r!.title).toBe('Price looks about 1,000× off')
    expect(r!.summary).toMatch(/^Check the unit\. This line works out at \$25,000\.00 per kg; Cleveland Meats' box is \$25\.00 per kg\.$/)
    expect(lineUnresolved(bisonLine, opts(), cleveland)).toBe(true)
  })

  it('the quick fix suggests kg, and staging it clears the flag', () => {
    expect(unitCheckSuggestion(bisonLine, cleveland)).toBe('kg')
    const patch = unitFixPatch(bisonLine, 'kg')
    expect(patch).toEqual({ rateUOM: 'kg' })
    const fixed = { ...bisonLine, ...patch }
    expect(reason(fixed, opts(), cleveland, 'unit')).toBeUndefined()
    expect(lineUnresolved(fixed, opts(), cleveland)).toBe(false)
  })

  it('the quick fix also labels a billed weight that has no unit', () => {
    expect(unitFixPatch({ ...bisonLine, totalQty: '15.775' }, 'kg')).toEqual({ rateUOM: 'kg', totalQtyUOM: 'kg' })
    expect(unitFixPatch({ ...bisonLine, totalQty: '15.775', totalQtyUOM: 'lb' }, 'kg')).toEqual({ rateUOM: 'kg' })
  })

  it('"The price is right" resolves it', () => {
    expect(reason(bisonLine, opts({ unitConfirmed: true }), cleveland, 'unit')?.resolved).toBe(true)
    expect(lineUnresolved(bisonLine, opts({ unitConfirmed: true }), cleveland)).toBe(false)
  })
})

describe('the assumed unit', () => {
  it('a unit-less bison line under a RATE $25/kg box is read in kg, with the note saying so', () => {
    const rateBison = {
      ...packBison!, countUnit: 'kg', pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' },
      supplierPrices: [{ ...packBison!.supplierPrices![0], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } }],
    } as unknown as ScanItem['matchedItem']
    const line = { ...bisonLine, matchedItem: rateBison }
    const w = weightUnitForScanItem(line, cleveland)
    expect(w.unit).toEqual('kg')
    expect(w.source).toBe('box')
    expect(w.note).toBe("assumed kg — the invoice shows no unit; Cleveland Meats' box is priced per kg")
    expect(reason(line, opts(), cleveland, 'unit')).toBeUndefined()
  })

  it('a line that states its unit has no note', () => {
    const w = weightUnitForScanItem({ ...bisonLine, rateUOM: 'lb' }, cleveland)
    expect(w).toMatchObject({ unit: 'lb', assumed: false, note: null })
  })
})

describe('a clean line', () => {
  // 2 cases of a 10 kg case at $100 — exactly the item's own case and price.
  const flour = {
    id: 'i1', itemName: 'Flour', pricePerBaseUnit: '0.01', purchasePrice: '100',
    baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
    packChain: [{ unit: 'case', per: 10000 }], pricing: { mode: 'PACK', purchasePrice: 100 },
    eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  } as unknown as ScanItem['matchedItem']
  const flourLine = base({
    rawDescription: 'FLOUR AP 10KG', matchedItem: flour, rawQty: '2', rawUnit: 'case',
    rawUnitPrice: '100', rawLineTotal: '200', pricingMode: 'per_case',
    invoicePackQty: '1', invoicePackSize: '10', invoicePackUOM: 'kg',
  })

  it('shows neither a block nor a unit check, and does not hold up Approve', () => {
    expect(kinds(flourLine, opts(), {}).filter(k => k.kind === 'blocked' || k.kind === 'unit')).toEqual([])
    expect(lineUnresolved(flourLine, opts(), {})).toBe(false)
    expect(decisionForScanItem(flourLine, {})?.ok).toBe(true)
  })

  it('a skipped or unlinked line has no decision to read', () => {
    expect(decisionForScanItem({ ...flourLine, action: 'SKIP' }, {})).toBeNull()
    expect(decisionForScanItem({ ...flourLine, matchedItem: null, matchedItemId: null }, {})).toBeNull()
  })
})
