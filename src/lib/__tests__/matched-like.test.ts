import { describe, it, expect } from 'vitest'
import { matchedLikeOf } from '@/lib/invoice/matched-like'
import type { InventoryMatch } from '@/components/invoices/types'

describe('matchedLikeOf', () => {
  it('maps every field the receiving rule reads, with the same defaults the callers used', () => {
    const m = { id: 'i', itemName: 'Eggplant', pricePerBaseUnit: '0', purchasePrice: '0', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
      eachMeasureQty: '181.4368', eachMeasureUnit: 'g', densityGPerMl: null } as unknown as InventoryMatch
    expect(matchedLikeOf(m)).toEqual({
      dimension: 'COUNT', baseUnit: 'each', packChain: m.packChain, pricing: m.pricing, countUnit: null,
      eachMeasureQty: '181.4368', eachMeasureUnit: 'g', densityGPerMl: null,
    })
  })
})
