import { describe, it, expect } from 'vitest'
import {
  whenLabel, groupBySeverity, applyFilter, placesOf, peopleOf, countByTag,
  extraBody, metaLine, eventText, eventBy, goToLabel, type InboxItem, type InboxEvent,
} from '../format'

const TAG = { id: 't1', builtIn: null, name: 'Maintenance', color: '#ea580c', cookCanPick: true, managerOnly: false, isActive: true }

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'i1', tagId: 't1', severity: 'TODAY', status: 'OPEN', managerOnly: false,
    snoozeUntil: null, clearedAt: null, doneById: null, createdAt: '2026-10-30T14:31:00Z',
    title: 'Mixer guard won’t lock', body: null, place: 'Pastry', href: null, source: 'FLAG',
    tag: TAG, raisedById: 'u1', raisedByName: 'Ana', doneByName: null, doneAt: null,
    unread: true, revenueCenterId: 'rc1', ...over,
  }
}

const ev = (over: Partial<InboxEvent>): InboxEvent => ({ kind: 'SEEN', byName: 'Josh', note: null, at: '2026-10-30T14:40:00Z', ...over })

describe('whenLabel', () => {
  // 30 Oct 2026, 08:00 Pacific (PDT, UTC-7).
  const now = new Date('2026-10-30T15:00:00Z')
  it('reads a time today without a leading zero', () => {
    expect(whenLabel('2026-10-30T14:41:00Z', now)).toBe('7:41')
  })
  it('reads an earlier day this week with its weekday', () => {
    // Wed 28 Oct 22:35 Pacific.
    expect(whenLabel('2026-10-29T05:35:00Z', now)).toBe('WED 22:35')
  })
  it('reads anything older as a date', () => {
    expect(whenLabel('2026-10-20T18:00:00Z', now)).toBe('20 OCT')
  })
  it('is empty for no time', () => {
    expect(whenLabel(null, now)).toBe('')
  })
})

describe('groupBySeverity', () => {
  it('orders NOW, TODAY, FYI and drops empty groups', () => {
    const g = groupBySeverity([item({ id: 'a', severity: 'FYI' }), item({ id: 'b', severity: 'NOW' }), item({ id: 'c', severity: 'NOW' })])
    expect(g.map(x => x.severity)).toEqual(['NOW', 'FYI'])
    expect(g[0].items.map(i => i.id)).toEqual(['b', 'c'])
  })
})

describe('filters', () => {
  const list = [
    item({ id: 'a', status: 'WAITING', place: 'Grill', raisedById: 'u2', raisedByName: 'Leo' }),
    item({ id: 'b', status: 'SNOOZED', tagId: 't2' }),
    item({ id: 'c', place: null, raisedById: null, raisedByName: null }),
  ]
  it('slices the open list by status', () => {
    expect(applyFilter(list, { view: 'waiting', tagId: null, place: null, from: null }).map(i => i.id)).toEqual(['a'])
    expect(applyFilter(list, { view: 'snoozed', tagId: null, place: null, from: null }).map(i => i.id)).toEqual(['b'])
    expect(applyFilter(list, { view: 'open', tagId: null, place: null, from: null })).toHaveLength(3)
  })
  it('filters by tag, place and person', () => {
    expect(applyFilter(list, { view: 'open', tagId: 't2', place: null, from: null }).map(i => i.id)).toEqual(['b'])
    expect(applyFilter(list, { view: 'open', tagId: null, place: 'Grill', from: null }).map(i => i.id)).toEqual(['a'])
    expect(applyFilter(list, { view: 'open', tagId: null, place: null, from: 'u1' }).map(i => i.id)).toEqual(['b'])
  })
  it('lists distinct places and people', () => {
    expect(placesOf(list)).toEqual(['Grill', 'Pastry'])
    expect(peopleOf(list)).toEqual([{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Leo' }])
  })
  it('counts per tag', () => {
    expect(countByTag(list)).toEqual({ t1: 2, t2: 1 })
  })
})

describe('row wording', () => {
  it('drops a body that only repeats the title', () => {
    expect(extraBody({ title: 'Burrata ran out', body: 'Burrata ran out' })).toBeNull()
    expect(extraBody({ title: 'Burrata ran out', body: 'Burrata ran out\nneed 2 for tonight' })).toBe('Burrata ran out\nneed 2 for tonight')
  })
  it('quotes a cook’s report but not a flag reading', () => {
    expect(metaLine(item({ source: 'REPORT', body: 'using the small mixer' }))).toBe('Ana · Pastry · “using the small mixer”')
    expect(metaLine(item({ source: 'FLAG', body: 'Read 6.5 °C' }))).toBe('Ana · Pastry · Read 6.5 °C')
    expect(metaLine(item({ raisedByName: null, place: null, source: 'SYSTEM', body: '11 recipes affected' }))).toBe('11 recipes affected')
  })
})

describe('eventText', () => {
  it('names who raised it by where it came from', () => {
    expect(eventText(ev({ kind: 'RAISED', byName: 'Ana' }), 'REPORT')).toBe('Raised by Ana')
    expect(eventText(ev({ kind: 'RAISED', byName: 'Ana' }), 'FLAG')).toBe('Flagged by Ana')
    expect(eventText(ev({ kind: 'RAISED', byName: null }), 'SYSTEM')).toBe('Spotted by the app')
  })
  it('labels every kind', () => {
    expect(eventText(ev({ kind: 'SEEN' }), 'FLAG')).toBe('Seen by Josh')
    expect(eventText(ev({ kind: 'NOTE', note: 'Called Hobart' }), 'FLAG')).toBe('Josh: “Called Hobart”')
    expect(eventText(ev({ kind: 'SNOOZED' }), 'FLAG')).toBe('Snoozed till tomorrow')
    expect(eventText(ev({ kind: 'WAITING' }), 'FLAG')).toBe('Waiting on someone')
    expect(eventText(ev({ kind: 'WAITING', note: 'Hobart Friday' }), 'FLAG')).toBe('Waiting on someone: “Hobart Friday”')
    expect(eventText(ev({ kind: 'DONE' }), 'FLAG')).toBe('Fixed by Josh')
    expect(eventText(ev({ kind: 'REOPENED' }), 'FLAG')).toBe('Reopened')
    expect(eventText(ev({ kind: 'CLEARED', byName: 'Ana' }), 'FLAG')).toBe('Cleared itself')
    expect(eventText(ev({ kind: 'RETAGGED', note: 'Maintenance → Stock' }), 'FLAG')).toBe('Moved to Stock')
  })
  it('calls an unnamed writer "The app"', () => {
    expect(eventText(ev({ kind: 'DONE', byName: null }), 'SYSTEM')).toBe('Fixed by The app')
    expect(eventText(ev({ kind: 'SEEN', byName: '  ' }), 'SYSTEM')).toBe('Seen by The app')
  })
  it('adds who only where the wording does not say it', () => {
    expect(eventBy(ev({ kind: 'SNOOZED' }))).toBe('Josh')
    expect(eventBy(ev({ kind: 'SEEN' }))).toBeNull()
    expect(eventBy(ev({ kind: 'SNOOZED', byName: null }))).toBeNull()
  })
})

describe('goToLabel', () => {
  it('names the page a system item links to', () => {
    expect(goToLabel('/invoices')).toBe('Go to invoices')
    expect(goToLabel('/checklist/today?phase=OPEN')).toBe('Go to today’s checklists')
    expect(goToLabel('/count')).toBe('Go to the count')
    expect(goToLabel('/somewhere')).toBe('Go to it')
  })
})
