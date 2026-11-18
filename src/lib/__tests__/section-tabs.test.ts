import { describe, it, expect } from 'vitest'
import { checklistTabs, inboxTabs, parseInboxView } from '@/lib/section-tabs'

const keys = (t: { key: string }[]) => t.map(x => x.key)

describe('checklistTabs', () => {
  it('a cook gets no tab row at all', () => {
    expect(checklistTabs('STAFF')).toEqual([])
    expect(checklistTabs(null)).toEqual([])
  })
  it('a lead gets their list, the stations and history', () => {
    expect(keys(checklistTabs('LEAD'))).toEqual(['mine', 'board', 'history'])
  })
  it('a manager gets all four, in order; phone sign-ins live in Setup', () => {
    expect(keys(checklistTabs('MANAGER'))).toEqual(['mine', 'board', 'history', 'edit'])
    expect(keys(checklistTabs('OWNER'))).toHaveLength(4)
  })
  it('puts the behind count on Stations, as an alert', () => {
    const t = checklistTabs('MANAGER', { behind: 2, phones: 1 })
    expect(t.find(x => x.key === 'board')).toMatchObject({ count: 2, alert: true, href: '/checklist/today' })
  })
})

describe('inboxTabs', () => {
  it('the same views for everyone; tags are edited in Setup', () => {
    expect(keys(inboxTabs('LEAD'))).toEqual(['open', 'waiting', 'snoozed', 'done'])
    expect(keys(inboxTabs('MANAGER'))).toEqual(['open', 'waiting', 'snoozed', 'done'])
  })
  it('Open is red only when something is due now', () => {
    expect(inboxTabs('LEAD', { open: 5, now: 0 })[0]).toMatchObject({ count: 5, alert: false })
    expect(inboxTabs('LEAD', { open: 5, now: 1 })[0]).toMatchObject({ count: 5, alert: true })
  })
  it('every list view links to /inbox with its view', () => {
    expect(inboxTabs('LEAD').map(t => t.href)).toEqual(['/inbox', '/inbox?view=waiting', '/inbox?view=snoozed', '/inbox?view=done'])
  })
})

describe('parseInboxView', () => {
  it('reads a known view and falls back to Open', () => {
    expect(parseInboxView('done')).toBe('done')
    expect(parseInboxView('waiting')).toBe('waiting')
    expect(parseInboxView(null)).toBe('open')
    expect(parseInboxView('tags')).toBe('open')
    expect(parseInboxView('<script>')).toBe('open')
  })
})
