import { describe, it, expect } from 'vitest'
import { keepBridgedRate } from '@/lib/item-model-form'
import type { Pricing } from '@/lib/item-model'

// A bridged RATE the edit form's dimension-limited dropdown can load but
// cannot faithfully round-trip: $/lb pricing on a COUNT ('each') item.
const storedBridgedRate: Pricing = { mode: 'RATE', rate: 5.25, rateUnit: 'lb' }

describe('keepBridgedRate', () => {
  it('keeps the stored pricing when only rateUnit differs (same rate number) — the form artifact', () => {
    // The edit form's "Per" dropdown for a COUNT item only offers 'each', so an
    // unmodified save round-trips the rate number but coerces the unit.
    const incoming: Pricing = { mode: 'RATE', rate: 5.25, rateUnit: 'each' }
    expect(keepBridgedRate(storedBridgedRate, incoming)).toBe(true)
  })

  it('keeps the stored pricing when nothing at all differs', () => {
    expect(keepBridgedRate(storedBridgedRate, { mode: 'RATE', rate: 5.25, rateUnit: 'lb' })).toBe(true)
  })

  it('lets a genuine rate change through — the user is deliberately re-pricing', () => {
    const incoming: Pricing = { mode: 'RATE', rate: 6.00, rateUnit: 'each' }
    expect(keepBridgedRate(storedBridgedRate, incoming)).toBe(false)
  })

  it('lets a mode switch through — the user is deliberately re-pricing by case', () => {
    const incoming: Pricing = { mode: 'PACK', purchasePrice: 46.40 }
    expect(keepBridgedRate(storedBridgedRate, incoming)).toBe(false)
  })

  it('is false when the stored pricing was never a RATE — nothing to protect', () => {
    const storedPack: Pricing = { mode: 'PACK', purchasePrice: 70.3 }
    expect(keepBridgedRate(storedPack, { mode: 'PACK', purchasePrice: 70.3 })).toBe(false)
    expect(keepBridgedRate(storedPack, { mode: 'RATE', rate: 1, rateUnit: 'each' })).toBe(false)
  })
})
