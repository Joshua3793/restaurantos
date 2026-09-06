import { describe, it, expect } from 'vitest'
import {
  stageFieldsForStatus, applyStageToItem, restInfo, withLadderTimes, runSheetGroups,
  isLateToStart, ladderOrder, planDayContext, msToLadderMin,
} from '../prep-plan'
import { REST_GRACE_MINUTES, type RecipeStage } from '../prep-stages'
import type { PrepPriority } from '../prep-utils'

const cure: RecipeStage[] = [
  { key: 'rub',   name: 'Rub',          kind: 'ACTIVE',  minutes: 20 },
  { key: 'cure',  name: 'Cure',         kind: 'PASSIVE', minutes: 4320 },
  { key: 'rinse', name: 'Rinse & hang', kind: 'ACTIVE',  minutes: 15 },
]

const base = {
  onHand: 0, parLevel: 8, minThreshold: 0, targetToday: null as number | null,
  manualPriorityOverride: null as string | null, unit: 'kg',
  priority: '911' as PrepPriority, suggestedQty: 8,
}

// 2026-09-06 14:00 UTC as the run sheet sees it: nowMin 420 (07:00 Pacific).
const nowMs = Date.parse('2026-09-06T14:00:00.000Z')
const now = { nowMs, nowMin: 420 }
const iso = (offsetMin: number) => new Date(nowMs + offsetMin * 60_000).toISOString()

describe('stageFieldsForStatus — what Start / Stop write on a staged item', () => {
  const staged = { linkedRecipe: { stages: cure } }
  it('Start on a fresh staged log enters stage 0 and opens the history', () => {
    const f = stageFieldsForStatus({ ...staged, todayLog: { status: 'NOT_STARTED' } }, 'IN_PROGRESS', iso(0))
    expect(f).toEqual({
      stageIndex: 0, stageEnteredAt: iso(0),
      stageHistory: [{ index: 0, key: 'rub', enteredAt: iso(0) }],
    })
  })
  it('Stop clears the stage and keeps the history', () => {
    const f = stageFieldsForStatus({ ...staged, todayLog: { status: 'IN_PROGRESS', stageIndex: 1 } }, 'NOT_STARTED', iso(0))
    expect(f).toEqual({ stageIndex: null, stageEnteredAt: null })
  })
  it('reopening a done staged job resumes the stage it was on with a fresh clock', () => {
    const f = stageFieldsForStatus({ ...staged, todayLog: { status: 'DONE', stageIndex: 2 } }, 'IN_PROGRESS', iso(0))
    expect(f.stageIndex).toBe(2)
    expect(f.stageEnteredAt).toBe(iso(0))
  })
  it('an IN_PROGRESS re-send does not restart the stage clock', () => {
    expect(stageFieldsForStatus({ ...staged, todayLog: { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-30) } }, 'IN_PROGRESS', iso(0))).toEqual({})
  })
  it('an UNSTAGED item writes nothing extra', () => {
    expect(stageFieldsForStatus({ linkedRecipe: { stages: null }, todayLog: { status: 'NOT_STARTED' } }, 'IN_PROGRESS', iso(0))).toEqual({})
    expect(stageFieldsForStatus({ linkedRecipe: null, todayLog: null }, 'NOT_STARTED', iso(0))).toEqual({})
  })
})

describe('applyStageToItem — Next / Back move the live log, never the stock', () => {
  const item = {
    ...base, linkedRecipe: { stages: cure },
    todayLog: { id: 'l1', status: 'IN_PROGRESS', startedAt: iso(-20), stageIndex: 0, stageEnteredAt: iso(-20), stageHistory: [{ index: 0, key: 'rub', enteredAt: iso(-20) }] },
  }
  it('advances to the next stage with a fresh clock and an appended event', () => {
    const next = applyStageToItem(item, 1, iso(0))
    expect(next.onHand).toBe(0)
    expect(next.todayLog).toMatchObject({ status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(0), startedAt: iso(-20) })
    expect(next.todayLog?.stageHistory).toHaveLength(2)
    expect(next.todayLog?.stageHistory?.[1]).toEqual({ index: 1, key: 'cure', enteredAt: iso(0) })
  })
  it('a correction back a stage is recorded, not erased', () => {
    const back = applyStageToItem({ ...item, todayLog: { ...item.todayLog, stageIndex: 1 } }, 0, iso(0))
    expect(back.todayLog?.stageIndex).toBe(0)
    expect(back.todayLog?.stageHistory).toHaveLength(2)
  })
  it('refuses an index outside the chain, and an unstaged item', () => {
    expect(applyStageToItem(item, 7, iso(0))).toBe(item)
    const unstaged = { ...item, linkedRecipe: { stages: null } }
    expect(applyStageToItem(unstaged, 1, iso(0))).toBe(unstaged)
  })
})

