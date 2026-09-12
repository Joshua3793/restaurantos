import { describe, it, expect } from 'vitest'
import { pipelineOf, withPipeline, whyLabel, fmtPipelineReady, planDayContext, planSchedule, stationLoad } from '../prep-plan'
import { computeShiftSummary, type PrepPriority } from '../prep-utils'
import type { RecipeStage } from '../prep-stages'

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
// Sun 2026-09-06 07:00 Pacific
const nowMs = Date.parse('2026-09-06T14:00:00.000Z')
const iso = (offsetMin: number) => new Date(nowMs + offsetMin * 60_000).toISOString()

describe('pipelineOf — a job in flight, staged or not', () => {
  it('null unless the live log is IN_PROGRESS', () => {
    expect(pipelineOf({ ...base, todayLog: null }, nowMs)).toBeNull()
    expect(pipelineOf({ ...base, todayLog: { status: 'NOT_STARTED' } }, nowMs)).toBeNull()
    expect(pipelineOf({ ...base, todayLog: { status: 'DONE' } }, nowMs)).toBeNull()
  })
  it('unstaged: ready at start + active + passive, charging what is left of the hands-on time', () => {
    const p = pipelineOf({ ...base, activeMinutes: 60, passiveMinutes: 30, todayLog: { status: 'IN_PROGRESS', startedAt: iso(-20), requiredQty: '6' } }, nowMs)!
    expect(p).toMatchObject({ qty: 6, stageName: null, remainingActiveMinutes: 40, remainingPassiveMinutes: 30, nextActiveAt: iso(0) })
    expect(p.readyAt).toBe(iso(70))
  })
  it('unstaged with no clock: qty and nothing else', () => {
    const p = pipelineOf({ ...base, activeMinutes: 60, todayLog: { status: 'IN_PROGRESS', startedAt: null } }, nowMs)!
    expect(p.readyAt).toBeNull()
    expect(p.qty).toBe(8)
  })
  it('staged, resting: ready when the chain ends; next hands-on at the rest’s ready time', () => {
    const item = { ...base, linkedRecipe: { stages: cure }, todayLog: { status: 'IN_PROGRESS', stageIndex: 1, stageEnteredAt: iso(-2880) } }
    const p = pipelineOf(item, nowMs)!
    expect(p.stageName).toBe('Cure')
    expect(p.remainingActiveMinutes).toBe(15)
    expect(p.remainingPassiveMinutes).toBe(1440)
    expect(p.nextActiveAt).toBe(iso(1440))
    expect(p.readyAt).toBe(iso(1455))
  })
  it('staged, hands-on: next hands-on is now', () => {
    const item = { ...base, linkedRecipe: { stages: cure }, todayLog: { status: 'IN_PROGRESS', stageIndex: 0, stageEnteredAt: iso(-5) } }
    const p = pipelineOf(item, nowMs)!
    expect(p).toMatchObject({ stageName: 'Rub', remainingActiveMinutes: 30, remainingPassiveMinutes: 4320, nextActiveAt: iso(0) })
  })
  it('withPipeline attaches it', () => {
    expect(withPipeline({ ...base, todayLog: null }, nowMs).pipeline).toBeNull()
    expect(withPipeline({ ...base, activeMinutes: 10, todayLog: { status: 'IN_PROGRESS', startedAt: iso(0) } }, nowMs).pipeline?.qty).toBe(8)
  })
})

describe('whyLabel reads the pipeline first', () => {
  it('names the stage and the ready time; a stock-out in flight is not "stock out"', () => {
    const readyAt = '2026-09-10T14:30:00.000Z'   // Thu 07:30 Pacific
    expect(whyLabel({ ...base, pipeline: { qty: 8, readyAt, stageName: 'Cure', remainingActiveMinutes: 15, remainingPassiveMinutes: 0, nextActiveAt: null } }))
      .toBe('in the pipeline (cure) · ready Thu 07:30')
    expect(whyLabel({ ...base, pipeline: { qty: 8, readyAt: null, stageName: null, remainingActiveMinutes: 0, remainingPassiveMinutes: 0, nextActiveAt: null } }))
      .toBe('in the pipeline')
    expect(whyLabel({ ...base })).toBe('stock out')
  })
  it('fmtPipelineReady drops the weekday on the same restaurant day', () => {
    expect(fmtPipelineReady('2026-09-06T16:30:00.000Z', nowMs)).toBe('09:30')
    expect(fmtPipelineReady('2026-09-10T14:30:00.000Z', nowMs)).toBe('Thu 07:30')
  })
})

describe('the schedule charges a job in flight for what is left, from when it can resume', () => {
  const svcs = [{ timeMinutes: 690, endMinutes: 840 }]
  const mk = (id: string, extra: object = {}) => ({
    ...base, id, stations: ['Sauces'], category: 'SAUCE', onHand: 0, activeMinutes: 200, passiveMinutes: 0,
    estimatedPrepTime: null, service: null, ...extra,
  })
  const crew = [{ homeStation: 'Sauces' }]

  it('remaining active minutes only, slotted from nextActiveAt', () => {
    const ctx = planDayContext(svcs, 420, nowMs)!
    const inFlight = mk('a', { pipeline: { qty: 8, readyAt: iso(135), stageName: 'Rinse', remainingActiveMinutes: 15, remainingPassiveMinutes: 0, nextActiveAt: iso(120) } })
    const sched = planSchedule([inFlight, mk('b')], crew, ctx)
    // the fresh job takes the cook at shift start; the in-flight one waits for its ready time
    expect(sched.get('b')).toMatchObject({ start: 420, end: 620 })
    expect(sched.get('a')).toMatchObject({ start: 620, end: 635, fits: true })
    // …and it does not push the cursor by its whole 200 min
    expect(stationLoad([inFlight, mk('b')], crew, ctx)[0]).toMatchObject({ forService: 215, total: 215 })
  })
  it('an in-flight job whose rest is over takes the next free cook, not the shift start', () => {
    const ctx = planDayContext(svcs, 420, nowMs)!
    const inFlight = mk('a', { pipeline: { qty: 8, readyAt: iso(15), stageName: 'Rinse', remainingActiveMinutes: 15, remainingPassiveMinutes: 0, nextActiveAt: iso(-60) } })
    expect(planSchedule([inFlight], crew, ctx).get('a')).toMatchObject({ start: 420, end: 435 })
  })
  it('without nowMs on the context it still charges only the remainder, from shift start', () => {
    const ctx = planDayContext(svcs, 420)!
    const inFlight = mk('a', { pipeline: { qty: 8, readyAt: null, stageName: null, remainingActiveMinutes: 15, remainingPassiveMinutes: 5, nextActiveAt: iso(120) } })
    expect(planSchedule([inFlight], crew, ctx).get('a')).toMatchObject({ start: 420, end: 440 })
  })
})

describe('the band’s critical count leaves the pipeline alone', () => {
  it('an in-flight critical item is in progress, not critical', () => {
    const rows = [
      { priority: '911' as PrepPriority, isBlocked: false, todayLog: { status: 'IN_PROGRESS' }, pipeline: { qty: 1 } },
      { priority: '911' as PrepPriority, isBlocked: false, todayLog: null },
    ]
    expect(computeShiftSummary(rows)).toMatchObject({ critical: 1, inProgress: 1 })
    // no pipeline field → the old count
    expect(computeShiftSummary(rows.map(r => ({ ...r, pipeline: undefined })))).toMatchObject({ critical: 2 })
  })
})
