import { describe, it, expect } from 'vitest'
import {
  buildNeeds, prepProgress, unattendedCriticalPrep, tempNeeds, priceNeed, countNeed,
  daysSinceCount, runningLow, dayTimeline, fmtTimeOfDay, fmtCountdown, fmtDurationWords, clockText,
  type StartPrepItem, type StartTempUnit, type NeedsInput,
} from '../start-page'

const prep = (over: Partial<StartPrepItem> & { id: string }): StartPrepItem => ({
  name: over.id, unit: 'L', onHand: 0, parLevel: 2, priority: '911', todayLog: null, assignedCook: null, ...over,
})

const fridge = (over: Partial<StartTempUnit> & { id: string }): StartTempUnit => ({
  name: over.id, type: 'FRIDGE', safeMin: 0, safeMax: 4, readings: [], ...over,
})

const base: NeedsInput = {
  prep: [], temps: [], priceAlerts: [], recipeAlerts: [], invoicesAwaiting: 0, countDays: 1, serviceName: 'Brunch',
}

describe('prepProgress', () => {
  it('counts only posted jobs; DONE and PARTIAL are done', () => {
    const items = [
      prep({ id: 'a', todayLog: { status: 'DONE', postedAt: '2026-10-04T14:00:00Z' } }),
      prep({ id: 'b', todayLog: { status: 'PARTIAL', postedAt: '2026-10-04T14:00:00Z' } }),
      prep({ id: 'c', todayLog: { status: 'IN_PROGRESS', postedAt: '2026-10-04T14:00:00Z' } }),
      prep({ id: 'd', todayLog: { status: 'NOT_STARTED', postedAt: '2026-10-04T14:00:00Z' } }),
      prep({ id: 'e', todayLog: { status: 'NOT_STARTED', postedAt: null } }),
      prep({ id: 'f' }),
    ]
    expect(prepProgress(items)).toEqual({ posted: 4, done: 2, doing: 1 })
  })
})

describe('unattendedCriticalPrep', () => {
  it('keeps critical items nobody is on, drops started, done, assigned and non-critical', () => {
    const items = [
      prep({ id: 'hollandaise' }),
      prep({ id: 'posted-unassigned', todayLog: { status: 'NOT_STARTED', postedAt: 'x' } }),
      prep({ id: 'assigned', assignedCook: { name: 'Ana' }, todayLog: { status: 'NOT_STARTED', postedAt: 'x' } }),
      prep({ id: 'cooking', todayLog: { status: 'IN_PROGRESS', postedAt: 'x' } }),
      prep({ id: 'done', todayLog: { status: 'DONE', postedAt: 'x' } }),
      prep({ id: 'later', priority: 'LATER' }),
      prep({ id: 'today', priority: 'NEEDED_TODAY' }),
    ]
    expect(unattendedCriticalPrep(items).map(i => i.id)).toEqual(['hollandaise', 'posted-unassigned'])
  })
})

describe('tempNeeds', () => {
  it('folds every unlogged cold unit into one row and skips hot holding', () => {
    const out = tempNeeds([fridge({ id: 'Walk-in' }), fridge({ id: 'Reach-in 2' }), fridge({ id: 'Bain', type: 'HOT', safeMin: 63, safeMax: null })])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'temp-missing', when: 'now', detail: 'Walk-in, Reach-in 2' })
  })

  it('flags a unit whose LATEST reading is out of range, not an earlier one', () => {
    const fixed = fridge({ id: 'fixed', readings: [{ time: '07:00', temp: 7 }, { time: '08:00', temp: 3 }] })
    const warm = fridge({ id: 'Walk-in', readings: [{ time: '07:00', temp: 3 }, { time: '08:00', temp: 7.2 }] })
    const out = tempNeeds([fixed, warm])
    expect(out.map(n => n.id)).toEqual(['temp-bad-Walk-in'])
    expect(out[0].title).toBe('Walk-in at 7.2°C')
  })
})

describe('priceNeed', () => {
  const alert = (id: string, pct: number, direction = 'UP') => ({
    id, changePct: String(pct), direction,
    inventoryItem: { itemName: id }, session: { supplierName: 'Sysco' },
  })

  it('leads with the biggest rise and counts the rest', () => {
    const n = priceNeed([alert('Butter', 18), alert('Goats Cheese', 32), alert('Lemons', 20, 'DOWN')], [{ exceededThreshold: true }, { exceededThreshold: false }])
    expect(n?.title).toBe('Goats Cheese up 32% from Sysco')
    expect(n?.detail).toBe('1 dish now over target · +1 more price rise')
  })

  it('says nothing about price drops', () => {
    expect(priceNeed([alert('Lemons', -20, 'DOWN')], [])).toBeNull()
  })
})

