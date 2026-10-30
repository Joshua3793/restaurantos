import { describe, it, expect } from 'vitest'
import {
  topBellItems, badgeText, bellAriaLabel, reportPill, reportMeta, moreBadgeTotal,
} from '../bell'

const item = (id: string, severity: 'NOW' | 'TODAY' | 'FYI', status = 'OPEN') => ({ id, severity, status })

describe('topBellItems', () => {
  it('puts NOW before TODAY and keeps list order inside each', () => {
    const out = topBellItems([item('a', 'TODAY'), item('b', 'NOW'), item('c', 'TODAY'), item('d', 'NOW')])
    expect(out.map(i => i.id)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('leaves out FYI and anything not open', () => {
    const out = topBellItems([item('a', 'FYI'), item('b', 'NOW', 'DONE'), item('c', 'TODAY', 'WAITING'), item('d', 'TODAY')])
    expect(out.map(i => i.id)).toEqual(['d'])
  })
  it('stops at five', () => {
    const many = Array.from({ length: 8 }, (_, n) => item(`i${n}`, 'NOW'))
    expect(topBellItems(many)).toHaveLength(5)
  })
})

describe('badgeText', () => {
  it('hides zero, shows to 9, then 9+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(3)).toBe('3')
    expect(badgeText(9)).toBe('9')
    expect(badgeText(10)).toBe('9+')
  })
})

describe('bellAriaLabel', () => {
  it('reads "Inbox, N open" for leads', () => {
    expect(bellAriaLabel(true, 4)).toBe('Inbox, 4 open')
    expect(bellAriaLabel(true, 0)).toBe('Inbox, 0 open')
  })
  it('reads "Your reports" for staff', () => {
    expect(bellAriaLabel(false, 0)).toBe('Your reports')
    expect(bellAriaLabel(false, 2)).toBe('Your reports, 2 fixed')
  })
})

describe('reportPill and reportMeta', () => {
  const now = new Date('2026-10-30T20:00:00Z')
  it('calls done FIXED and everything else OPEN', () => {
    expect(reportPill('DONE').label).toBe('FIXED')
    expect(reportPill('OPEN').label).toBe('OPEN')
    expect(reportPill('WAITING').label).toBe('OPEN')
    expect(reportPill('SNOOZED').label).toBe('OPEN')
  })
  it('says who fixed it and when', () => {
    const r = { id: '1', status: 'DONE', title: 'Walk-in leak', createdAt: '2026-10-30T15:00:00Z', doneAt: '2026-10-30T18:41:00Z', doneByName: 'Sam' }
    expect(reportMeta(r, now)).toBe('Fixed by Sam · 11:41')
  })
  it('falls back when nobody is named', () => {
    const r = { id: '1', status: 'DONE', title: 'x', createdAt: '2026-10-30T15:00:00Z', doneAt: null, doneByName: null }
    expect(reportMeta(r, now)).toBe('Fixed')
  })
  it('says when an open report was made', () => {
    const r = { id: '1', status: 'OPEN', title: 'x', createdAt: '2026-10-30T15:00:00Z', doneAt: null, doneByName: null }
    expect(reportMeta(r, now)).toBe('Reported · 8:00')
  })
})

describe('moreBadgeTotal', () => {
  it('adds the inbox to the other two', () => {
    expect(moreBadgeTotal({ invoicesReview: 2, priceAlerts: 1, inbox: 4 })).toBe(7)
  })
})
