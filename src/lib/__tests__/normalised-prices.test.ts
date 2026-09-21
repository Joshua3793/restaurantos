import { describe, it, expect } from 'vitest'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import type { InventoryMatch, ScanItem } from '@/components/invoices/types'

// Eggplant: a $/lb invoice line against a COUNT item ('each') bridged by a
// 0.4 lb each-measure — the same fixture used across the plan's other tests.
const eggplantMatch = {
  id: 'item-1', itemName: 'Eggplant', baseUnit: 'each', dimension: 'COUNT',
  pricePerBaseUnit: '2.93', purchasePrice: '70.3',
  eachMeasureQty: '0.4', eachMeasureUnit: 'lb',
} as unknown as InventoryMatch

const eggplantLine = {
  id: 'scan-1',
  pricingMode: 'per_weight',
  rate: '3.49',
  rateUOM: 'lb',
  matchedItem: eggplantMatch,
} as unknown as ScanItem

describe('computeNormalisedPrices', () => {
  it('bridges a cross-dimension RATE line ($/lb) against the item each-measure', () => {
    const result = computeNormalisedPrices(eggplantLine)
    expect(result).not.toBeNull()
    expect(result!.invoicePPB).toBeCloseTo(1.396, 2)
    expect(result!.pctDiff).toBeCloseTo(-52, 0)
    expect(result!.inventoryPPB).toBe(2.93)
    expect(result!.baseUnit).toBe('each')
  })

  it('stays null when the item has no each-measure to bridge through (unchanged)', () => {
    const unbridged = {
      ...eggplantLine,
      matchedItem: { ...eggplantMatch, eachMeasureQty: null, eachMeasureUnit: null },
    } as unknown as ScanItem
    expect(computeNormalisedPrices(unbridged)).toBeNull()
  })

  it('same-dimension comparison is unaffected (regression)', () => {
    const kgLine = {
      id: 'scan-2',
      pricingMode: 'per_weight',
      rate: '4.40',
      rateUOM: 'kg',
      matchedItem: {
        id: 'item-2', itemName: 'Flour', baseUnit: 'g', dimension: 'MASS',
        pricePerBaseUnit: '0.0044', purchasePrice: '22',
      } as unknown as InventoryMatch,
    } as unknown as ScanItem
    const result = computeNormalisedPrices(kgLine)
    expect(result).not.toBeNull()
    expect(result!.invoicePPB).toBeCloseTo(0.0044, 5)
  })
})
