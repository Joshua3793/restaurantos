import { describe, it, expect, vi } from 'vitest'
import {
  topBellItems, badgeText, bellAriaLabel, reportPill, reportMeta, moreBadgeTotal,
  reportDetail, openReport,
} from '../bell'

const item = (id: string, severity: 'NOW' | 'TODAY' | 'FYI', status = 'OPEN') => ({ id, severity, status })

describe('topBellItems', () => {
  it('puts NOW before TODAY and keeps list order inside each', () => {
    const out = topBellItems([item('a', 'TODAY'), item('b', 'NOW'), item('c', 'TODAY'), item('d', 'NOW')])
    expect(out.map(i => i.id)).toEqual(['b', 'd', 'a', 'c'])
  })
  it('leaves out FYI and anything done', () => {
    const out = topBellItems([item('a', 'FYI'), item('b', 'NOW', 'DONE'), item('d', 'TODAY')])
    expect(out.map(i => i.id)).toEqual(['d'])
  })
  it('shows every item the badge counts: waiting, and a snooze that has woken', () => {
    // From status=open: "Fryer broken" set to Waiting on someone, and a
    // food-safety item snoozed yesterday that woke at 05:00 (still SNOOZED).
    const out = topBellItems([item('fryer', 'TODAY', 'WAITING'), item('walkin', 'NOW', 'SNOOZED'), item('d', 'TODAY')])
    expect(out.map(i => i.id)).toEqual(['walkin', 'fryer', 'd'])
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
    expect(bellAriaLabel('lead', 4)).toBe('Inbox, 4 open')
    expect(bellAriaLabel('lead', 0)).toBe('Inbox, 0 open')
  })
  it('reads "Your reports" for staff', () => {
    expect(bellAriaLabel('staff', 0)).toBe('Your reports')
    expect(bellAriaLabel('staff', 2)).toBe('Your reports, 2 fixed')
  })
  it('reads just "Inbox" while the role is still loading', () => {
    expect(bellAriaLabel('unknown', 0)).toBe('Inbox')
    expect(bellAriaLabel('unknown', 7)).toBe('Inbox')
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
  it('adds the inbox to the other two below manager', () => {
    expect(moreBadgeTotal({ invoicesReview: 2, priceAlerts: 1, inbox: 4 }, 'LEAD')).toBe(7)
    expect(moreBadgeTotal({ invoicesReview: 2, priceAlerts: 1, inbox: 0 }, 'STAFF')).toBe(3)
    expect(moreBadgeTotal({ invoicesReview: 2, priceAlerts: 1, inbox: 0 }, null)).toBe(3)
  })
  it('a manager’s one price rise counts once (the Inbox already holds Money)', () => {
    // Goats Cheese up 12% at Sysco: one price alert, one Inbox item.
    expect(moreBadgeTotal({ invoicesReview: 0, priceAlerts: 1, inbox: 1 }, 'MANAGER')).toBe(1)
    expect(moreBadgeTotal({ invoicesReview: 3, priceAlerts: 1, inbox: 2 }, 'OWNER')).toBe(2)
  })
})

describe('reportDetail', () => {
  const now = new Date('2026-10-30T20:00:00Z')
  const base = { body: 'Walk-in door sticks', createdAt: '2026-10-30T15:00:00Z', doneAt: null, doneByName: null }
  it('shows who fixed it, when, and the closing note', () => {
    const d = {
      item: { ...base, status: 'DONE', doneAt: '2026-10-30T18:41:00Z', doneByName: 'Sam' },
      events: [{ kind: 'DONE', byName: 'Sam', note: 'Replaced the seal', at: '2026-10-30T18:41:00Z' }],
    }
    expect(reportDetail(d, now)).toEqual({ body: 'Walk-in door sticks', resolution: 'Fixed by Sam · 11:41', note: 'Replaced the seal' })
  })
  it('shows the CLEARED note for a cleared report', () => {
    const d = {
      item: { ...base, status: 'OPEN' },
      events: [{ kind: 'CLEARED', byName: null, note: 'No longer needed', at: '2026-10-30T18:41:00Z' }],
    }
    expect(reportDetail(d, now)).toEqual({ body: 'Walk-in door sticks', resolution: 'Cleared · 11:41', note: 'No longer needed' })
  })
  it('has no resolution while it is still open', () => {
    expect(reportDetail({ item: { ...base, status: 'OPEN' }, events: [] }, now))
      .toEqual({ body: 'Walk-in door sticks', resolution: null, note: null })
  })
  it('copes with a limited read (no body, no history)', () => {
    const d = { item: { ...base, body: null, status: 'DONE', doneAt: '2026-10-30T18:41:00Z', doneByName: 'Sam' }, events: [], limited: true as const }
    expect(reportDetail(d, now)).toEqual({ body: null, resolution: 'Fixed by Sam · 11:41', note: null })
  })
})

// The STAFF badge only drops once the item read has written SEEN, so tapping a
// report must read it FIRST, then refresh the badge, then reload the list.
describe('openReport', () => {
  it('reads the report, then refreshes the badge, then reloads the list', async () => {
    const calls: string[] = []
    const detail = await openReport({
      id: 'r1',
      rcId: 'rc1',
      read: async id => { calls.push(`read:${id}`); return { ok: true } },
      refreshCount: async rc => { calls.push(`count:${rc}`) },
      reloadReports: async () => { calls.push('mine') },
    })
    expect(calls).toEqual(['read:r1', 'count:rc1', 'mine'])
    expect(detail).toEqual({ ok: true })
  })
  it('still reloads the list when no single kitchen is picked, but skips the count', async () => {
    const refreshCount = vi.fn()
    const reloadReports = vi.fn(async () => {})
    await openReport({ id: 'r1', rcId: null, read: async () => 1, refreshCount, reloadReports })
    expect(refreshCount).not.toHaveBeenCalled()
    expect(reloadReports).toHaveBeenCalledTimes(1)
  })
  it('hands the detail over before the badge refresh finishes', async () => {
    const calls: string[] = []
    let release: () => void = () => {}
    const stalled = new Promise<void>(r => { release = r })
    const done = openReport({
      id: 'r1', rcId: 'rc1',
      read: async () => 'detail',
      onRead: d => { calls.push(`shown:${d}`) },
      refreshCount: () => stalled,
      reloadReports: async () => { calls.push('mine') },
    })
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual(['shown:detail'])
    release()
    await done
    expect(calls).toEqual(['shown:detail', 'mine'])
  })
  it('a failed badge refresh still returns the detail', async () => {
    const detail = await openReport({
      id: 'r1', rcId: 'rc1', read: async () => 'd',
      refreshCount: async () => { throw new Error('net') },
      reloadReports: async () => { throw new Error('net') },
    })
    expect(detail).toBe('d')
  })
  it('refreshes nothing when the read fails', async () => {
    const refreshCount = vi.fn()
    const reloadReports = vi.fn()
    await expect(openReport({
      id: 'r1', rcId: 'rc1', read: async () => { throw new Error('404') }, refreshCount, reloadReports,
    })).rejects.toThrow('404')
    expect(refreshCount).not.toHaveBeenCalled()
    expect(reloadReports).not.toHaveBeenCalled()
  })
})
