import { describe, it, expect } from 'vitest'
import {
  reconcile, snoozeUntilTomorrow, isOpenNow, canSee, flagTagId, flagSeverity,
  groupItems, badgeCount, SEED_TAGS, SEED_ROUTES,
  type ItemLite, type TagLite,
} from '@/lib/inbox/rules'

const NOW = new Date('2026-10-30T18:00:00Z')

const tags: TagLite[] = SEED_TAGS.map(t => ({ ...t, isActive: true }))
const tagsById = new Map(tags.map(t => [t.id, t]))

function item(over: Partial<ItemLite> = {}): ItemLite {
  return {
    id: 'i1', tagId: 'tag-prep', severity: 'TODAY', status: 'OPEN', managerOnly: false,
    snoozeUntil: null, clearedAt: null, doneById: null, createdAt: '2026-10-30T10:00:00Z',
    ...over,
  }
}

describe('reconcile', () => {
  it('creates when no item and condition present', () => {
    expect(reconcile(null, true, NOW)).toEqual({ action: 'create' })
  })
  it('does nothing when no item and condition absent', () => {
    expect(reconcile(null, false, NOW)).toEqual({ action: 'none' })
  })
  it.each(['OPEN', 'SNOOZED', 'WAITING'] as const)('clears a %s item when the condition is gone', status => {
    expect(reconcile({ status, clearedAt: null, doneById: null }, false, NOW)).toEqual({ action: 'clear' })
  })
  it.each(['OPEN', 'SNOOZED', 'WAITING'] as const)('leaves a %s item alone while the condition holds', status => {
    expect(reconcile({ status, clearedAt: null, doneById: null }, true, NOW)).toEqual({ action: 'none' })
  })
  it('reopens a self-cleared DONE item when the condition returns', () => {
    expect(reconcile({ status: 'DONE', clearedAt: '2026-10-29T10:00:00Z', doneById: null }, true, NOW))
      .toEqual({ action: 'reopen' })
  })
  it('leaves a DONE-by-a-person item alone even if present', () => {
    expect(reconcile({ status: 'DONE', clearedAt: null, doneById: 'u1' }, true, NOW)).toEqual({ action: 'none' })
  })
  it('leaves a self-cleared DONE item alone when the condition is absent', () => {
    expect(reconcile({ status: 'DONE', clearedAt: '2026-10-29T10:00:00Z', doneById: null }, false, NOW))
      .toEqual({ action: 'none' })
  })
  it('re-arms a DONE-by-a-person item once its condition is gone', () => {
    expect(reconcile({ status: 'DONE', clearedAt: null, doneById: 'u1' }, false, NOW)).toEqual({ action: 'rearm' })
  })
  it('a re-armed item (clearedAt now set) reopens when the condition returns', () => {
    expect(reconcile({ status: 'DONE', clearedAt: '2026-10-30T17:00:00Z', doneById: 'u1' }, true, NOW))
      .toEqual({ action: 'reopen' })
  })
})

