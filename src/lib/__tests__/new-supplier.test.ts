import { describe, it, expect } from 'vitest'
import { isNewSupplierForItem } from '@/lib/invoice/new-supplier'
import type { ScanItem } from '@/components/invoices/types'

const base = { action: 'ADD_SUPPLIER', matchedItem: { supplierPrices: [{ supplierId: 'a', supplierName: 'Sysco' }] } } as unknown as ScanItem

describe('isNewSupplierForItem', () => {
  it('true when the item has offers but none from this supplier', () => {
    expect(isNewSupplierForItem(base, { supplierId: 'b', supplierName: 'North Arm Farms' })).toBe(true)
  })
  it('false when this supplier already has an offer', () => {
    expect(isNewSupplierForItem(base, { supplierId: 'a', supplierName: 'Sysco' })).toBe(false)
  })
  it('false for unmatched, skipped, or supplier-less lines, and for items with no offers', () => {
    expect(isNewSupplierForItem({ ...base, matchedItem: null } as ScanItem, { supplierName: 'X' })).toBe(false)
    expect(isNewSupplierForItem({ ...base, action: 'SKIP' } as ScanItem, { supplierName: 'X' })).toBe(false)
    expect(isNewSupplierForItem(base, {})).toBe(false)
    expect(isNewSupplierForItem({ ...base, matchedItem: { supplierPrices: [] } } as unknown as ScanItem, { supplierName: 'X' })).toBe(false)
  })
  // The session ref carries the OCR-variant supplierName plus the Supplier row's
  // own canonicalName; offers are keyed by the canonical name. A ref that matches
  // an existing offer ONLY via canonicalName (not supplierId or supplierName) must
  // still be found — otherwise the note would wrongly claim "first time buying"
  // from a supplier the item already has an offer from.
  it('false when only canonicalName matches an existing offer (OCR variant supplier name)', () => {
    const item = {
      ...base,
      matchedItem: { supplierPrices: [{ supplierId: null, supplierName: 'North Arm Farms Ltd.' }] },
    } as unknown as ScanItem
    expect(isNewSupplierForItem(item, {
      supplierName: 'North Arm Farms (per invoice)',
      canonicalName: 'North Arm Farms Ltd.',
    })).toBe(false)
  })
})
