import { describe, it, expect, vi } from 'vitest'
import type { LedgerEvent } from '@/lib/ledger-balance'

// buildWastageMap is the smallest builder that converts a movement; the sale and
// prep builders go through the same movementQtyBase call (Task 3 of the plan).
const BUN = { id: 'bun', baseUnit: 'each', dimension: 'COUNT', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const BUN_85 = { ...BUN, eachMeasureQty: '85', eachMeasureUnit: 'g' }
const D = new Date('2026-09-20T00:00:00.000Z')
let rows: unknown[] = []
vi.mock('@/lib/prisma', () => ({ prisma: { wastageLog: { findMany: async () => rows } } }))

const { buildWastageMap } = await import('@/lib/count-expected')

const wastage = (item: typeof BUN, qtyWasted: string, unit: string) => ({
  id: 'w1', inventoryItemId: item.id, qtyWasted, unit, date: D, reason: 'SPOILED', revenueCenterId: 'rc1', inventoryItem: item,
})

describe('buildWastageMap — bridged conversion', () => {
  it('200 g of a bun that weighs 85 g depletes 2.35 buns, not 200', async () => {
    rows = [wastage(BUN_85, '200', 'g')]
    const sink: LedgerEvent[] = []
    const map = await buildWastageMap(new Date(0), ['bun'], null, undefined, undefined, sink)
    expect(map.get('bun')).toBeCloseTo(200 / 85, 9)
    expect(sink[0].qtyBase).toBeCloseTo(-200 / 85, 9)
    expect(sink[0].unbridged).toBeUndefined()
  })
  it('200 g of a bun with NO each-measure depletes nothing and is reported unbridged', async () => {
    rows = [wastage(BUN, '200', 'g')]
    const sink: LedgerEvent[] = []
    const map = await buildWastageMap(new Date(0), ['bun'], null, undefined, undefined, sink)
    expect(map.get('bun')).toBe(0)
    expect(sink[0]).toMatchObject({ type: 'WASTAGE', unbridged: { qty: 200, unit: 'g' } })
    expect(sink[0].qtyBase === 0).toBe(true) // `-0` from the sign flip counts as zero (toMatchObject uses Object.is)
  })
  it('3 each of a bun is still 3 (same dimension, unchanged)', async () => {
    rows = [wastage(BUN, '3', 'each')]
    const map = await buildWastageMap(new Date(0), ['bun'])
    expect(map.get('bun')).toBe(3)
  })
})
