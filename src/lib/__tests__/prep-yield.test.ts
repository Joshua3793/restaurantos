import { describe, it, expect } from 'vitest'
import {
  BATCH_STEP, BATCH_MAX, fmtBatches, clampBatches, snapBatches, stepBatches,
  plannedQty, yieldPrefill, yieldStatus, yieldWarning, round2, isCompleteStatus, type YieldItem,
} from '../prep-yield'
import { defaultDraftQty } from '../prep-plan'
import { validatePrepQty } from '../prep-utils'

// A 6 l recipe counted in litres: one batch = 6 l. Par 7.5 l with nothing on hand → the
// planner suggests 7.5 l (suggestedQty on an API row is always cappedSuggestedQty of the
// same fields — keep the fixture consistent) → planned ×1.5 = 9 l.
const adobo: YieldItem = {
  onHand: 0, parLevel: 7.5, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'l',
  suggestedQty: 7.5,
  linkedRecipe: { baseYieldQty: 6, yieldUnit: 'l' },
}
// No recipe: batches don't apply.
const plain: YieldItem = {
  onHand: 0, parLevel: 3, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'kg',
  suggestedQty: 3, linkedRecipe: null,
}

describe('constants', () => {
  it('is a quarter-step 0–10 scale', () => {
    expect(BATCH_STEP).toBe(0.25)
    expect(BATCH_MAX).toBe(10)
  })
})

describe('fmtBatches', () => {
  it('drops trailing zeros and keeps an off-grid count exact', () => {
    expect(fmtBatches(1)).toBe('×1')
    expect(fmtBatches(1.25)).toBe('×1.25')
    expect(fmtBatches(1.5)).toBe('×1.5')
    expect(fmtBatches(1.1333)).toBe('×1.13')
    expect(fmtBatches(12)).toBe('×12')
  })
})

describe('clampBatches / snapBatches', () => {
  it('clamps to the scale', () => {
    expect(clampBatches(-1)).toBe(0)
    expect(clampBatches(12)).toBe(10)
    expect(clampBatches(3.25)).toBe(3.25)
  })
  it('snaps to the nearest quarter', () => {
    expect(snapBatches(1.25)).toBe(1.25)
    expect(snapBatches(1.13)).toBe(1.25)
    expect(snapBatches(1.12)).toBe(1)
    expect(snapBatches(12)).toBe(10)
  })
})

describe('stepBatches', () => {
  it('steps a quarter from an on-grid value and clamps at both ends', () => {
    expect(stepBatches(1.25, 1)).toBe(1.5)
    expect(stepBatches(1.25, -1)).toBe(1)
    expect(stepBatches(10, 1)).toBe(10)
    expect(stepBatches(0, -1)).toBe(0)
  })
  it('snaps an off-grid (typed) value first, then steps', () => {
    expect(stepBatches(1.13, 1)).toBe(1.5)
    expect(stepBatches(1.13, -1)).toBe(1)
  })
  it('a typed overflow above 10 lands on 10 from either button', () => {
    expect(stepBatches(12, -1)).toBe(10)
    expect(stepBatches(12, 1)).toBe(10)
  })
})

describe('plannedQty', () => {
  it('is the half-batch-ceiled suggestion for a batch item — identical to the planner seed', () => {
    expect(plannedQty(adobo)).toBe(9)
    expect(plannedQty(adobo)).toBe(defaultDraftQty(adobo))
  })
  it('is suggestedQty for a non-batch item', () => {
    expect(plannedQty(plain)).toBe(3)
  })
  it('is the quantity the chef posted on the live log when there is one', () => {
    expect(plannedQty({ ...adobo, todayLog: { status: 'IN_PROGRESS', actualPrepQty: null, requiredQty: 5.5 } })).toBe(5.5)
    expect(plannedQty({ ...plain, todayLog: { status: 'NOT_STARTED', actualPrepQty: null, requiredQty: 0 } })).toBe(3)
  })
})

describe('yieldPrefill', () => {
  it('the logged amount wins when reopening a done item', () => {
    const done = { ...adobo, todayLog: { status: 'DONE', actualPrepQty: 4 } }
    expect(yieldPrefill(done, 12)).toBe(4)
  })
  it('the cook-along yield beats the plan', () => {
    expect(yieldPrefill(adobo, 12)).toBe(12)
  })
  it('falls back to the plan, then to zero', () => {
    expect(yieldPrefill(adobo, null)).toBe(9)
    expect(yieldPrefill(adobo, 0)).toBe(9)
    expect(yieldPrefill({ ...plain, suggestedQty: 0 }, null)).toBe(0)
  })
  it('ignores an unfinished log', () => {
    const open = { ...adobo, todayLog: { status: 'IN_PROGRESS', actualPrepQty: 4 } }
    expect(yieldPrefill(open, null)).toBe(9)
  })
  it('prefills the posted quantity ahead of the stock suggestion', () => {
    expect(yieldPrefill({ ...adobo, todayLog: { status: 'IN_PROGRESS', actualPrepQty: null, requiredQty: 5.5 } }, null)).toBe(5.5)
  })
})

describe('yieldStatus', () => {
  it('at or above plan is Done, a hundredth under is Partial', () => {
    expect(yieldStatus(9, 9)).toBe('DONE')
    expect(yieldStatus(9.5, 9)).toBe('DONE')
    expect(yieldStatus(8.99, 9)).toBe('PARTIAL')
  })
  it('a plan of zero is Done for any positive amount', () => {
    expect(yieldStatus(0.5, 0)).toBe('DONE')
  })
})

describe('yieldWarning', () => {
  it('agrees with the server guard on both sides of the 50-batch line', () => {
    // 49 batches of 6 l = 294 l → fine; 50 batches = 300 l → the unit-mix-up message.
    expect(yieldWarning(294, adobo)).toBeNull()
    expect(yieldWarning(300, adobo)).toBe(validatePrepQty(300, 'l', 'l', 6))
    expect(yieldWarning(300, adobo)).toMatch(/unit mix-up/)
  })
  it('is silent without a recipe or at zero', () => {
    expect(yieldWarning(300000, plain)).toBeNull()
    expect(yieldWarning(0, adobo)).toBeNull()
  })
})

describe('round2 / isCompleteStatus', () => {
  it('rounds to the cent so status is judged on what is stored', () => {
    expect(round2(5.495)).toBe(5.5)
    expect(yieldStatus(round2(5.495), 5.5)).toBe('DONE')
  })
  it('isCompleteStatus', () => {
    expect(isCompleteStatus('DONE')).toBe(true)
    expect(isCompleteStatus('PARTIAL')).toBe(true)
    expect(isCompleteStatus('IN_PROGRESS')).toBe(false)
    expect(isCompleteStatus(null)).toBe(false)
  })
})
