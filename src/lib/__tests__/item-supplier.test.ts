import { describe, it, expect } from 'vitest'
import { withSupplier, PRIMARY_SUPPLIER_INCLUDE } from '@/lib/item-supplier'

describe("withSupplier — an item's supplier is its primary box's supplier", () => {
  it('maps the primary box to supplier/supplierId and drops supplierPrices', () => {
    const row = { id: 'i1', itemName: 'Free Run Eggs', supplierPrices: [{ supplierId: 's2', supplier: { id: 's2', name: 'Legends Haul' } }] }
    expect(withSupplier(row)).toEqual({ id: 'i1', itemName: 'Free Run Eggs', supplier: { id: 's2', name: 'Legends Haul' }, supplierId: 's2' })
  })
  it('no box → null supplier', () => {
    expect(withSupplier({ id: 'i1', supplierPrices: [] })).toEqual({ id: 'i1', supplier: null, supplierId: null })
  })
  it('the include asks for the primary box only', () => {
    expect(PRIMARY_SUPPLIER_INCLUDE.supplierPrices.where).toEqual({ isPrimary: true })
    expect(PRIMARY_SUPPLIER_INCLUDE.supplierPrices.take).toBe(1)
  })
})
