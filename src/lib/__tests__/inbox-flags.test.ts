import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Prisma } from '@prisma/client'

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/checklists/who', () => ({ whoOf: async () => ({ id: 'u1', name: 'Sam' }) }))
vi.mock('@/lib/rc-scope', () => ({ isRcInScope: () => true, assertRcWritable: async () => {} }))

const { syncFlagItem, closeFlagItem } = await import('@/lib/inbox/flags')
const { onItemDone } = await import('@/lib/inbox/store')

const TAGS = [
  { id: 'tag-food_safety', builtIn: 'FOOD_SAFETY', name: 'Food safety', color: '#dc2626', cookCanPick: true, managerOnly: false, isActive: true },
  { id: 'tag-checklists', builtIn: 'CHECKLISTS', name: 'Checklists', color: '#2563eb', cookCanPick: false, managerOnly: false, isActive: true },
  { id: 'tag-stock', builtIn: 'STOCK', name: 'Stock', color: '#0d9488', cookCanPick: true, managerOnly: false, isActive: true },
  { id: 'tag-money', builtIn: 'MONEY', name: 'Money', color: '#7c3aed', cookCanPick: false, managerOnly: true, isActive: true },
]
let routes: { reason: string; tagId: string }[] = []

const itemFind = vi.fn()
const itemCreate = vi.fn()
const itemUpdate = vi.fn()
const eventCreate = vi.fn()
const lineUpdateMany = vi.fn()
const priceAlertUpdateMany = vi.fn()
const tx = {
  inboxItem: { findUnique: itemFind, create: itemCreate, update: itemUpdate },
  inboxEvent: { create: eventCreate },
  inboxTag: { findMany: async () => TAGS },
  inboxFlagRoute: { findMany: async () => routes },
  checklistRunLine: { updateMany: lineUpdateMany },
  priceAlert: { updateMany: priceAlertUpdateMany },
} as unknown as Prisma.TransactionClient

const who = { id: 'u1', name: 'Sam' }
const station = { name: 'Grill', revenueCenterId: 'rc1' }
const run = { id: 'r1' }
const flagged = (over: Record<string, unknown> = {}) => ({
  id: 'l1', title: 'Walk-in temp', isBlocker: true, status: 'FLAGGED' as const,
  flagReason: 'RAN_OUT', flagNote: 'no gloves', value: null, unit: null, ...over,
})
const sync = (line: ReturnType<typeof flagged>) => syncFlagItem(tx, { line, run, station, who })

beforeEach(() => {
  vi.clearAllMocks()
  routes = [{ reason: 'RAN_OUT', tagId: 'tag-stock' }]
  itemFind.mockResolvedValue(null)
  itemCreate.mockResolvedValue({ id: 'i1' })
})

