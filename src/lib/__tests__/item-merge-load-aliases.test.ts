import { describe, it, expect, vi } from 'vitest'

// `loadMergeInputs` reads every relation through the client it is handed — a
// fake one here, so the W9 wording facts can be checked without a database.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/count-expected', () => ({ getTheoreticalBalanceMap: async () => new Map() }))

const { loadMergeInputs } = await import('@/lib/item-merge-exec')

const item = (id: string, itemName: string) => ({
  id, itemName, isActive: true, mergedIntoId: null, stockOnHand: 0, lastCountDate: null,
  dimension: 'MASS', baseUnit: 'g', countUnit: 'kg', packChain: [{ unit: 'case', per: 1000 }],
  pricing: { mode: 'PACK', purchasePrice: 10 }, eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  recipe: null, countLines: [],
})

const OFFER = {
  id: 'oA', inventoryItemId: 'A', supplierId: 'sysco', supplierName: 'Sysco', isPrimary: true,
  lastUpdated: new Date('2026-09-01T00:00:00.000Z'),
}

function fakeDb(o: { taken: boolean; offers?: unknown[] }) {
  const findUnique = vi.fn(async (_a: unknown) => (o.taken ? { id: 'held' } : null))
  const aliasFindMany = vi.fn(async (a: { where: { inventoryItemId: string } }) =>
    a.where.inventoryItemId === 'A' ? [{ id: 'al1' }, { id: 'al2' }] : [])
  const empty = { findMany: async () => [], findFirst: async () => null }
  const db = new Proxy({
    inventoryItem: {
      findUnique: async (a: { where: { id: string } }) => (a.where.id === 'S' ? item('S', 'Kennebec Potato') : item('A', 'POTATO KENNEBEC O/S')),
      findMany: async () => [],
    },
    inventorySupplierPrice: {
      findMany: async (a: { where: { inventoryItemId: string } }) => (a.where.inventoryItemId === 'A' ? (o.offers ?? [OFFER]) : []),
    },
    itemSupplierAlias: { findMany: aliasFindMany, findUnique },
  } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? empty })
  return { db, findUnique, aliasFindMany }
}

describe('loadMergeInputs — supplier wordings', () => {
  it("loads the absorbed item's wordings and asks whether its primary supplier already has the old name", async () => {
    const { db, findUnique } = fakeDb({ taken: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = await loadMergeInputs('S', 'A', db as any, { survivor: 0, absorbed: 0 })
    expect(inputs?.rel.aliasIds).toEqual(['al1', 'al2'])
    expect(inputs?.rel.nameAliasTaken).toBe(false)
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { supplierId_text: { supplierId: 'sysco', text: 'potato kennebec o s' } },
    }))
  })

  it('reports the wording as taken when an alias already holds that key', async () => {
    const { db } = fakeDb({ taken: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = await loadMergeInputs('S', 'A', db as any, { survivor: 0, absorbed: 0 })
    expect(inputs?.rel.nameAliasTaken).toBe(true)
  })

  it('does not look anything up when the absorbed item has no primary box', async () => {
    const { db, findUnique } = fakeDb({ taken: true, offers: [{ ...OFFER, isPrimary: false }] })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = await loadMergeInputs('S', 'A', db as any, { survivor: 0, absorbed: 0 })
    expect(findUnique).not.toHaveBeenCalled()
    expect(inputs?.rel.nameAliasTaken).toBe(false)
  })
})
