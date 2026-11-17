import { describe, it, expect } from 'vitest'
import type { ServiceStatus, RcService } from '@/lib/service-hours'
import type { TagLite } from '@/lib/inbox/rules'
import {
  topItems, moreCount, countNow, fmtDoors, passLede, ledeText, ctaLabel, itemMeta,
  tagRows, stationTile, stationsDone, type PassStation,
} from '@/lib/pass'

const it_ = (id: string, severity: 'NOW' | 'TODAY' | 'FYI', tagId = 't1') => ({ id, severity, tagId })
const svc: RcService = { id: 's1', name: 'Lunch', timeMinutes: 11 * 60, endMinutes: 15 * 60 } as RcService

describe('topItems', () => {
  it('takes NOW first, then TODAY, never FYI, keeping order', () => {
    const items = [it_('a', 'TODAY'), it_('b', 'NOW'), it_('c', 'FYI'), it_('d', 'NOW'), it_('e', 'TODAY')]
    expect(topItems(items, 3).map(i => i.id)).toEqual(['b', 'd', 'a'])
    expect(topItems(items, 6).map(i => i.id)).toEqual(['b', 'd', 'a', 'e'])
    expect(topItems(items, 0)).toEqual([])
  })

  it('fills with TODAY when there are fewer than N NOW items', () => {
    expect(topItems([it_('a', 'TODAY'), it_('b', 'TODAY')], 3).map(i => i.id)).toEqual(['a', 'b'])
  })
})

describe('moreCount / countNow', () => {
  it('counts NOW + TODAY left after the shown ones', () => {
    const items = [it_('a', 'NOW'), it_('b', 'TODAY'), it_('c', 'TODAY'), it_('d', 'FYI')]
    expect(moreCount(items, 2)).toBe(1)
    expect(moreCount(items, 5)).toBe(0)
    expect(countNow(items)).toBe(1)
  })
})

describe('fmtDoors', () => {
  it('reads like the mockup', () => {
    expect(fmtDoors(68)).toBe('1h 08m')
    expect(fmtDoors(45)).toBe('45m')
    expect(fmtDoors(120)).toBe('2h 00m')
    expect(fmtDoors(-3)).toBe('0m')
  })
})

describe('passLede', () => {
  const upcoming: ServiceStatus = { kind: 'upcoming', service: svc, minsUntil: 68, prepByMin: null }
  it('doors clause while a service is still to come', () => {
    expect(ledeText(passLede(upcoming, 3))).toBe('Doors in 1h 08m. 3 things need you before then.')
    expect(ledeText(passLede(upcoming, 1))).toBe('Doors in 1h 08m. 1 thing needs you before then.')
    expect(ledeText(passLede(upcoming, 0))).toBe('Doors in 1h 08m. Nothing needs you before then.')
    expect(passLede(upcoming, 3)).toMatchObject({ doors: '1h 08m', things: '3 things' })
  })

  it('during service the doors clause becomes "<service> is on."', () => {
    const on: ServiceStatus = { kind: 'underway', service: svc, next: null }
    expect(ledeText(passLede(on, 2))).toBe('Lunch is on. 2 things need you now.')
  })

  it('no service today: the clause is dropped', () => {
    expect(ledeText(passLede({ kind: 'none' }, 2))).toBe('2 things need you right now.')
    expect(ledeText(passLede({ kind: 'closed' }, 0))).toBe('Nothing needs you right now.')
    expect(passLede({ kind: 'closed' }, 2).doors).toBeNull()
  })
})

describe('ctaLabel', () => {
  it('names where the link goes, Open when there is none', () => {
    expect(ctaLabel(null)).toBe('Open')
    expect(ctaLabel('/temps?unit=1')).toBe('Check it')
    expect(ctaLabel('/checklist/today')).toBe('Board')
    expect(ctaLabel('/prep?item=x')).toBe('Prep')
    expect(ctaLabel('/somewhere-else')).toBe('Go')
  })
})

describe('itemMeta', () => {
  it('joins who, where, what they said and when', () => {
    const now = new Date('2026-10-30T15:00:00Z')
    const meta = itemMeta({
      title: 'Mixer guard', body: 'won’t lock', place: 'Pastry', raisedByName: 'Ana',
      source: 'REPORT', createdAt: '2026-10-30T14:31:00Z',
    }, now)
    expect(meta).toBe('Ana · Pastry · “won’t lock” · 7:31')
  })
})

