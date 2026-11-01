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