describe('counts', () => {
  it('flags a count older than 4 days only', () => {
    expect(countNeed(4)).toBeNull()
    expect(countNeed(null)).toBeNull()
    expect(countNeed(5)?.title).toBe('Last count was 5 days ago')
  })

  it('reads the newest finalized count', () => {
    const now = Date.parse('2026-10-04T15:00:00Z')
    expect(daysSinceCount([
      { status: 'FINALIZED', finalizedAt: '2026-09-25T15:00:00Z' },
      { status: 'FINALIZED', finalizedAt: '2026-10-01T15:00:00Z' },
      { status: 'IN_PROGRESS', finalizedAt: null },
    ], now)).toBe(3)
  })
})

describe('buildNeeds', () => {
  it('puts food safety and critical prep before doors, money and admin after', () => {
    const needs = buildNeeds({
      ...base,
      prep: [prep({ id: 'Hollandaise' })],
      temps: [fridge({ id: 'Walk-in' }), fridge({ id: 'Reach-in', readings: [{ time: '07:00', temp: 9 }] })],
      priceAlerts: [{ id: 'p', changePct: 12, direction: 'UP', inventoryItem: { itemName: 'Goats Cheese' }, session: { supplierName: 'Sysco' } }],
      invoicesAwaiting: 2,
      countDays: 6,
    })
    expect(needs.map(n => [n.when, n.id])).toEqual([
      ['now', 'temp-bad-Reach-in'],
      ['now', 'prep-Hollandaise'],
      ['now', 'temp-missing'],
      ['today', 'price-rises'],
      ['today', 'invoices'],
      ['today', 'count'],
    ])
    expect(needs[1]).toMatchObject({ title: 'Hollandaise — none left', detail: 'Needed for brunch · not on the To Do' })
  })

  it('folds more than two critical prep items into one row', () => {
    const needs = buildNeeds({ ...base, prep: ['A', 'B', 'C'].map(id => prep({ id })) })
    expect(needs).toHaveLength(1)
    expect(needs[0]).toMatchObject({ title: '3 critical prep items — nobody on them', detail: 'A, B, C' })
  })

  it('is empty on a clean morning', () => {
    expect(buildNeeds(base)).toEqual([])
  })
})

describe('runningLow', () => {
  it('shows the lines closest to empty first', () => {
    const r = runningLow([
      { id: '1', name: 'Oat milk', onHand: 1, par: 4, unit: 'L' },
      { id: '2', name: 'Brioche buns', onHand: 0, par: 24, unit: 'each' },
      { id: '3', name: 'Short rib', onHand: 4, par: 10, unit: 'portion' },
      { id: '4', name: 'Eggs', onHand: 90, par: 100, unit: 'each' },
    ])
    expect(r.top.map(t => [t.name, t.label])).toEqual([
      ['Brioche buns', 'out'], ['Oat milk', '1 L left'], ['Short rib', '4 portion left'],
    ])
    expect(r.more).toBe(1)
  })
})

describe('service clock', () => {
  const brunch = { id: 'b', name: 'Brunch', timeMinutes: 9 * 60, endMinutes: 15 * 60 }

  it('formats times and countdowns', () => {
    expect(fmtTimeOfDay(9 * 60)).toBe('9:00 am')
    expect(fmtTimeOfDay(12 * 60 + 5)).toBe('12:05 pm')
    expect(fmtTimeOfDay(0)).toBe('12:00 am')
    expect(fmtCountdown(80)).toBe('1:20')
    expect(fmtDurationWords(80)).toBe('1 h 20 m')
    expect(fmtDurationWords(25)).toBe('25 m')
  })

  it('draws the day from 3 h before the first service to the end of the last', () => {
    const t = dayTimeline([brunch], 7 * 60 + 40)!
    expect(t.ticks[0]).toEqual({ label: '6 am', pct: 0 })
    expect(t.ticks[t.ticks.length - 1]).toEqual({ label: '3 pm', pct: 100 })
    expect(t.bands[0].startPct).toBeCloseTo(33.33, 1)
    expect(t.nowPct).toBeCloseTo(18.52, 1)
  })

  it('stretches to include an early "now" and clamps a late one', () => {
    expect(dayTimeline([brunch], 4 * 60)!.ticks[0].label).toBe('4 am')
    expect(dayTimeline([brunch], 23 * 60)!.nowPct).toBe(100)
    expect(dayTimeline([], 600)).toBeNull()
  })

  it('reads the clock for each service state', () => {
    expect(clockText({ kind: 'upcoming', service: brunch, minsUntil: 80, prepByMin: null }, 460))
      .toEqual({ label: 'Brunch in', big: '1:20', sub: 'Brunch · 9:00 am – 3:00 pm' })
    expect(clockText({ kind: 'underway', service: brunch, next: null }, 13 * 60)?.big).toBe('2:00')
    expect(clockText({ kind: 'closed' }, 1200)?.big).toBe('Done')
    expect(clockText({ kind: 'none' }, 600)).toBeNull()
  })
})
