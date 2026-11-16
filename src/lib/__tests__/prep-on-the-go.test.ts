import { describe, it, expect } from 'vitest'
import { onTheGo, alarmShouldRing, ALARM_REPEAT_MIN } from '../prep-on-the-go'
import type { MethodStep } from '../recipe-method'

const METHOD: MethodStep[] = [
  { key: 'a', text: 'Mix', phase: 'Mix', minutes: 5, wait: { minutes: 30 } },
  { key: 'b', text: 'Shape', phase: 'Shape', minutes: 5 },
]
const T0 = Date.UTC(2026, 10, 16, 18, 0)
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()
const job = (id: string, log: Record<string, unknown> | null, method: MethodStep[] | null = METHOD) =>
  ({ id, linkedRecipe: { method }, todayLog: log as never })

describe('onTheGo — every started job, in the order it needs a cook', () => {
  it('ready first, then hands-on, then waiting', () => {
    const rows = onTheGo([
      job('resting', { status: 'IN_PROGRESS', stepKey: 'a:wait', stepEnteredAt: iso(0) }),
      job('working', { status: 'IN_PROGRESS', stepKey: 'b', stepEnteredAt: iso(5) }),
      job('ready', { status: 'IN_PROGRESS', stepKey: 'a:wait', stepEnteredAt: iso(-40) }),
    ], T0 + 10 * 60_000)
    expect(rows.map(r => [r.item.id, r.state])).toEqual([['ready', 'ready'], ['working', 'working'], ['resting', 'waiting']])
  })
  it('waiting jobs: soonest ready first', () => {
    const rows = onTheGo([
      job('later', { status: 'IN_PROGRESS', stepKey: 'a:wait', stepEnteredAt: iso(5) }),
      job('sooner', { status: 'IN_PROGRESS', stepKey: 'a:wait', stepEnteredAt: iso(0) }),
    ], T0 + 10 * 60_000)
    expect(rows.map(r => r.item.id)).toEqual(['sooner', 'later'])
  })
  it('a job that is not started is not on the go', () => {
    expect(onTheGo([job('x', { status: 'NOT_STARTED', stepKey: 'b' })], T0)).toEqual([])
  })
  it('a job with no method is on the go as hands-on', () => {
    const [r] = onTheGo([job('x', { status: 'IN_PROGRESS', startedAt: iso(0) }, null)], T0)
    expect(r).toMatchObject({ state: 'working', seq: null, cur: null })
  })
})

describe('alarmShouldRing — once at ready, then every 5 minutes', () => {
  const ready = T0
  it('not before the wait is over', () => {
    expect(alarmShouldRing(ready, null, ready - 1)).toBe(false)
  })
  it('rings the first time at ready', () => {
    expect(alarmShouldRing(ready, null, ready)).toBe(true)
  })
  it('waits 5 minutes before ringing again', () => {
    expect(ALARM_REPEAT_MIN).toBe(5)
    expect(alarmShouldRing(ready, ready, ready + 4 * 60_000)).toBe(false)
    expect(alarmShouldRing(ready, ready, ready + 5 * 60_000)).toBe(true)
  })
})
