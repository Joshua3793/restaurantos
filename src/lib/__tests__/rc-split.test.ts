// `hasInvalidRcSplit` is the CLIENT's copy of the approve route's split check.
// The two must read the line the same way or a split silently disappears at
// approve — see the frozen-receipt note in src/lib/invoice/line-qty.ts.
import { describe, it, expect } from 'vitest'
import { hasInvalidRcSplit } from '@/lib/invoice/resolution'
import type { ScanItem } from '@/components/invoices/types'

// 1 case = 10 kg = 10,000 g; counted in kg.
const matched = {
  id: 'i1', itemName: 'Flour', pricePerBaseUnit: '0.01', purchasePrice: '100',
  baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
  packChain: [{ unit: 'case', per: 10000 }],
  pricing: { mode: 'PACK', purchasePrice: 100 },
}

const line = (over: Partial<ScanItem>): ScanItem => ({
  id: 'l1', rawDescription: 'FLOUR AP 10KG', rawQty: '2', rawUnit: 'case',
  rawUnitPrice: '100', rawLineTotal: '200', matchedItemId: 'i1',
  matchedItem: matched as unknown as ScanItem['matchedItem'],
  matchConfidence: 'HIGH', matchScore: 100, action: 'UPDATE_PRICE', approved: false,
  isNewItem: false, newItemData: null, previousPrice: null, newPrice: null, priceDiffPct: null,
  invoicePackQty: '1', invoicePackSize: '10', invoicePackUOM: 'kg',
  totalQty: null, totalQtyUOM: null, sortOrder: 0,
  ...over,
})

describe('hasInvalidRcSplit', () => {
  it('accepts a split that sums to the live received quantity (2 cases = 20 kg)', () => {
    expect(hasInvalidRcSplit(line({ rcSplit: [{ rcId: 'rc1', qty: 12 }, { rcId: 'rc2', qty: 8 }] }))).toBe(false)
  })

  it('rejects a split that does not sum to it', () => {
    expect(hasInvalidRcSplit(line({ rcSplit: [{ rcId: 'rc1', qty: 12 }] }))).toBe(true)
  })

  // The bug: on a RE-approve of a line whose pack was corrected, the client
  // validated against the FROZEN receipt while the approve route's `lineQtyOf`
  // deliberately omits `receivedQtyBase` and recomputes. The client then called
  // a split valid that the server was about to reject — and drop, silently.
  it('ignores a stale frozen receipt and validates against the live pack, like the server does', () => {
    // receivedQtyBase frozen from the OLD 5 kg pack (2 × 5 kg = 10,000 g = 10 kg).
    const stale = { receivedQtyBase: 10000, rcSplit: [{ rcId: 'rc1', qty: 12 }, { rcId: 'rc2', qty: 8 }] }
    expect(hasInvalidRcSplit(line(stale))).toBe(false)
    // …and a split matching only the stale total is correctly refused.
    expect(hasInvalidRcSplit(line({ receivedQtyBase: 10000, rcSplit: [{ rcId: 'rc1', qty: 10 }] }))).toBe(true)
  })

  it('an unmatched line, or an empty split, is invalid', () => {
    expect(hasInvalidRcSplit(line({ matchedItem: null, rcSplit: [{ rcId: 'rc1', qty: 20 }] }))).toBe(true)
    expect(hasInvalidRcSplit(line({ rcSplit: [{ rcId: 'rc1', qty: 0 }] }))).toBe(true)
  })

  it('no split at all is not an invalid split', () => {
    expect(hasInvalidRcSplit(line({ rcSplit: null }))).toBe(false)
  })
})