describe('tagRows', () => {
  const tag = (id: string, name: string): TagLite => ({ id, name, builtIn: null, color: '#000', cookCanPick: false, managerOnly: false, isActive: true })
  it('only tags with something open, in tag order, with their NOW count', () => {
    const rows = tagRows(
      [tag('a', 'Food safety'), tag('b', 'Prep'), tag('c', 'Stock')],
      { a: 2, c: 1 },
      [it_('1', 'NOW', 'a'), it_('2', 'TODAY', 'a'), it_('3', 'TODAY', 'c')],
    )
    expect(rows.map(r => [r.tag.name, r.count, r.now])).toEqual([['Food safety', 2, 1], ['Stock', 1, 0]])
  })
})

describe('stationTile', () => {
  const base: PassStation = {
    id: 's', name: 'Grill', color: '#dc2626', isShared: false, crew: ['Sam Lee'], handled: 9, total: 12,
    status: { label: 'IN PROGRESS', tone: 'grey' }, signedOffAt: null,
  }
  const now = new Date('2026-10-30T15:00:00Z')

  it('in progress: count, who and bar', () => {
    expect(stationTile(base, now)).toEqual({ stat: '9/12', who: 'Sam', pct: 75, tone: 'grey' })
  })

  it('flagged / blockers ride after the count', () => {
    const t = stationTile({ ...base, handled: 6, total: 9, status: { label: '1 FLAGGED', tone: 'gold' } }, now)
    expect(t.stat).toBe('6/9 · 1 FLAGGED')
  })

  it('not started, done with the sign-off time, shared with no crew', () => {
    expect(stationTile({ ...base, crew: [], handled: 0, status: { label: 'NOT STARTED', tone: 'red' } }, now))
      .toEqual({ stat: 'NOT STARTED', who: null, pct: 0, tone: 'red' })
    expect(stationTile({ ...base, status: { label: 'DONE', tone: 'green' }, signedOffAt: '2026-10-30T14:48:00Z' }, now).stat)
      .toBe('DONE 7:48')
    expect(stationTile({ ...base, isShared: true, crew: [], status: { label: 'DONE', tone: 'green' } }, now))
      .toMatchObject({ stat: 'DONE', who: 'Shared', pct: 100 })
    expect(stationTile({ ...base, crew: ['Mia', 'Raj'] }, now).who).toBe('Mia +1')
  })

  it('stationsDone leaves out stations with nothing today', () => {
    const s = (label: string, tone: 'red' | 'green' | 'grey') => ({ ...base, status: { label, tone } })
    expect(stationsDone([s('DONE', 'green'), s('NOT STARTED', 'red'), s('NOTHING TODAY', 'grey')])).toEqual({ done: 1, of: 2 })
  })
})

// ── Repeats become one line (stage 3: the Pass is the Inbox) ────────────────
import { passRows, topRows, namesLine } from '@/lib/pass'

