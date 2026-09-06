import { describe, it, expect } from 'vitest'
import {
  effectiveUrgency, autoUrgencyOf, effectivePriority, cadenceReason, whyLabel,
  cappedSuggestedQty, suggestedDraftQty, suggestedBatches, longLeadQty, applyStatusToItem,
  mustStartToday, planGroups, planDayContext, START_TODAY_KEY,
} from '../prep-plan'
import type { CadenceStats } from '../prep-cadence'
import type { PrepPriority } from '../prep-utils'

const base = {
  onHand: 8, parLevel: 8, minThreshold: 0, targetToday: null as number | null,
  manualPriorityOverride: null as string | null, unit: 'kg',
  priority: 'LATER' as PrepPriority, suggestedQty: 0,
}
const now = Date.parse('2026-09-06T14:00:00.000Z')
const day = (d: number) => new Date(now - d * 86_400_000).toISOString()
const every3 = (lastDaysAgo: number): CadenceStats => ({
  makes: 4, medianIntervalDays: 3, medianQty: 6, lastMadeAt: day(lastDaysAgo),
  dueByCadenceAt: day(lastDaysAgo - 3), usagePerDayEst: 2,
})

describe('cadence raises an at-par item that is due by its rhythm — and nothing else', () => {
  it('at par, made every 3d, last made 4d ago → Before close with the reason', () => {
    const t = { ...base, cadence: every3(4) }
    expect(autoUrgencyOf(t, now)).toBe('CLOSE')
    expect(effectiveUrgency(t, now)).toBe('CLOSE')
    expect(effectivePriority(t, now)).toBe('NEEDED_TODAY')
    expect(cadenceReason(t, now)).toBe('usually every 3d · last made 4d ago')
    expect(whyLabel({ ...t, shelfLifeDays: 5 }, now)).toBe('at par · 5d shelf life · usually every 3d · last made 4d ago')
  })
  it('not due yet → untouched', () => {
    const t = { ...base, cadence: every3(1) }
    expect(effectiveUrgency(t, now)).toBe('TMRW')
    expect(cadenceReason(t, now)).toBeNull()
    expect(whyLabel(t)).toBe('at par')
  })
  it('a manual step is never nudged', () => {
    const t = { ...base, cadence: every3(4), manualPriorityOverride: 'TMRW' }
    expect(effectiveUrgency(t, now)).toBe('TMRW')
    expect(whyLabel(t)).toBe('chef moved it to tomorrow')
  })
  it('below par is the stock’s call, not the rhythm’s', () => {
    const t = { ...base, onHand: 6, cadence: every3(4) }
    expect(effectiveUrgency(t, now)).toBe('CLOSE')
    expect(cadenceReason(t, now)).toBeNull()
    expect(whyLabel(t)).toBe('below par by 2 kg')
  })
  it('without cadence every helper is the old rule', () => {
    expect(effectiveUrgency({ ...base }, now)).toBe('TMRW')
    expect(effectiveUrgency({ ...base, onHand: 0 }, now)).toBe('PASS')
    expect(effectivePriority({ ...base, onHand: 3 }, now)).toBe('NEEDED_TODAY')
  })
})

describe('the shelf-life cap', () => {
  // par 20, on hand 2 → gap 18; usage 2/d × 2d shelf life → keep 4
  const t = { ...base, onHand: 2, parLevel: 20, shelfLifeDays: 2, cadence: every3(1) }
  it('caps the suggestion at usage × shelf life and says so', () => {
    expect(cappedSuggestedQty(t)).toBe(4)
    expect(suggestedDraftQty(t)).toBe(4)
    expect(whyLabel(t)).toBe('2 kg of 20 kg par — won\'t last service · capped to 2d shelf life')
  })
  it('never below one step', () => {
    expect(suggestedDraftQty({ ...t, cadence: { ...every3(1), usagePerDayEst: 0.1 } })).toBe(0.5)
  })
  it('no cap without a usage estimate or a shelf life', () => {
    expect(suggestedDraftQty({ ...t, cadence: null })).toBe(18)
    expect(suggestedDraftQty({ ...t, shelfLifeDays: null })).toBe(18)
    expect(whyLabel({ ...t, shelfLifeDays: null })).toBe('2 kg of 20 kg par — won\'t last service')
  })
  it('batches round up from the capped figure', () => {
    expect(suggestedBatches({ ...t, linkedRecipe: { baseYieldQty: 5, yieldUnit: 'kg' } })).toBe(1)   // 4 kg → 0.8 → ×1
  })
})