describe('syncFlagItem — a flagged job', () => {
  it('creates the item on the routed tag, with a RAISED event', async () => {
    await sync(flagged())
    expect(itemFind).toHaveBeenCalledWith({ where: { sourceKey: 'flag:l1' }, select: { id: true, status: true } })
    expect(itemCreate).toHaveBeenCalledWith({
      data: {
        tagId: 'tag-stock', severity: 'NOW', title: 'Walk-in temp · Ran out', body: 'no gloves', managerOnly: false,
        sourceKey: 'flag:l1', source: 'FLAG', status: 'OPEN', place: 'Grill', revenueCenterId: 'rc1',
        href: '/checklist/today', raisedById: 'u1', raisedByName: 'Sam',
      },
      select: { id: true },
    })
    expect(eventCreate).toHaveBeenCalledTimes(1)
    expect(eventCreate).toHaveBeenCalledWith({
      data: { itemId: 'i1', kind: 'RAISED', byId: 'u1', byName: 'Sam', note: 'no gloves' },
    })
    expect(itemUpdate).not.toHaveBeenCalled()
  })

  it('a non-blocker is TODAY; an unrouted reason falls back to Checklists; no note means no body', async () => {
    await sync(flagged({ isBlocker: false, flagReason: 'OTHER', flagNote: null }))
    expect(itemCreate.mock.calls[0][0].data).toMatchObject({
      tagId: 'tag-checklists', severity: 'TODAY', title: 'Walk-in temp · Flagged', body: null,
    })
  })

  it('copies a manager-only tag onto the item', async () => {
    routes = [{ reason: 'RAN_OUT', tagId: 'tag-money' }]
    await sync(flagged())
    expect(itemCreate.mock.calls[0][0].data).toMatchObject({ tagId: 'tag-money', managerOnly: true })
  })

  it('caps the title at 120 characters', async () => {
    await sync(flagged({ title: 'x'.repeat(200) }))
    expect(itemCreate.mock.calls[0][0].data.title).toHaveLength(120)
  })

  it('OUT_OF_RANGE always lands in Food safety, even when a route exists, and reads the value', async () => {
    routes = [{ reason: 'OUT_OF_RANGE', tagId: 'tag-stock' }]
    await sync(flagged({ flagReason: 'OUT_OF_RANGE', flagNote: null, value: 9, unit: '°C' }))
    expect(itemCreate.mock.calls[0][0].data).toMatchObject({
      tagId: 'tag-food_safety', title: 'Walk-in temp · Out of range', body: 'Read 9 °C',
    })
  })

  it('OUT_OF_RANGE without a unit trims the body', async () => {
    await sync(flagged({ flagReason: 'OUT_OF_RANGE', value: '12.5', unit: null }))
    expect(itemCreate.mock.calls[0][0].data.body).toBe('Read 12.5')
  })

  it('re-flagging after the item was done reopens it with a REOPENED event', async () => {
    itemFind.mockResolvedValue({ id: 'i1', status: 'DONE' })
    await sync(flagged())
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: {
        tagId: 'tag-stock', severity: 'NOW', title: 'Walk-in temp · Ran out', body: 'no gloves', managerOnly: false,
        status: 'OPEN', snoozeUntil: null, clearedAt: null, doneById: null, doneByName: null, doneAt: null,
      },
    })
    expect(eventCreate).toHaveBeenCalledWith({
      data: { itemId: 'i1', kind: 'REOPENED', byId: 'u1', byName: 'Sam', note: null },
    })
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('re-flagging an open item just refreshes it: no event, status untouched', async () => {
    itemFind.mockResolvedValue({ id: 'i1', status: 'WAITING' })
    await sync(flagged({ flagReason: 'OTHER', flagNote: 'new note' }))
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { severity: 'NOW', title: 'Walk-in temp · Flagged', body: 'new note' },
    })
    expect(eventCreate).not.toHaveBeenCalled()
    expect(itemCreate).not.toHaveBeenCalled()
  })

  it('a cook re-saving their flag never undoes a manager re-filing it into Money', async () => {
    // A manager moved the open item into Money (manager-only). The cook then
    // edits their note on the same line: the item must stay where it was put.
    itemFind.mockResolvedValue({ id: 'i1', status: 'OPEN', tagId: 'tag-money', managerOnly: true })
    await sync(flagged({ flagNote: 'still no gloves' }))
    const data = itemUpdate.mock.calls[0][0].data
    expect(data).not.toHaveProperty('tagId')
    expect(data).not.toHaveProperty('managerOnly')
    expect(data).toMatchObject({ body: 'still no gloves' })
  })
})

describe('syncFlagItem — a job that is no longer flagged', () => {
  const ticked = () => flagged({ status: 'DONE', flagReason: null, flagNote: null })

  it('an untick or re-answer clears the open item, naming nobody as the fixer', async () => {
    itemFind.mockResolvedValue({ id: 'i1', status: 'OPEN' })
    await sync(ticked())
    expect(itemUpdate).toHaveBeenCalledTimes(1)
    const arg = itemUpdate.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'i1' })
    expect(arg.data).toMatchObject({ status: 'DONE', snoozeUntil: null, doneById: null, doneByName: null, doneAt: null })
    expect(arg.data.clearedAt).toBeInstanceOf(Date)
    expect(eventCreate).toHaveBeenCalledWith({
      data: { itemId: 'i1', kind: 'CLEARED', byId: 'u1', byName: 'Sam', note: 'Cleared itself — the job was redone' },
    })
  })

  it('clears a snoozed or waiting item too', async () => {
    itemFind.mockResolvedValue({ id: 'i1', status: 'SNOOZED' })
    await sync(ticked())
    expect(itemUpdate).toHaveBeenCalledTimes(1)
  })

  it('does nothing when there is no item, or it is already done', async () => {
    await sync(ticked())
    itemFind.mockResolvedValue({ id: 'i1', status: 'DONE' })
    await sync(ticked())
    expect(itemUpdate).not.toHaveBeenCalled()
    expect(eventCreate).not.toHaveBeenCalled()
    expect(itemCreate).not.toHaveBeenCalled()
  })
})