describe('passRows', () => {
  const tag = (id: string) => ({ id, builtIn: null, name: id, color: '#111', cookCanPick: false, managerOnly: false, isActive: true })
  const it_ = (id: string, kind: string | null, severity: 'NOW' | 'TODAY' | 'FYI', title: string) =>
    ({ id, kind, severity, title, tag: tag(kind ?? 'report') })

  it('folds a family of prep alerts into one line, at the first one\'s place', () => {
    const rows = passRows([
      it_('a', 'temp-bad', 'NOW', 'Benny lowboy at 7.2°C'),
      it_('p1', 'prep', 'NOW', 'Hollandaise — none left'),
      it_('p2', 'prep', 'NOW', 'Bacon Jam — none left'),
      it_('p3', 'prep', 'NOW', 'Chimichurri — none left'),
      it_('p4', 'prep', 'NOW', 'GF Dredge — none left'),
    ])
    expect(rows.map(r => r.key)).toEqual(['a', 'group:prep'])
    const g = rows[1]
    expect(g.type).toBe('group')
    if (g.type !== 'group') return
    expect(g.title).toBe('4 prep items with nobody on them')
    expect(g.detail).toBe('Hollandaise · Bacon Jam · Chimichurri +1')
    expect(g.href).toBe('/prep')
    expect(g.items.map(i => i.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('price rises read as one line with short names', () => {
    const rows = passRows([
      it_('x1', 'price', 'TODAY', 'Arugula up 68% at SYSCO Canada'),
      it_('x2', 'price', 'TODAY', 'Cilantro up 66% at SYSCO Canada'),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'group', title: '2 price rises', detail: 'Arugula +68% · Cilantro +66%' })
  })

  it('a lone alert, a report and an unknown family stay as they are; FYI never shows', () => {
    const rows = passRows([
      it_('r', null, 'NOW', 'Toaster sparking'),
      it_('p', 'prep', 'NOW', 'Hollandaise — none left'),
      it_('u1', 'mystery', 'TODAY', 'One'),
      it_('u2', 'mystery', 'TODAY', 'Two'),
      it_('f', 'count-stale', 'FYI', 'Last count 5 days ago'),
    ])
    expect(rows.map(r => [r.type, r.key])).toEqual([['item', 'r'], ['item', 'p'], ['item', 'u1'], ['item', 'u2']])
  })

  it('a family takes its most urgent severity and sorts NOW first', () => {
    const rows = passRows([
      it_('t', 'invoices', 'TODAY', '3 invoices to approve'),
      it_('s1', 'station-open', 'TODAY', "Grill hasn't started opening"),
      it_('s2', 'station-open', 'NOW', "Benny hasn't started opening"),
    ])
    expect(rows.map(r => [r.key, r.severity])).toEqual([['group:station-open', 'NOW'], ['t', 'TODAY']])
    expect(rows[0]).toMatchObject({ detail: 'Grill · Benny' })
  })

  it('topRows counts NOW rows (a family is one thing) and what is left', () => {
    const items = [
      ...Array.from({ length: 14 }, (_, i) => it_(`p${i}`, 'prep', 'NOW', `Item ${i} — none left`)),
      it_('i', 'invoices', 'TODAY', '3 invoices to approve'),
      it_('r', null, 'TODAY', 'Hood light out'),
    ]
    const t = topRows(items, 2)
    expect(t.rows.map(r => r.key)).toEqual(['group:prep', 'i'])
    expect(t.nowCount).toBe(1)
    expect(t.more).toBe(1)
  })

  it('namesLine', () => {
    expect(namesLine(['A'])).toBe('A')
    expect(namesLine(['A', 'B', 'C', 'D', 'E'])).toBe('A · B · C +2')
  })
})

import { readyForDoors, dayPart } from '@/lib/pass'

describe('readyForDoors', () => {
  const st = (label: string, lines: Array<[boolean, string]>, isShared = false) =>
    ({ isShared, status: { label }, lines: lines.map(([isBlocker, status]) => ({ isBlocker, status })) })

  it('counts started stations, must-dos across every list, and 911 prep', () => {
    const r = readyForDoors(
      [
        st('IN PROGRESS', [[true, 'DONE'], [true, 'TODO'], [false, 'TODO']]),
        st('NOT STARTED', []),
        st('NOTHING TODAY', []),
        st('IN PROGRESS', [[true, 'FLAGGED']], true),
      ],
      [
        { priority: '911', todayLog: { status: 'DONE' } },
        { priority: '911', todayLog: { status: 'IN_PROGRESS' } },
        { priority: '911', todayLog: null },
        { priority: 'LATER', todayLog: null },
      ],
    )
    expect(r.gauges).toEqual([
      { key: 'stations', label: 'Stations open', done: 1, of: 2 },
      { key: 'mustdos', label: 'Must-dos done', done: 2, of: 3 },
      { key: 'prep', label: '911 prep done', done: 1, of: 3 },
    ])
    expect(r.pct).toBe(50) // 4 of 8
  })

  it('leaves out a gauge with nothing to count; nothing at all reads 100%', () => {
    expect(readyForDoors([], [])).toEqual({ gauges: [], pct: 100 })
  })
})

describe('dayPart', () => {
  const svc = { id: 's', name: 'Brunch', timeMinutes: 540 } as never
  it('reads the service clock', () => {
    expect(dayPart({ kind: 'upcoming', service: svc, minsUntil: 40, prepByMin: null })).toBe('before')
    expect(dayPart({ kind: 'underway', service: svc, next: null })).toBe('service')
    expect(dayPart({ kind: 'closed' })).toBe('closing')
    expect(dayPart({ kind: 'none' })).toBeNull()
  })
})
