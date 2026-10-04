import { describe, it, expect, vi } from 'vitest'

// `undoBlocker` judges a merge undo from "since the merge" facts read through
// the client it is handed — a fake one here, so no database is needed.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/count-expected', () => ({ getTheoreticalBalanceMap: async () => new Map() }))

const { undoBlocker } = await import('@/lib/item-merge-exec')

const MERGED_AT = new Date('2026-10-01T10:00:00.000Z')
const MERGE = {
  survivorId: 'surv', absorbedId: 'abs', mergedAt: MERGED_AT,
  manifest: { survivorId: 'surv', absorbedId: 'abs', ops: [] },
}

function fakeDb(over: { remeasures?: number; laterMerges?: number } = {}) {
  const itemRemeasureCount = vi.fn(async (_a: unknown) => over.remeasures ?? 0)
  const db = {
    invoiceScanItem: { count: async () => 0 },
    countLine: { count: async () => 0 },
    recipe: { count: async () => 0 },
    inventoryItem: { findUnique: async () => ({ isActive: false, mergedIntoId: 'surv' }) },
    itemMerge: { count: async () => over.laterMerges ?? 0 },
    itemRemeasure: { count: itemRemeasureCount },
  }
  return { db: db as never, itemRemeasureCount }
}

describe('merge undoBlocker', () => {
  it('null when nothing has happened since the merge', async () => {
    expect(await undoBlocker(fakeDb().db, MERGE)).toBeNull()
  })

  it('refuses once the survivor was re-measured since the merge', async () => {
    const { db, itemRemeasureCount } = fakeDb({ remeasures: 1 })
    expect(await undoBlocker(db, MERGE)).toBe('Its measure was changed since the merge — undo that first.')
    expect(itemRemeasureCount).toHaveBeenCalledWith({
      where: { itemId: 'surv', undoneAt: null, changedAt: { gte: MERGED_AT } },
    })
  })

  it('a later merge is still reported first', async () => {
    expect(await undoBlocker(fakeDb({ remeasures: 1, laterMerges: 1 }).db, MERGE))
      .toBe('Another item was merged in after this one — undo that one first.')
  })
})