describe('closeFlagItem — the board marks the job fixed', () => {
  it('marks the open item DONE by the resolver, with a DONE event', async () => {
    itemFind.mockResolvedValue({ id: 'i1', status: 'OPEN' })
    const now = new Date('2026-10-30T18:00:00Z')
    await closeFlagItem(tx, 'l1', { id: 'u9', name: 'Lena' }, now)
    expect(itemFind).toHaveBeenCalledWith({ where: { sourceKey: 'flag:l1' }, select: { id: true, status: true } })
    expect(itemUpdate).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { status: 'DONE', snoozeUntil: null, clearedAt: null, doneById: 'u9', doneByName: 'Lena', doneAt: now },
    })
    expect(eventCreate).toHaveBeenCalledWith({
      data: { itemId: 'i1', kind: 'DONE', byId: 'u9', byName: 'Lena', note: null },
    })
  })

  it('does nothing without an item, or one that is already done', async () => {
    await closeFlagItem(tx, 'l1', who)
    itemFind.mockResolvedValue({ id: 'i1', status: 'DONE' })
    await closeFlagItem(tx, 'l1', who)
    expect(itemUpdate).not.toHaveBeenCalled()
    expect(eventCreate).not.toHaveBeenCalled()
  })
})

describe('onItemDone — an Inbox done closes the job', () => {
  it('resolves the flagged, unresolved line behind a FLAG item', async () => {
    await onItemDone({ id: 'i1', source: 'FLAG', sourceKey: 'flag:l1', revenueCenterId: 'rc1' }, { id: 'u9', name: 'Lena' }, tx)
    expect(lineUpdateMany).toHaveBeenCalledTimes(1)
    const arg = lineUpdateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ id: 'l1', status: 'FLAGGED', resolvedAt: null })
    expect(arg.data).toMatchObject({ resolvedById: 'u9', resolvedByName: 'Lena' })
    expect(arg.data.resolvedAt).toBeInstanceOf(Date)
  })

  it('leaves lines alone for report items and other keys', async () => {
    await onItemDone({ id: 'i2', source: 'REPORT', sourceKey: null, revenueCenterId: null }, who, tx)
    await onItemDone({ id: 'i3', source: 'SYSTEM', sourceKey: 'price:abc', revenueCenterId: null }, who, tx)
    await onItemDone({ id: 'i4', source: 'FLAG', sourceKey: null, revenueCenterId: null }, who, tx)
    expect(lineUpdateMany).not.toHaveBeenCalled()
  })

  it('a price-rise item acknowledges its PriceAlert; nothing else does', async () => {
    await onItemDone({ id: 'i3', source: 'SYSTEM', sourceKey: 'price:abc', revenueCenterId: null }, who, tx)
    expect(priceAlertUpdateMany).toHaveBeenCalledWith({
      where: { id: 'abc', acknowledged: false }, data: { acknowledged: true },
    })
    priceAlertUpdateMany.mockClear()
    await onItemDone({ id: 'i5', source: 'SYSTEM', sourceKey: 'invoices:rc1', revenueCenterId: 'rc1' }, who, tx)
    await onItemDone({ id: 'i6', source: 'FLAG', sourceKey: 'flag:l1', revenueCenterId: 'rc1' }, who, tx)
    await onItemDone({ id: 'i7', source: 'REPORT', sourceKey: null, revenueCenterId: null }, who, tx)
    expect(priceAlertUpdateMany).not.toHaveBeenCalled()
  })
})
