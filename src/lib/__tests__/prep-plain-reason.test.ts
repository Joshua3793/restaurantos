import { describe, it, expect } from 'vitest'
import { plainReason, type PlanFields } from '../prep-plan'

const base: PlanFields = { onHand: 0, parLevel: 4, minThreshold: 0, targetToday: null, manualPriorityOverride: null, unit: 'kg' }

describe('plainReason — the planner card says it in a cook’s words', () => {
  it('out of stock, without the shortfall arithmetic', () => {
    expect(plainReason({ ...base, shortfall: 18387.5, lastCountDate: '2026-07-31' })).toBe('Out of stock')
  })
  it('names a short ingredient', () => {
    expect(plainReason({ ...base, blockedReason: 'Low stock: Butter Unsalted' })).toBe('Out of stock · low on Butter Unsalted')
  })
  it("won't last", () => {
    expect(plainReason({ ...base, onHand: 1.5 })).toBe("1.5 kg of 4 kg — won't last service")
  })
  it('below par', () => {
    expect(plainReason({ ...base, onHand: 3 })).toBe('Below par by 1 kg')
  })
  it('under today’s target', () => {
    expect(plainReason({ ...base, onHand: 3, targetToday: 3.5 })).toBe("Under today's target of 3.5 kg")
  })
  it('a chef override does not replace the stock reason', () => {
    expect(plainReason({ ...base, onHand: 5, manualPriorityOverride: 'PASS' })).toBe('At par')
  })
})
