import { describe, it, expect } from 'vitest'
import { snapshotLines, type ItemTemplate } from '../checklists/snapshot'
import { applyLine } from '../checklists/apply-line'

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
      items: [item({ id: 'a', title: 'Fryer oil level', howTo: 'Dipstick', isBlocker: true, answer: 'NUMBER', unit: 'cm', safeMin: '2', safeMax: '9' })],
    }]
    expect(snapshotLines('r1', cats, '2026-10-28')[0]).toEqual({
      runId: 'r1', itemId: 'a', categoryName: 'Fridge', title: 'Fryer oil level', howTo: 'Dipstick',
      isBlocker: true, answer: 'NUMBER', unit: 'cm', safeMin: '2', safeMax: '9', tempUnitId: null, sortOrder: 0,
    })
  })

  it('a TEMP item takes its range from the Temps unit, in °C (the item stores none)', () => {
    const cats = [{
      name: 'Fridge', sortOrder: 0, isActive: true,
      items: [item({
        id: 'a', title: 'Walk-in temp', howTo: 'Probe', isBlocker: true, answer: 'TEMP',
        unit: null, safeMin: null, safeMax: null, tempUnitId: 't1', tempUnit: { safeMin: 0, safeMax: 4 },
      })],
    }]
    const line = snapshotLines('r1', cats, '2026-10-28')[0]
    expect(line).toEqual({
      runId: 'r1', itemId: 'a', categoryName: 'Fridge', title: 'Walk-in temp', howTo: 'Probe',
      isBlocker: true, answer: 'TEMP', unit: '°C', safeMin: 0, safeMax: 4, tempUnitId: 't1', sortOrder: 0,
    })
    // The frozen range flags a walk-in at 9 °C.
    const out = applyLine(
      { answer: line.answer, safeMin: Number(line.safeMin), safeMax: Number(line.safeMax) },
      { action: 'value', raw: '9' }, { id: 'u1', name: 'Sam' }, new Date('2026-10-28T15:00:00Z'),
    )
    expect(out).toMatchObject({ data: { status: 'FLAGGED', flagReason: 'OUT_OF_RANGE', value: 9 } })
    const ok = applyLine(
      { answer: line.answer, safeMin: Number(line.safeMin), safeMax: Number(line.safeMax) },
      { action: 'value', raw: '3' }, { id: 'u1', name: 'Sam' }, new Date('2026-10-28T15:00:00Z'),
    )
    expect(ok).toMatchObject({ data: { status: 'DONE', flagReason: null } })
  })

  it('a TEMP item whose Temps unit has no range (or is gone) gets an open range', () => {
    const cats = [{
      name: 'Fridge', sortOrder: 0, isActive: true,
      items: [
        item({ id: 'a', answer: 'TEMP', tempUnitId: 't1', tempUnit: { safeMin: null, safeMax: '-15' } }),
        item({ id: 'b', answer: 'TEMP', tempUnitId: null, tempUnit: null }),
      ],
    }]
    const [a, b] = snapshotLines('r1', cats, '2026-10-28')
    expect([a.unit, a.safeMin, a.safeMax]).toEqual(['°C', null, '-15'])
    expect([b.unit, b.safeMin, b.safeMax]).toEqual(['°C', null, null])
  })
})
