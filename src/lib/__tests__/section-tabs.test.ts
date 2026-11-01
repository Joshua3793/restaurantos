import { describe, it, expect } from 'vitest'
import { checklistTabs, inboxTabs, parseInboxView } from '@/lib/section-tabs'

const keys = (t: { key: string }[]) => t.map(x => x.key)

describe('checklistTabs', () => {
  it('a cook gets no tab row at all', () => {
    expect(checklistTabs('STAFF')).toEqual([])
    expect(checklistTabs(null)).toEqual([])
  })
  it('a lead gets their list and the stations', () => {
    expect(keys(checklistTabs('LEAD'))).toEqual(['mine', 'board'])
  })
  it('a manager gets all five, in order', () => {
    expect(keys(checklistTabs('MANAGER'))).toEqual(['mine', 'board', 'crew', 'history', 'edit'])
    expect(keys(checklistTabs('OWNER'))).toHaveLength(5)
  })
  it('puts the counts on Stations and Sign-ins, both as alerts', () => {
    const t = checklistTabs('MANAGER', { behind: 2, phones: 1 })
    expect(t.find(x => x.key === 'board')).toMatchObject({ count: 2, alert: true, href: '/checklist/today' })
    expect(t.find(x => x.key === 'crew')).toMatchObject({ count: 1, alert: true, href: '/checklist/crew' })
  })
})

describe('inboxTabs', () => {
  it('Tags is for managers only', () => {
    expect(keys(inboxTabs('LEAD'))).toEqual(['open', 'waiting', 'snoozed', 'done'])
    expect(keys(inboxTabs('MANAGER'))).toEqual(['open', 'waiting', 'snoozed', 'done', 'tags'])
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
