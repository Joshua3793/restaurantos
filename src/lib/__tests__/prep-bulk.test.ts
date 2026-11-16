import { describe, it, expect } from 'vitest'
import { addAllToMakeIds, snapshotDraft, restorePlan, resetTargets, emptyListIds } from '../prep-bulk'

const pipeline = { qty: 4, readyAt: null, stageName: null, remainingActiveMinutes: 5, remainingPassiveMinutes: 0, nextActiveAt: null }
const item = (name: string, over: Record<string, unknown> = {}) => ({
  id: name, name, category: 'Sauces & Dressings', isOnList: false, prepEnabled: true,
  onHand: 0, parLevel: 4, minThreshold: 0, targetToday: null, manualPriorityOverride: null,
  unit: 'kg', linkedRecipe: { baseYieldQty: 1, yieldUnit: 'kg' }, pipeline: null, todayLog: null as null | Record<string, unknown>,
  ...over,
})

describe('Add all N to make', () => {
  it('addAllToMakeIds never includes a flagged item', () => {
    const kimchi = item('Kimchi', { parLevel: 5000, linkedRecipe: { baseYieldQty: 13.25, yieldUnit: 'kg' } })
    const hollandaise = item('Hollandaise', { parLevel: 4, unit: 'g', linkedRecipe: null })
    const chimi = item('Chimichurri')
    const listed = item('Corn Salsa', { isOnList: true })
    const cooking = item('Focaccia', { pipeline })
    expect(addAllToMakeIds([kimchi, hollandaise, chimi, listed, cooking], null, 600)).toEqual(['Chimichurri'])
  })
})

describe('Undo — the list goes back exactly as it was', () => {
  const before = [
    item('Bacon Jam', { isOnList: true, todayLog: { requiredQty: 12.9, note: 'thick', assignedTo: 'liam', listOrder: 2 } }),
    item('Corn Salsa', { isOnList: true, todayLog: { requiredQty: 2, note: null, assignedTo: null, listOrder: 5 } }),
    item('Hash', { isOnList: false, todayLog: null }),
  ]
  it('snapshot restores every field', () => {
    const snap = snapshotDraft(before)
    const after = [
      item('Bacon Jam', { isOnList: false, todayLog: { requiredQty: 1, note: null, assignedTo: null, listOrder: 9 } }),
      item('Corn Salsa', { isOnList: true, todayLog: { requiredQty: 3, note: null, assignedTo: null, listOrder: 5 } }),
      item('Hash', { isOnList: true, todayLog: { requiredQty: 4, note: null, assignedTo: null, listOrder: 1 } }),
    ]
    expect(restorePlan(after, snap)).toEqual({
      toggles: [{ id: 'Bacon Jam', isOnList: true }, { id: 'Hash', isOnList: false }],
      edits: [
        { id: 'Bacon Jam', patch: { requiredQty: 12.9, note: 'thick', assignedTo: 'liam', listOrder: 2 } },
        { id: 'Corn Salsa', patch: { requiredQty: 2 } },
      ],
    })
  })
  it('nothing changed → nothing to replay', () => {
    expect(restorePlan(before, snapshotDraft(before))).toEqual({ toggles: [], edits: [] })
  })
})

describe('Reset N quantities to suggested', () => {
  it('resetTargets skips equal rows and cooking jobs', () => {
    const changed = item('Chimichurri', { isOnList: true, parLevel: 2, todayLog: { requiredQty: 5 } })   // suggests 2 kg
    const same = item('Corn Salsa', { isOnList: true, parLevel: 2, todayLog: { requiredQty: 2 } })
    const cooking = item('Focaccia', { isOnList: true, pipeline, todayLog: { requiredQty: 9 } })
    expect(resetTargets([changed, same, cooking], null, 600)).toEqual([{ id: 'Chimichurri', from: 5, to: 2 }])
  })
})

describe('Empty the list', () => {
  it('emptyList keeps cooking jobs', () => {
    expect(emptyListIds([item('A', { isOnList: true }), item('B', { isOnList: true, pipeline }), item('C')])).toEqual(['A'])
  })
})
