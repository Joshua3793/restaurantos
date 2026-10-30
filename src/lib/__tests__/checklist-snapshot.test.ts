import { describe, it, expect } from 'vitest'
import { snapshotLines, type ItemTemplate } from '../checklists/snapshot'

const item = (over: Partial<ItemTemplate> & { id: string }): ItemTemplate => ({
  title: over.id, howTo: null, isBlocker: false, answer: 'TICK', unit: null,
  safeMin: null, safeMax: null, tempUnitId: null, days: 127, sortOrder: 0, isActive: true,
  ...over,
})

describe('snapshotLines', () => {
  it('skips items whose days miss the date (Wed-only: skipped Thu, kept Wed)', () => {
    const cats = [{ name: 'Line', sortOrder: 0, isActive: true, items: [item({ id: 'a', days: 4 })] }]
    expect(snapshotLines('r1', cats, '2026-10-29')).toHaveLength(0) // Thursday
    expect(snapshotLines('r1', cats, '2026-10-28')).toHaveLength(1) // Wednesday
  })

  it('skips inactive categories and inactive items', () => {
    const cats = [
      { name: 'Off', sortOrder: 0, isActive: false, items: [item({ id: 'a' })] },
      { name: 'On', sortOrder: 1, isActive: true, items: [item({ id: 'b', isActive: false }), item({ id: 'c' })] },
    ]
    expect(snapshotLines('r1', cats, '2026-10-28').map(l => l.itemId)).toEqual(['c'])
  })

  it('orders by category then item sortOrder and renumbers 0..n-1; copies categoryName', () => {
    const cats = [
      { name: 'Second', sortOrder: 2, isActive: true, items: [item({ id: 'c', sortOrder: 0 })] },
      { name: 'First', sortOrder: 1, isActive: true, items: [item({ id: 'b', sortOrder: 5 }), item({ id: 'a', sortOrder: 1 })] },
    ]
    const out = snapshotLines('r1', cats, '2026-10-28')
    expect(out.map(l => l.itemId)).toEqual(['a', 'b', 'c'])
    expect(out.map(l => l.sortOrder)).toEqual([0, 1, 2])
    expect(out.map(l => l.categoryName)).toEqual(['First', 'First', 'Second'])
    expect(out.every(l => l.runId === 'r1')).toBe(true)
  })

  it('copies the item fields as they are', () => {
    const cats = [{
      name: 'Fridge', sortOrder: 0, isActive: true,
      items: [item({ id: 'a', title: 'Walk-in temp', howTo: 'Probe', isBlocker: true, answer: 'TEMP', unit: '°C', safeMin: '0', safeMax: '4', tempUnitId: 't1' })],
    }]
    expect(snapshotLines('r1', cats, '2026-10-28')[0]).toEqual({
      runId: 'r1', itemId: 'a', categoryName: 'Fridge', title: 'Walk-in temp', howTo: 'Probe',
      isBlocker: true, answer: 'TEMP', unit: '°C', safeMin: '0', safeMax: '4', tempUnitId: 't1', sortOrder: 0,
    })
  })
})
