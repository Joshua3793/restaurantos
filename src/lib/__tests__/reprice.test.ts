import { describe, it, expect } from 'vitest'
import { shouldRepriceItem } from '../invoice/reprice'

const base = {
  sessionSupplierId: 'sup-a' as string | null,
  writtenOfferId: null as string | null,
  primary: { id: 'offer-1', supplierId: 'sup-a' } as { id: string; supplierId: string } | null,
  supplierRowCount: 1,
  itemOfferCount: 1,
}

describe('shouldRepriceItem', () => {
  it('unlinked supplier + item has a box -> never re-prices', () => {
    expect(shouldRepriceItem({ ...base, sessionSupplierId: null, itemOfferCount: 1 })).toBe(false)
  })
  it('unlinked supplier + item has several boxes -> never re-prices', () => {
    expect(shouldRepriceItem({ ...base, sessionSupplierId: null, itemOfferCount: 3 })).toBe(false)
  })
  it('unlinked supplier + no boxes (legacy single-supplier item) -> re-prices', () => {
    expect(shouldRepriceItem({ ...base, sessionSupplierId: null, primary: null, itemOfferCount: 0 })).toBe(true)
  })
  it('linked + written offer is the primary -> re-prices', () => {
    expect(shouldRepriceItem({ ...base, writtenOfferId: 'offer-1' })).toBe(true)
  })
  it('linked + written offer is not the primary -> does not', () => {
    expect(shouldRepriceItem({ ...base, writtenOfferId: 'offer-2' })).toBe(false)
  })
  it('linked + written offer + no primary -> does not', () => {
    expect(shouldRepriceItem({ ...base, writtenOfferId: 'offer-2', primary: null })).toBe(false)
  })
  it('linked + write failed + primary is this supplier + one row -> re-prices', () => {
    expect(shouldRepriceItem({ ...base, supplierRowCount: 1 })).toBe(true)
  })
  it('linked + write failed + two rows from this supplier -> does not', () => {
    expect(shouldRepriceItem({ ...base, supplierRowCount: 2 })).toBe(false)
  })
  it('linked + write failed + primary belongs to another supplier -> does not', () => {
    expect(shouldRepriceItem({ ...base, primary: { id: 'offer-9', supplierId: 'sup-b' } })).toBe(false)
  })
})
