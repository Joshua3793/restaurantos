import { describe, it, expect } from 'vitest'
import {
  effectivePriority, autoPriority, effectiveUrgency, prepStep, roundPrepQty,
  suggestedDraftQty, whyLabel, applyStatusToItem, draftQty,
  batchYield, batchCount, batchesToQty, suggestedBatches, fmtBatch, batchLabel,
  planDayContext, urgencyDeadline, fmtDeadline, planSchedule, stationLoad, planGroups,
  isLiveLog, pickLiveLogs, type LiveLogRow, undoDraftFlag,
} from '../prep-plan'
import { autoUrgency, normalizeUrgency, urgencyToPriority, type PrepPriority } from '../prep-utils'
import { fmtClock } from '../prep-runsheet'

const base = {
  onHand: 0, parLevel: 8, minThreshold: 0, targetToday: null as number | null,
  manualPriorityOverride: null as string | null, unit: 'kg',
  priority: '911' as PrepPriority, suggestedQty: 8,
  todayLog: null as { status: string; actualPrepQty: number | null } | null,
}

describe('the one urgency scale', () => {
  it('stock out → PASS', () => expect(autoUrgency(0, 8, null)).toBe('PASS'))
  it('under target → PASS even when above par', () => expect(autoUrgency(9, 8, 12)).toBe('PASS'))
  it('under half par → MID (dies mid-service)', () => expect(autoUrgency(3, 8, null)).toBe('MID'))
  it('below par but above half → CLOSE', () => expect(autoUrgency(5, 8, null)).toBe('CLOSE'))
  it('at par → TMRW', () => expect(autoUrgency(8, 8, null)).toBe('TMRW'))
  it('override wins and legacy tokens normalize', () => {
    expect(effectiveUrgency({ ...base, onHand: 8, manualPriorityOverride: 'PASS' })).toBe('PASS')
    expect(normalizeUrgency('911')).toBe('PASS')
    expect(normalizeUrgency('NEEDED_TODAY')).toBe('CLOSE')
    expect(normalizeUrgency('LATER')).toBe('TMRW')
    expect(normalizeUrgency('garbage')).toBeNull()
  })
})

describe('priority is a collapse of urgency — legacy consumers unchanged', () => {
  it('PASS→911, MID/CLOSE→NEEDED_TODAY, TMRW→LATER', () => {
    expect(urgencyToPriority('PASS')).toBe('911')
    expect(urgencyToPriority('MID')).toBe('NEEDED_TODAY')
    expect(urgencyToPriority('CLOSE')).toBe('NEEDED_TODAY')
    expect(urgencyToPriority('TMRW')).toBe('LATER')
  })
  it('reproduces the old computePriority outcomes exactly', () => {
    expect(effectivePriority({ ...base })).toBe('911')                       // stock out
    expect(effectivePriority({ ...base, onHand: 9, targetToday: 12 })).toBe('911') // under target
    expect(effectivePriority({ ...base, onHand: 3 })).toBe('NEEDED_TODAY')   // below half par
    expect(effectivePriority({ ...base, onHand: 6 })).toBe('NEEDED_TODAY')   // below par
    expect(effectivePriority({ ...base, onHand: 8 })).toBe('LATER')          // at par
  })
  it('urgency override tokens collapse for legacy readers; autoPriority ignores them', () => {
    expect(effectivePriority({ ...base, onHand: 8, manualPriorityOverride: 'MID' })).toBe('NEEDED_TODAY')
    expect(effectivePriority({ ...base, onHand: 8, manualPriorityOverride: '911' })).toBe('911')
    expect(autoPriority({ ...base, onHand: 8, manualPriorityOverride: 'PASS' })).toBe('LATER')
  })
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
    expect(suggestedDraftQty({ ...base, onHand: 7.9 })).toBe(0.5)
    expect(suggestedDraftQty({ ...base, onHand: 1.8 })).toBe(6)
  })
})

describe('whyLabel — read-only evidence', () => {
  it('names the stock condition', () => {
    expect(whyLabel({ ...base })).toBe('stock out')
    expect(whyLabel({ ...base, onHand: 9, targetToday: 12 })).toBe("under today's target 12 kg")
    expect(whyLabel({ ...base, onHand: 3 })).toBe("3 kg of 8 kg par — won't last service")
    expect(whyLabel({ ...base, onHand: 6 })).toBe('below par by 2 kg')
    expect(whyLabel({ ...base, onHand: 8 })).toBe('at par')
    expect(whyLabel({ ...base, onHand: 8, shelfLifeDays: 5 })).toBe('at par · 5d shelf life')
    expect(whyLabel({ ...base, manualPriorityOverride: 'TMRW' })).toBe('chef moved it to tomorrow')
  })
})