describe('rest rows — a resting job sits in the ladder at its ready time', () => {
  const brunch = [{ timeMinutes: 540, endMinutes: 960 }]
  const ctx = planDayContext(brunch, 420)!
  const mk = (id: string, log: object | null, extra: object = {}) => ({
    ...base, id, name: id, station: 'Prep', category: 'MISC', onHand: 0, activeMinutes: 35, passiveMinutes: 4320,
    estimatedPrepTime: null, service: null, startByMinutes: null as number | null,
    linkedRecipe: { stages: cure }, todayLog: log as never, ...extra,
  })

  it('msToLadderMin puts an epoch instant on the minute axis, past midnight included', () => {
    expect(msToLadderMin(nowMs + 90 * 60_000, now)).toBe(510)
    expect(msToLadderMin(nowMs + 20 * 60 * 60_000, now)).toBe(420 + 1200)   // tomorrow 03:00
  })

  it('restInfo: IN_PROGRESS on a PASSIVE stage, with readyAt from the stage clock', () => {
    // entered the cure 2 days ago → ready in 1 day (4320 − 2880 = 1440 min)
    const r = restInfo(mk('a', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-2880) }), now)!
    expect(r).toMatchObject({ index: 1, total: 3, state: 'resting', readyAtMin: 420 + 1440 })
    expect(r.next?.stage.name).toBe('Rinse & hang')
    expect(r.readyAtMs).toBe(nowMs + 1440 * 60_000)
  })
  it('restInfo is null for a hands-on stage, an unstarted log, or an unstaged item', () => {
    expect(restInfo(mk('a', { status: 'IN_PROGRESS', stageIndex: 0, stageEnteredAt: iso(-5) }), now)).toBeNull()
    expect(restInfo(mk('a', { status: 'NOT_STARTED', stageIndex: 1, stageEnteredAt: iso(-5) }), now)).toBeNull()
    expect(restInfo(mk('a', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-5) }, { linkedRecipe: { stages: null } }), now)).toBeNull()
    expect(restInfo(mk('a', null), now)).toBeNull()
  })

  it('withLadderTimes: the rest row takes readyAt as its start-by; a todo row keeps the step math', () => {
    const rows = withLadderTimes([
      mk('resting', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4200) }, { manualPriorityOverride: 'CLOSE' }),   // ready in 120
      mk('todo', null, { manualPriorityOverride: 'CLOSE' }),
    ], ctx, now)
    expect(rows[0].rest?.state).toBe('resting')
    expect(rows[0].startByMinutes).toBe(540)
    expect(rows[0].deadlineMinutes).toBe(960)         // the step deadline stays
    expect(rows[1].rest).toBeNull()
    expect(rows[1].startByMinutes).toBe(960 - 35 - 4320)
  })
  it('without `now` nothing changes — no rest field at all', () => {
    const [row] = withLadderTimes([mk('a', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-10) })], ctx)
    expect('rest' in row).toBe(false)
  })

  it('a ready rest row is NOT late; it is late only past the grace', () => {
    const ready = withLadderTimes([mk('r', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4320 - 10) })], ctx, now)[0]
    expect(ready.rest?.state).toBe('ready')
    expect(isLateToStart(ready, 420, ctx)).toBe(false)
    const overdue = withLadderTimes([mk('o', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4320 - REST_GRACE_MINUTES) })], ctx, now)[0]
    expect(overdue.rest?.state).toBe('overdue')
    expect(isLateToStart(overdue, 420, ctx)).toBe(true)
    // the plain rule for ordinary rows is unchanged
    expect(isLateToStart({ ...mk('t', null), startByMinutes: 400 }, 420, ctx)).toBe(true)
    expect(isLateToStart({ ...mk('t', null), startByMinutes: 400 }, 420, null)).toBe(false)
  })

  it('runSheetGroups keeps a ready rest row in its step and lifts only an overdue one', () => {
    const rows = withLadderTimes([
      mk('ready',   { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4320) }, { manualPriorityOverride: 'CLOSE' }),
      mk('overdue', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4320 - 90) }, { manualPriorityOverride: 'CLOSE' }),
      mk('resting', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-60) }, { manualPriorityOverride: 'CLOSE' }),
      mk('aioli',   null, { manualPriorityOverride: 'CLOSE', activeMinutes: 45, passiveMinutes: 0, linkedRecipe: null }),      // startBy 915
    ], ctx, now)
    const gs = runSheetGroups(rows, ctx, 420)
    expect(gs.map(g => [g.key, g.rows.map(r => r.id)])).toEqual([
      ['LATE',  ['overdue']],
      ['CLOSE', ['ready', 'aioli', 'resting']],   // readyAt 420 · start-by 915 · readyAt in 3d
    ])
  })

  it('ladderOrder sorts a rest row by its ready time against ordinary start-bys', () => {
    const rows = withLadderTimes([
      mk('late-rest', { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-4200) }, { manualPriorityOverride: 'MID' }),   // ready in 120 → 540
      mk('early',     null, { manualPriorityOverride: 'MID', activeMinutes: 200, passiveMinutes: 0, linkedRecipe: null }),        // 660−200 = 460
    ], ctx, now)
    expect([...rows].sort(ladderOrder).map(r => r.id)).toEqual(['early', 'late-rest'])
  })
})
