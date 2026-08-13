import { describe, it, expect } from 'vitest'
import {
  effectivePriority, autoPriority, prepStep, roundPrepQty,
  suggestedDraftQty, whyLabel, applyStatusToItem, draftQty,
} from '../prep-plan'
import type { PrepPriority } from '../prep-utils'

const base = {
  onHand: 0, parLevel: 8, minThreshold: 0, targetToday: null as number | null,
  manualPriorityOverride: null as string | null, unit: 'kg',
  priority: '911' as PrepPriority, suggestedQty: 8,
  todayLog: null as { status: string; actualPrepQty: number | null } | null,
}

describe('effectivePriority', () => {
  it('stock out → 911', () => expect(effectivePriority({ ...base })).toBe('911'))
  it('under target → 911 even when above par', () =>
    expect(effectivePriority({ ...base, onHand: 9, targetToday: 12 })).toBe('911'))
  it('below par → NEEDED_TODAY', () =>
    expect(effectivePriority({ ...base, onHand: 3 })).toBe('NEEDED_TODAY'))
  it('at par → LATER', () => expect(effectivePriority({ ...base, onHand: 8 })).toBe('LATER'))
  it('override wins', () =>
    expect(effectivePriority({ ...base, onHand: 8, manualPriorityOverride: '911' })).toBe('911'))
  it('autoPriority ignores the override', () =>
    expect(autoPriority({ ...base, onHand: 8, manualPriorityOverride: '911' })).toBe('LATER'))
})

describe('steps + rounding', () => {
  it('kg/L step 0.5, g/ml step 25, count units step 1', () => {
    expect(prepStep('kg')).toBe(0.5)
    expect(prepStep('L')).toBe(0.5)
    expect(prepStep('g')).toBe(25)
    expect(prepStep('ml')).toBe(25)
    expect(prepStep('each')).toBe(1)
    expect(prepStep('batch')).toBe(1)
  })
  it('roundPrepQty snaps to the step', () => {
    expect(roundPrepQty(6.3, 'kg')).toBe(6.5)
    expect(roundPrepQty(1740, 'g')).toBe(1750)
    expect(roundPrepQty(4.4, 'each')).toBe(4)
  })
  it('suggestedDraftQty: 0 when at/above par, else rounded and at least one step', () => {
    expect(suggestedDraftQty({ ...base, onHand: 8 })).toBe(0)
    expect(suggestedDraftQty({ ...base, onHand: 7.9 })).toBe(0.5) // raw 0.1 → floor to step
    expect(suggestedDraftQty({ ...base, onHand: 1.8 })).toBe(6)   // raw 6.2 → 6.0
  })
})

describe('whyLabel', () => {
  it('names the reason', () => {
    expect(whyLabel({ ...base })).toBe('stock out')
    expect(whyLabel({ ...base, onHand: 9, targetToday: 12 })).toBe("under today's target 12 kg")
    expect(whyLabel({ ...base, onHand: 3 })).toBe('below par by 5 kg')
    expect(whyLabel({ ...base, onHand: 8 })).toBe('at par')
    expect(whyLabel({ ...base, manualPriorityOverride: 'LATER' })).toBe('chef override')
  })
})

describe('applyStatusToItem — the stale-pill fix', () => {
  it('completing credits onHand, clears the override, recomputes priority + suggestion', () => {
    const item = { ...base, onHand: 0, manualPriorityOverride: '911' }
    const next = applyStatusToItem(item, 'DONE', 9)
    expect(next.onHand).toBe(9)
    expect(next.manualPriorityOverride).toBeNull()
    expect(next.priority).toBe('LATER') // was Critical, now above par
    expect(next.suggestedQty).toBe(0)
  })
  it('PARTIAL below par lands on NEEDED_TODAY, not the old 911', () => {
    const next = applyStatusToItem({ ...base }, 'PARTIAL', 3)
    expect(next.priority).toBe('NEEDED_TODAY')
    expect(next.suggestedQty).toBe(5)
  })
  it('re-logging a completed item applies only the qty delta', () => {
    const item = { ...base, onHand: 9, todayLog: { status: 'DONE', actualPrepQty: 9 } }
    const next = applyStatusToItem(item, 'DONE', 6)
    expect(next.onHand).toBe(6)
  })
  it('reopening a done item takes its credit back', () => {
    const item = { ...base, onHand: 9, priority: 'LATER' as PrepPriority, todayLog: { status: 'DONE', actualPrepQty: 9 } }
    const next = applyStatusToItem(item, 'IN_PROGRESS')
    expect(next.onHand).toBe(0)
    expect(next.priority).toBe('911')
  })
  it('plain start does not move stock', () => {
    const next = applyStatusToItem({ ...base, onHand: 3 }, 'IN_PROGRESS')
    expect(next.onHand).toBe(3)
    expect(next.priority).toBe('NEEDED_TODAY')
  })
})

describe('draftQty', () => {
  it('prefers the chef-set requiredQty (Decimal-as-string safe), else the rounded suggestion', () => {
    expect(draftQty({
      ...base, onHand: 1.8,
      todayLog: { status: 'NOT_STARTED', actualPrepQty: null, requiredQty: '4.5' as unknown as number },
    })).toBe(4.5)
    expect(draftQty({ ...base, onHand: 1.8 })).toBe(6)
  })
})