describe('applyStatusToItem keeps the cadence honest after a make', () => {
  it('completing moves last-made to now, so the item is not due again at once', () => {
    const t = { ...base, onHand: 0, priority: '911' as PrepPriority, cadence: every3(4), todayLog: null }
    const next = applyStatusToItem(t, 'DONE', 8)
    expect(next.cadence?.lastMadeAt && Date.parse(next.cadence.lastMadeAt)).toBeGreaterThan(Date.now() - 5_000)
    expect(next.cadence?.dueByCadenceAt && Date.parse(next.cadence.dueByCadenceAt)).toBeGreaterThan(Date.now() + 2.9 * 86_400_000)
    expect(next.priority).toBe('LATER')
  })
  it('an item without cadence gains none', () => {
    const next = applyStatusToItem({ ...base, onHand: 0, todayLog: null }, 'DONE', 8)
    expect('cadence' in next).toBe(false)
  })
})

describe('long-lead promotion — "Start today for …"', () => {
  // Brunch 09:00–16:00; the chef plans at 10:00.
  const ctx = planDayContext([{ timeMinutes: 540, endMinutes: 960 }], 600, now)!
  const mk = (id: string, extra: object = {}) => ({
    ...base, id, name: id, station: 'Prep', category: 'MISC', estimatedPrepTime: null, service: null, ...extra,
  })
  const cure = mk('cure', { activeMinutes: 35, passiveMinutes: 4320, shelfLifeDays: 10, cadence: every3(1) })   // at par → TMRW; 3d lead
  const aioli = mk('aioli', { onHand: 2, activeMinutes: 45, passiveMinutes: 0 })                                // MID, 45 min

  it('a 3-day cure at par must start today for tomorrow; a 45-minute aioli need not', () => {
    expect(mustStartToday(cure, ctx, 600)).toBe(true)
    expect(mustStartToday(aioli, ctx, 600)).toBe(false)
    expect(mustStartToday(cure, null, 600)).toBe(false)
  })
  it('an item already in flight, or with no lead, is not promoted', () => {
    expect(mustStartToday({ ...cure, pipeline: { qty: 1, readyAt: null, stageName: null, remainingActiveMinutes: 15, remainingPassiveMinutes: 0, nextActiveAt: null } }, ctx, 600)).toBe(false)
    expect(mustStartToday(mk('x', { activeMinutes: 0, passiveMinutes: 0 }), ctx, 600)).toBe(false)
  })
  it('a step whose deadline has passed is late, not "start today for"', () => {
    // Critical with doors already open (10:00 > 09:00) — the ladder says late.
    expect(mustStartToday(mk('late', { onHand: 0, activeMinutes: 30, passiveMinutes: 0 }), ctx, 600)).toBe(false)
  })
  it('planGroups lifts them above the steps, captioned with the deadline', () => {
    const gs = planGroups([cure, aioli], 'urgency', { startToday: { ctx, nowMin: 600 } })
    expect(gs.map(g => [g.key, g.rows.map(r => r.id)])).toEqual([[START_TODAY_KEY, ['cure']], ['MID', ['aioli']]])
    expect(gs[0].sub).toBe('lead time runs past the runway · by TMRW 09:00')
    // without the option, the old grouping exactly
    expect(planGroups([cure, aioli], 'urgency').map(g => g.key)).toEqual(['MID', 'TMRW'])
  })
  it('the long-lead seed is the most that will keep, not the par gap', () => {
    expect(longLeadQty(cure)).toBe(20)                                           // 2/d × 10d
    expect(longLeadQty({ ...cure, cadence: null })).toBe(0)                      // unknown → ordinary suggestion (at par)
    expect(longLeadQty({ ...cure, linkedRecipe: { baseYieldQty: 6, yieldUnit: 'kg' } })).toBe(21)   // 20/6 → ×3.5 batches
  })
})
