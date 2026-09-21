// `hasInvalidRcSplit` is the CLIENT's copy of the approve route's split check.
// The two must read the line the same way or a split silently disappears at
// approve — see the frozen-receipt note in src/lib/invoice/line-qty.ts.
import { describe, it, expect } from 'vitest'
import { hasInvalidRcSplit, splitTargetOf } from '@/lib/invoice/resolution'
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

// C2 (task-2-fix1.md): the split editor's seeded TARGET used to read `item`
// unchanged (via: 'frozen' when receivedQtyBase was set), while the validator
// and approve's lineQtyOf deliberately null it out — reachable via "Review
// again" on an approved invoice, which PATCHes only `status: 'REVIEW'` and
// leaves receivedQtyBase set. splitTargetOf is now the ONE function both
// card.tsx's `received` and hasInvalidRcSplit call, so they can't disagree.
describe('splitTargetOf — the card computes the exact target hasInvalidRcSplit validates against', () => {
  it('ignores a frozen receivedQtyBase (96 base units) and returns the LIVE quantity (24 kg)', () => {
    // 2.4 cases × 10,000 g pack-format = 24,000 g = 24 kg live; frozen (96 g =
    // 0.096 kg) is a stale number from a different pack — must be ignored.
    const item = line({ rawQty: '2.4', receivedQtyBase: 96 })
    const target = splitTargetOf(item)
    expect(target?.qty).toBeCloseTo(24, 5)
    expect(target?.countUom).toBe('kg')

    // A split summing to the LIVE target (24) is what hasInvalidRcSplit accepts —
    // proving the card's seeded target and the validator's target are the same number.
    expect(hasInvalidRcSplit(line({ rawQty: '2.4', receivedQtyBase: 96, rcSplit: [{ rcId: 'rc1', qty: 24 }] }))).toBe(false)
    // A split summing to the FROZEN value (what the old buggy target would have
    // seeded) is correctly rejected once computed live.
    expect(hasInvalidRcSplit(line({ rawQty: '2.4', receivedQtyBase: 96, rcSplit: [{ rcId: 'rc1', qty: 0.096 }] }))).toBe(true)
  })

  it('returns null for an unmatched line', () => {
    expect(splitTargetOf(line({ matchedItem: null }))).toBeNull()
  })
})