describe('applyStatusToItem — the stale-pill fix', () => {
  it('completing credits onHand, clears the override, recomputes priority + suggestion', () => {
    const item = { ...base, onHand: 0, manualPriorityOverride: 'PASS' }
    const next = applyStatusToItem(item, 'DONE', 9)
    expect(next.onHand).toBe(9)
    expect(next.manualPriorityOverride).toBeNull()
    expect(next.priority).toBe('LATER')
    expect(next.suggestedQty).toBe(0)
  })
  it('PARTIAL below par lands on NEEDED_TODAY, not the old 911', () => {
    const next = applyStatusToItem({ ...base }, 'PARTIAL', 3)
    expect(next.priority).toBe('NEEDED_TODAY')
    expect(next.suggestedQty).toBe(5)
  })
  it('re-logging a completed item applies only the qty delta', () => {
    const item = { ...base, onHand: 9, todayLog: { status: 'DONE', actualPrepQty: 9 } }
    expect(applyStatusToItem(item, 'DONE', 6).onHand).toBe(6)
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

describe('batches', () => {
  const withRecipe = { ...base, linkedRecipe: { baseYieldQty: 5, yieldUnit: 'kg' } }
  it('batchYield converts the recipe base into the item unit', () => {
    expect(batchYield(withRecipe)).toBe(5)
    expect(batchYield({ ...base, unit: 'g', linkedRecipe: { baseYieldQty: 2, yieldUnit: 'kg' } })).toBe(2000)
  })
  it('no batches without a usable base yield', () => {
    expect(batchYield({ ...base })).toBeNull()
    expect(batchYield({ ...base, linkedRecipe: { baseYieldQty: 0, yieldUnit: 'kg' } })).toBeNull()
    expect(batchYield({ ...base, unit: 'batch', linkedRecipe: { baseYieldQty: 5, yieldUnit: 'kg' } })).toBeNull()
    expect(batchYield({ ...base, unit: 'each', linkedRecipe: { baseYieldQty: 5, yieldUnit: 'kg' } })).toBeNull()
  })
  it('count/convert round-trips', () => {
    expect(batchCount(withRecipe, 7.5)).toBe(1.5)
    expect(batchesToQty(withRecipe, 1.5)).toBe(7.5)
    expect(batchLabel(withRecipe, 7.5)).toBe('×1.5 batch')
    expect(fmtBatch(2)).toBe('×2')
  })
  it('suggested batches round UP to the next half batch', () => {
    // par 8, onHand 1.8 → raw 6.2 kg → 1.24 batches → ×1.5
    expect(suggestedBatches({ ...withRecipe, onHand: 1.8 })).toBe(1.5)
    expect(suggestedBatches({ ...withRecipe, onHand: 8 })).toBe(0)
    // tiny shortfall still means at least half a batch
    expect(suggestedBatches({ ...withRecipe, onHand: 7.9 })).toBe(0.5)
  })
})

describe('deadlines + schedule', () => {
  const svcs = [{ timeMinutes: 690, endMinutes: 840 }, { timeMinutes: 1020, endMinutes: 1290 }]
  const ctx = planDayContext(svcs, 420)!
  it('day context anchors on the next doors-open and the last close', () => {
    expect(ctx.doorsOpen).toBe(690)
    expect(ctx.close).toBe(1320) // never earlier than 22:00
    expect(planDayContext([], 420)).toBeNull()
  })
  it('evening planning rolls the anchors to tomorrow instead of flagging everything late', () => {
    const night = planDayContext(svcs, 1350)! // 22:30 — all services started, kitchen closed
    expect(night.doorsOpen).toBe(690 + 1440)  // TMRW 11:30
    expect(night.close).toBe(1320 + 1440)
    expect(urgencyDeadline('PASS', night)).toBe(690 + 1440)
    // an item's OWN service start rolls too once it has passed…
    expect(urgencyDeadline('PASS', night, 540)).toBe(540 + 1440)
    // …and TMRW doesn't double-roll past tomorrow's doors
    expect(urgencyDeadline('TMRW', night)).toBe(690 + 1440)
  })
  it('each step carries its deadline', () => {
    expect(urgencyDeadline('PASS', ctx)).toBe(690)
    expect(urgencyDeadline('MID', ctx)).toBe(810)
    expect(urgencyDeadline('CLOSE', ctx)).toBe(1320)
    expect(urgencyDeadline('TMRW', ctx)).toBe(690 + 1440)
    expect(urgencyDeadline('PASS', ctx, 1020)).toBe(1020) // item's own service wins
    expect(fmtDeadline(690 + 1440, fmtClock)).toBe('TMRW 11:30')
  })
  it('planSchedule sequences a station through its crew and flags what won’t fit', () => {
    const mk = (id: string, active: number, onHand = 0) => ({
      ...base, id, onHand, station: 'Sauces', activeMinutes: active, passiveMinutes: 0,
      estimatedPrepTime: null, service: null, category: 'SAUCE',
    })
    // one cook on Sauces, doors at 690, shift starts 420 → 270 crew-minutes
    const crew = [{ homeStation: 'Sauces' }]
    const sched = planSchedule([mk('a', 200), mk('b', 200)], crew, ctx)
    expect(sched.get('a')).toMatchObject({ start: 420, end: 620, fits: true })
    expect(sched.get('b')).toMatchObject({ start: 620, end: 820, fits: false, over: 130 })
    // a second cook absorbs the load
    const sched2 = planSchedule([mk('a', 200), mk('b', 200)], [...crew, { homeStation: 'Sauces' }], ctx)
    expect(sched2.get('b')).toMatchObject({ start: 420, fits: true })
  })
  it('stationLoad measures PASS+MID hands-on against pre-doors capacity', () => {
    const rows = [
      { ...base, id: 'a', onHand: 0, station: 'Sauces', activeMinutes: 90, passiveMinutes: 0, estimatedPrepTime: null, service: null, category: 'SAUCE' },  // PASS
      { ...base, id: 'b', onHand: 8, station: 'Sauces', activeMinutes: 60, passiveMinutes: 0, estimatedPrepTime: null, service: null, category: 'SAUCE' },  // TMRW
    ]
    const [load] = stationLoad(rows, [{ homeStation: 'Sauces' }], ctx)
    expect(load).toMatchObject({ station: 'Sauces', crew: 1, cap: 270, forService: 90, total: 150, n: 2 })
  })
})

describe('planGroups', () => {
  const rows = [
    { ...base, id: 'a', onHand: 0, station: 'Sauces', category: 'SAUCE' },   // PASS
    { ...base, id: 'b', onHand: 6, station: 'Larder', category: 'GARNISH' }, // CLOSE
    { ...base, id: 'c', onHand: 8, station: 'Sauces', category: 'SAUCE' },   // TMRW
  ]
  it('groups by urgency in step order', () => {
    const gs = planGroups(rows, 'urgency')
    expect(gs.map(g => g.key)).toEqual(['PASS', 'CLOSE', 'TMRW'])
    expect(gs[0].label).toBe('Critical-Start Service')
  })
  it('groups by station (known order first) and category', () => {
    expect(planGroups(rows, 'station', { stations: ['Larder', 'Sauces'] }).map(g => g.key)).toEqual(['Larder', 'Sauces'])
    expect(planGroups(rows, 'category').map(g => g.key)).toEqual(['GARNISH', 'SAUCE'])
  })
})

describe('the live prep log — work carries over, it never drops at midnight', () => {
  // Today = 2026-08-15 (the restaurant day marker is UTC midnight).
  const today = Date.parse('2026-08-15T00:00:00.000Z')
  const row = (over: Partial<LiveLogRow> & { id: string }): LiveLogRow => ({
    prepItemId: 'i1', logDate: '2026-08-15T00:00:00.000Z', status: 'NOT_STARTED',
    postedAt: '2026-08-14T23:47:00.000Z', ...over,
  })

  it('keeps an unfinished job posted for an earlier day', () => {
    // The chef posts after the shift, for the next day — it must still be there.
    expect(isLiveLog(row({ id: 'a', logDate: '2026-08-14T00:00:00.000Z' }), today)).toBe(true)
    expect(isLiveLog(row({ id: 'b', logDate: '2026-07-02T00:00:00.000Z', status: 'IN_PROGRESS' }), today)).toBe(true)
  })

  it('drops an earlier job that was finished or skipped', () => {
    for (const status of ['DONE', 'PARTIAL', 'SKIPPED']) {
      expect(isLiveLog(row({ id: 'c', logDate: '2026-08-14T00:00:00.000Z', status }), today)).toBe(false)
    }
  })

  it('does not carry an earlier row that was never posted', () => {
    // Abandoned timers and stale draft rows are "open" too — without this the To
    // Do inherits every one of them.
    expect(isLiveLog(row({ id: 'd', logDate: '2026-06-04T00:00:00.000Z', status: 'IN_PROGRESS', postedAt: null }), today)).toBe(false)
    expect(isLiveLog(row({ id: 'e', logDate: '2026-07-31T00:00:00.000Z', postedAt: null }), today)).toBe(false)
    // …but today's row is live whether or not it has been posted.
    expect(isLiveLog(row({ id: 'f', postedAt: null }), today)).toBe(true)
  })

  it("keeps today's log whatever its status — the Done section reads it", () => {
    expect(isLiveLog(row({ id: 'd', status: 'DONE' }), today)).toBe(true)
    expect(isLiveLog(row({ id: 'e', status: 'PARTIAL' }), today)).toBe(true)
  })

  it('picks exactly one log per item, newest first', () => {
    const picked = pickLiveLogs([
      row({ id: 'old', logDate: '2026-08-13T00:00:00.000Z' }),
      row({ id: 'new', logDate: '2026-08-14T00:00:00.000Z' }),
      row({ id: 'done-old', logDate: '2026-08-12T00:00:00.000Z', status: 'DONE' }),
      row({ id: 'other', prepItemId: 'i2' }),
    ], today)
    expect(picked.size).toBe(2)
    expect(picked.get('i1')?.id).toBe('new')
    expect(picked.get('i2')?.id).toBe('other')
  })

  it('a job made today does not come back tomorrow under an older open row', () => {
    // The item was posted last night, made this morning. Its Aug-14 row is still
    // open + posted underneath the completed Aug-15 one; only the newest counts.
    const logs = [
      row({ id: 'carried', logDate: '2026-08-14T00:00:00.000Z', status: 'NOT_STARTED' }),
      row({ id: 'made', logDate: '2026-08-15T00:00:00.000Z', status: 'DONE' }),
    ]
    expect(pickLiveLogs(logs, today).get('i1')?.id).toBe('made') // today: in the Done section
    const tomorrow = Date.parse('2026-08-16T00:00:00.000Z')
    expect(pickLiveLogs(logs, tomorrow).size).toBe(0)           // tomorrow: gone, it was made
  })

  it("prefers today's row over a carried one", () => {
    const picked = pickLiveLogs([
      row({ id: 'carried', logDate: '2026-08-14T00:00:00.000Z', status: 'IN_PROGRESS' }),
      row({ id: 'today', status: 'NOT_STARTED' }),
    ], today)
    expect(picked.get('i1')?.id).toBe('today')
  })
})

describe('undoDraftFlag', () => {
  // The four reachable states. The removal always writes `false`, so `live` is
  // false unless the chef re-added the item to the draft inside the toast window.

  it('restores the prior flag when the chef has not touched the draft', () => {
    expect(undoDraftFlag(false, true)).toBe(true)
    expect(undoDraftFlag(false, false)).toBe(false)
  })

  it('leaves an item the chef re-added ON the draft, whatever it was before', () => {
    // The regression: a frozen prior of `false` used to clobber the re-add.
    expect(undoDraftFlag(true, false)).toBe(true)
    expect(undoDraftFlag(true, true)).toBe(true)
  })

  it('does not put a never-drafted item back on the draft', () => {
    // Posted, then taken off the draft (the post goes dirty while the item stays
    // on the To Do). x then Undo must restore the POSTED state only.
    expect(undoDraftFlag(false, false)).toBe(false)
  })

  it('defaults an unknown prior to true, matching the route', () => {
    // POST /api/prep/plan/remove-item reads an omitted `isOnList` as `true`.
    expect(undoDraftFlag(false, undefined)).toBe(true)
    expect(undoDraftFlag(true, undefined)).toBe(true)
  })
})