describe('snoozeUntilTomorrow', () => {
  // The business day rolls at 05:00 Pacific: before then, "tomorrow" is the
  // coming opening (same Pacific date); from 05:00 on, the next day's.
  it('from 05:00 on, is 05:00 the next Pacific day', () => {
    // 2026-10-30T16:52Z is 09:52 PDT Fri -> Sat 05:00 PDT
    expect(snoozeUntilTomorrow(new Date('2026-10-30T16:52:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z')
    // 2026-10-31T06:30Z is 23:30 PDT Fri -> Sat 05:00 PDT
    expect(snoozeUntilTomorrow(new Date('2026-10-31T06:30:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z')
  })
  it('a closer snoozing at 00:30 wakes at this morning’s opening, not a day later', () => {
    // 2026-10-31T07:30Z is 00:30 PDT Sat -> Sat 05:00 PDT (4.5 h later)
    expect(snoozeUntilTomorrow(new Date('2026-10-31T07:30:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z')
  })
  it('04:59 still wakes the same morning; 05:00 sharp moves to the next day', () => {
    expect(snoozeUntilTomorrow(new Date('2026-10-31T11:59:00Z')).toISOString()).toBe('2026-10-31T12:00:00.000Z')
    expect(snoozeUntilTomorrow(new Date('2026-10-31T12:00:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z')
  })
  it('on the fall-back day (Nov 1 2026)', () => {
    // 00:30 PDT Nov 1 (07:30Z) -> 05:00 PST Nov 1 (13:00Z), same Pacific day
    expect(snoozeUntilTomorrow(new Date('2026-11-01T07:30:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    // 01:30 PST, the repeated hour (09:30Z) -> still 05:00 PST Nov 1
    expect(snoozeUntilTomorrow(new Date('2026-11-01T09:30:00Z')).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    // 11:00 PST Nov 1 -> 05:00 PST Nov 2
    expect(snoozeUntilTomorrow(new Date('2026-11-01T19:00:00Z')).toISOString()).toBe('2026-11-02T13:00:00.000Z')
  })
  it('on the spring-forward day (Mar 14 2027)', () => {
    // 00:30 PST Mar 14 (08:30Z) -> 05:00 PDT Mar 14 (12:00Z)
    expect(snoozeUntilTomorrow(new Date('2027-03-14T08:30:00Z')).toISOString()).toBe('2027-03-14T12:00:00.000Z')
    // 03:30 PDT Mar 14, just after the jump (10:30Z) -> 05:00 PDT Mar 14
    expect(snoozeUntilTomorrow(new Date('2027-03-14T10:30:00Z')).toISOString()).toBe('2027-03-14T12:00:00.000Z')
    // 22:00 PST Mar 13 (06:00Z Mar 14) -> 05:00 PDT Mar 14
    expect(snoozeUntilTomorrow(new Date('2027-03-14T06:00:00Z')).toISOString()).toBe('2027-03-14T12:00:00.000Z')
  })
})

describe('isOpenNow', () => {
  it('OPEN and WAITING are open', () => {
    expect(isOpenNow(item({ status: 'OPEN' }), NOW)).toBe(true)
    expect(isOpenNow(item({ status: 'WAITING' }), NOW)).toBe(true)
  })
  it('DONE is not open', () => {
    expect(isOpenNow(item({ status: 'DONE' }), NOW)).toBe(false)
  })
  it('SNOOZED reopens when snoozeUntil has passed', () => {
    expect(isOpenNow(item({ status: 'SNOOZED', snoozeUntil: '2026-10-30T17:59:00Z' }), NOW)).toBe(true)
    expect(isOpenNow(item({ status: 'SNOOZED', snoozeUntil: NOW.toISOString() }), NOW)).toBe(true)
    expect(isOpenNow(item({ status: 'SNOOZED', snoozeUntil: '2026-10-30T18:01:00Z' }), NOW)).toBe(false)
  })
})

describe('canSee', () => {
  it('STAFF never sees', () => {
    expect(canSee('STAFF', { managerOnly: false })).toBe(false)
  })
  it('LEAD sees normal items but not managerOnly ones', () => {
    expect(canSee('LEAD', { managerOnly: false })).toBe(true)
    expect(canSee('LEAD', { managerOnly: true })).toBe(false)
  })
  it('LEAD cannot see items in a managerOnly tag', () => {
    expect(canSee('LEAD', { managerOnly: false }, { managerOnly: true })).toBe(false)
  })
  it('MANAGER and above see everything', () => {
    expect(canSee('MANAGER', { managerOnly: true })).toBe(true)
    expect(canSee('MANAGER', { managerOnly: false }, { managerOnly: true })).toBe(true)
    expect(canSee('ADMIN', { managerOnly: true })).toBe(true)
    expect(canSee('OWNER', { managerOnly: true }, { managerOnly: true })).toBe(true)
  })
})

describe('flagTagId', () => {
  it('OUT_OF_RANGE always goes to Food safety', () => {
    expect(flagTagId('OUT_OF_RANGE', { OUT_OF_RANGE: 'tag-stock' }, tags)).toBe('tag-food_safety')
    expect(flagTagId('OUT_OF_RANGE', {}, tags)).toBe('tag-food_safety')
  })
  it('uses the routed tag when active', () => {
    expect(flagTagId('BROKEN', SEED_ROUTES, tags)).toBe('tag-maintenance')
    expect(flagTagId('RAN_OUT', SEED_ROUTES, tags)).toBe('tag-stock')
    expect(flagTagId('OTHER', SEED_ROUTES, tags)).toBe('tag-other')
  })
  it('falls back to Checklists with no route', () => {
    expect(flagTagId('BROKEN', {}, tags)).toBe('tag-checklists')
  })
  it('falls back to Checklists when the routed tag is inactive or unknown', () => {
    const archived = tags.map(t => (t.id === 'tag-maintenance' ? { ...t, isActive: false } : t))
    expect(flagTagId('BROKEN', SEED_ROUTES, archived)).toBe('tag-checklists')
    expect(flagTagId('BROKEN', { BROKEN: 'tag-nope' }, tags)).toBe('tag-checklists')
  })
})

describe('flagSeverity', () => {
  it('NOW for a blocker, TODAY otherwise', () => {
    expect(flagSeverity(true)).toBe('NOW')
    expect(flagSeverity(false)).toBe('TODAY')
  })
})

describe('groupItems', () => {
  it('orders NOW, TODAY, FYI and drops empty groups', () => {
    const a = { id: 'a', severity: 'FYI' as const }
    const b = { id: 'b', severity: 'NOW' as const }
    const c = { id: 'c', severity: 'NOW' as const }
    expect(groupItems([a, b, c])).toEqual([{ severity: 'NOW', items: [b, c] }, { severity: 'FYI', items: [a] }])
    expect(groupItems([])).toEqual([])
  })
})

describe('badgeCount', () => {
  it('counts visible open NOW/TODAY items only', () => {
    const items = [
      item({ id: '1', severity: 'NOW' }),
      item({ id: '2', severity: 'TODAY', status: 'WAITING' }),
      item({ id: '3', severity: 'FYI' }),
      item({ id: '4', severity: 'NOW', status: 'DONE' }),
      item({ id: '5', severity: 'NOW', status: 'SNOOZED', snoozeUntil: '2026-10-31T12:00:00Z' }),
      item({ id: '6', severity: 'TODAY', status: 'SNOOZED', snoozeUntil: '2026-10-30T12:00:00Z' }),
    ]
    expect(badgeCount(items, 'MANAGER', tagsById, NOW)).toBe(3)
  })
  it('hides managerOnly items and tags from a LEAD', () => {
    const items = [
      item({ id: '1', severity: 'NOW', managerOnly: true }),
      item({ id: '2', severity: 'NOW', tagId: 'tag-money' }),
      item({ id: '3', severity: 'NOW' }),
    ]
    expect(badgeCount(items, 'LEAD', tagsById, NOW)).toBe(1)
    expect(badgeCount(items, 'MANAGER', tagsById, NOW)).toBe(3)
  })
  it('is zero for STAFF', () => {
    expect(badgeCount([item()], 'STAFF', tagsById, NOW)).toBe(0)
  })
})

describe('seeds', () => {
  it('lists the nine tags in order with deterministic ids', () => {
    expect(SEED_TAGS.map(t => t.id)).toEqual([
      'tag-food_safety', 'tag-checklists', 'tag-prep', 'tag-stock', 'tag-money', 'tag-team',
      'tag-maintenance', 'tag-events', 'tag-other',
    ])
    expect(SEED_TAGS.map(t => t.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(SEED_TAGS.map(t => t.builtIn)).toEqual([
      'FOOD_SAFETY', 'CHECKLISTS', 'PREP', 'STOCK', 'MONEY', 'TEAM', null, null, null,
    ])
  })
  it('carries the colours and permissions', () => {
    const by = Object.fromEntries(SEED_TAGS.map(t => [t.id, t]))
    expect(by['tag-food_safety']).toMatchObject({ color: '#dc2626', cookCanPick: true, managerOnly: false })
    expect(by['tag-checklists']).toMatchObject({ color: '#2563eb', cookCanPick: false })
    expect(by['tag-prep']).toMatchObject({ color: '#16a34a', cookCanPick: true })
    expect(by['tag-stock']).toMatchObject({ color: '#0d9488', cookCanPick: true })
    expect(by['tag-money']).toMatchObject({ color: '#7c3aed', managerOnly: true, cookCanPick: false })
    expect(by['tag-team']).toMatchObject({ color: '#71717a', cookCanPick: false })
    expect(by['tag-maintenance']).toMatchObject({ name: 'Maintenance', color: '#ea580c', cookCanPick: true })
    expect(by['tag-events']).toMatchObject({ name: 'Events', color: '#db2777', cookCanPick: true })
    expect(by['tag-other']).toMatchObject({ name: 'Other', color: '#71717a', cookCanPick: true })
  })
  it('routes flag reasons', () => {
    expect(SEED_ROUTES).toEqual({ BROKEN: 'tag-maintenance', RAN_OUT: 'tag-stock', OTHER: 'tag-other' })
  })
})
