import { describe, it, expect, vi, beforeEach } from 'vitest'
const db = vi.hoisted(() => ({
  countLine: { count: vi.fn() }, inventorySnapshot: { count: vi.fn() }, invoiceScanItem: { count: vi.fn() },
  recipeIngredient: { count: vi.fn(), findMany: vi.fn() }, wastageLog: { count: vi.fn() }, stockTransfer: { count: vi.fn() },
  inventorySupplierPrice: { count: vi.fn() }, inventoryItem: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
import { itemHistory, hasHistory, bridgeUsedBy } from '@/lib/item-history'

const zero = () => { for (const t of Object.values(db)) for (const f of Object.values(t)) (f as ReturnType<typeof vi.fn>).mockReset() }

describe('itemHistory / hasHistory', () => {
  beforeEach(zero)
  it('counts every table once and reports no history for a fresh item with one box', async () => {
    for (const t of ['countLine', 'inventorySnapshot', 'invoiceScanItem', 'recipeIngredient', 'wastageLog', 'stockTransfer'] as const) db[t].count.mockResolvedValue(0)
    db.inventorySupplierPrice.count.mockResolvedValue(1)
    const h = await itemHistory('i1')
    expect(h).toEqual({ counts: 0, snapshots: 0, receipts: 0, recipeLines: 0, wastage: 0, transfers: 0, offers: 1 })
    expect(hasHistory(h)).toBe(false)
  })
  it('one count line is history; two boxes are history', () => {
    const base = { counts: 0, snapshots: 0, receipts: 0, recipeLines: 0, wastage: 0, transfers: 0, offers: 0 }
    expect(hasHistory({ ...base, counts: 1 })).toBe(true)
    expect(hasHistory({ ...base, offers: 2 })).toBe(true)
    expect(hasHistory({ ...base, offers: 1 })).toBe(false)
  })
})

describe('bridgeUsedBy — recipes that only cost through the each-measure', () => {
  beforeEach(zero)
  it('lists recipes using a per-each item by weight, not the ones using it by each', async () => {
    db.inventoryItem.findUnique.mockResolvedValue({ baseUnit: 'each', dimension: 'COUNT' })
    db.recipeIngredient.findMany.mockResolvedValue([
      { unit: 'g', recipe: { id: 'r1', name: 'Burger', type: 'MENU' } },
      { unit: 'each', recipe: { id: 'r2', name: 'Bun basket', type: 'MENU' } },
      { unit: 'kg', recipe: { id: 'r3', name: 'Stuffing', type: 'PREP' } },
    ])
    const r = await bridgeUsedBy('bun')
    expect(r.map(x => x.id)).toEqual(['r1', 'r3'])
  })
  it('a by-weight item used by count lists those recipes', async () => {
    db.inventoryItem.findUnique.mockResolvedValue({ baseUnit: 'g', dimension: 'MASS' })
    db.recipeIngredient.findMany.mockResolvedValue([{ unit: 'each', recipe: { id: 'r9', name: 'Loaf plate', type: 'MENU' } }])
    expect((await bridgeUsedBy('loaf')).map(x => x.id)).toEqual(['r9'])
  })
})
