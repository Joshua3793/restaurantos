import { describe, it, expect, vi, beforeEach } from 'vitest'
import { matchWhere } from '@/test/match-where'

// ── A tiny in-memory Inbox behind a mocked Prisma ──────────────────────────

type Item = {
  id: string; sourceKey: string | null; source: string; status: string
  clearedAt: Date | null; doneById: string | null; doneAt?: Date | null; doneByName?: string | null
  snoozeUntil?: Date | null; title: string; body: string | null; revenueCenterId: string | null
  tagId?: string; severity?: string; managerOnly?: boolean; place?: string | null; href?: string | null
}
type Event = { itemId: string; kind: string; note: string | null }

let items: Item[] = []
let events: Event[] = []
let syncRows: Map<string, Date>
let seq = 0
let honestRead = false

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

const syncUpdateMany = vi.fn(async (a: { where: { revenueCenterId: string; at: { lt: Date } }; data: { at: Date } }) => {
  const at = syncRows.get(a.where.revenueCenterId)
  if (at && at < a.where.at.lt) { syncRows.set(a.where.revenueCenterId, a.data.at); return { count: 1 } }
  return { count: 0 }
})
const syncCreateMany = vi.fn(async (a: { data: { revenueCenterId: string; at: Date }[]; skipDuplicates: boolean }) => {
  // Real skipDuplicates: an existing row is skipped silently, never a P2002.
  let count = 0
  for (const r of a.data) {
    if (syncRows.has(r.revenueCenterId)) continue
    syncRows.set(r.revenueCenterId, r.at)
    count++
  }
  return { count }
})

type FindWhere = {
  source?: string
  sourceKey?: { startsWith?: string; in?: string[] }
  status?: { not: string }
  OR?: unknown[]
}
const itemFindMany = vi.fn(async (a: { where: FindWhere }) => {
  const w = a.where
  if (w.sourceKey?.startsWith) {
    return items.filter(i => i.source === 'SYSTEM' && i.sourceKey?.startsWith(w.sourceKey!.startsWith!) && i.status !== 'DONE')
  }
  if (w.sourceKey?.in) return items.filter(i => i.sourceKey && w.sourceKey!.in!.includes(i.sourceKey))
  // The sync's "existing" read. By default, deliberately over-fetch every
  // SYSTEM item, from every kitchen: the ownership guard — not the query —
  // must keep rc B safe. `honestRead` makes it apply the query as Postgres would.
  if (honestRead) return items.filter(i => matchWhere(i as unknown as Record<string, unknown>, w as Record<string, unknown>))
  return items.filter(i => i.source === 'SYSTEM')
})
const itemCreateMany = vi.fn(async (a: { data: Item[]; skipDuplicates: boolean }) => {
  let count = 0
  for (const row of a.data) {
    if (items.some(i => i.sourceKey === row.sourceKey)) continue
    items.push({ ...row, clearedAt: row.clearedAt ?? null, doneById: row.doneById ?? null })
    count++
  }
  return { count }
})
const itemUpdate = vi.fn(async (a: { where: { id: string }; data: Partial<Item> }) => {
  const it = items.find(i => i.id === a.where.id)!
  Object.assign(it, a.data)
  return it
})
const eventCreateMany = vi.fn(async (a: { data: Event[] }) => { events.push(...a.data); return { count: a.data.length } })

type GuardWhere = { id: string; status: string | { not: string }; clearedAt?: { not: null } | null }
const matches = (i: Item, w: GuardWhere) =>
  i.id === w.id &&
  (typeof w.status === 'string' ? i.status === w.status : i.status !== w.status.not) &&
  (w.clearedAt === null ? i.clearedAt == null : w.clearedAt ? i.clearedAt != null : true)
const guardedUpdate = async (a: { where: GuardWhere; data: Partial<Item> }) => {
  const hit = items.filter(i => matches(i, a.where))
  hit.forEach(i => Object.assign(i, a.data))
  return { count: hit.length }
}
const itemUpdateMany = vi.fn(guardedUpdate)
const tx = {
  inboxItem: {
    updateMany: vi.fn(guardedUpdate),
  },
  inboxEvent: {
    create: vi.fn(async (a: { data: Event }) => { events.push(a.data); return a.data }),
  },
}

const priceAlertFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const pinDeviceFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const stationFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const runFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
/** checklistRun.findMany for the "aged out of the close window" lookup (by id). */
const agedRuns = (ids: string[]) => runFindMany.mockImplementation(async (a?: unknown) => {
  const w = (a as { where: { id?: { in: string[] } } }).where
  return w.id ? w.id.in.filter(id => ids.includes(id)).map(id => ({ id })) : []
})
const countFindFirst = vi.fn()
const rcFindUnique = vi.fn(async () => ({ isDefault: false }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboxSync: { updateMany: (a: never) => syncUpdateMany(a), createMany: (a: never) => syncCreateMany(a) },
    inboxItem: {
      findMany: (a: never) => itemFindMany(a),
      createMany: (a: never) => itemCreateMany(a),
      update: (a: never) => itemUpdate(a),
      updateMany: (a: never) => itemUpdateMany(a),
    },
    inboxEvent: { createMany: (a: never) => eventCreateMany(a) },
    inboxTag: {
      findMany: async () => [
        { id: 'tag-food_safety', builtIn: 'FOOD_SAFETY' }, { id: 'tag-checklists', builtIn: 'CHECKLISTS' },
        { id: 'tag-prep', builtIn: 'PREP' }, { id: 'tag-stock', builtIn: 'STOCK' },
        { id: 'tag-money-renamed', builtIn: 'MONEY' }, { id: 'tag-team', builtIn: 'TEAM' },
      ],
    },
    priceAlert: { findMany: (a: never) => priceAlertFindMany(a) },
    pinDevice: { findMany: (a: never) => pinDeviceFindMany(a) },
    checklistStation: { findMany: (a: never) => stationFindMany(a) },
    checklistRun: { findMany: (a: never) => runFindMany(a) },
    countSession: { findFirst: (a: never) => countFindFirst(a) },
    revenueCenter: { findUnique: () => rcFindUnique() },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  },
}))

const ensureInboxSeeded = vi.fn(async () => {})
const loadTempUnits = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
const loadPrepItems = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
const countInvoicesAwaiting = vi.fn(async (..._a: unknown[]) => 0)
vi.mock('@/lib/inbox/tags', () => ({ ensureInboxSeeded: () => ensureInboxSeeded() }))
vi.mock('@/lib/temps/units', () => ({ loadTempUnits: (...a: unknown[]) => loadTempUnits(...a) }))
vi.mock('@/lib/prep-items-server', () => ({ loadPrepItems: (...a: unknown[]) => loadPrepItems(...a) }))
vi.mock('@/lib/checklists/applicable', () => ({ applicableJobCounts: async () => new Map() }))
vi.mock('@/lib/invoice-awaiting', () => ({
  invoiceRcWhere: () => ({}),
  countInvoicesAwaiting: (...a: unknown[]) => countInvoicesAwaiting(...a),
}))

const { syncSystemItems, CLEARED_ITSELF } = await import('@/lib/inbox/system')
const { CLEAR_NOTES } = await import('@/lib/inbox/conditions')

const NOW = new Date('2026-10-30T16:00:00Z') // 09:00 Pacific — the opening window
const DATE = '2026-10-30'
const item = (o: Partial<Item>): Item => ({
  id: `i${++seq}`, sourceKey: null, source: 'SYSTEM', status: 'OPEN', clearedAt: null, doneById: null,
  title: 'x', body: null, revenueCenterId: 'rcA', ...o,
})
const find = (key: string) => items.find(i => i.sourceKey === key)
const eventsFor = (key: string) => events.filter(e => e.itemId === find(key)?.id)

let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  items = []
  events = []
  seq = 0
  honestRead = false
  syncRows = new Map()
  countFindFirst.mockResolvedValue({ status: 'FINALIZED', finalizedAt: new Date(NOW.getTime() - 86_400_000) })
  countInvoicesAwaiting.mockResolvedValue(0)
  loadPrepItems.mockResolvedValue([])
  runFindMany.mockResolvedValue([])
  priceAlertFindMany.mockResolvedValue([])
  pinDeviceFindMany.mockResolvedValue([])
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('syncSystemItems — throttle', () => {
  it('skips when this kitchen synced 30 s ago: reads nothing, writes nothing', async () => {
    syncRows.set('rcA', new Date(NOW.getTime() - 30_000))
    countInvoicesAwaiting.mockResolvedValue(3)
    await syncSystemItems('rcA', NOW)
    expect(ensureInboxSeeded).not.toHaveBeenCalled()
    expect(countInvoicesAwaiting).not.toHaveBeenCalled()
    expect(itemCreateMany).not.toHaveBeenCalled()
    expect(syncRows.get('rcA')).toEqual(new Date(NOW.getTime() - 30_000))
    // One conditional write, no unique-violation: the insert just skips.
    expect(syncCreateMany).toHaveBeenCalledWith({ data: [{ revenueCenterId: 'rcA', at: NOW }], skipDuplicates: true })
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('the first sync for a kitchen inserts its row and goes ahead', async () => {
    await syncSystemItems('rcA', NOW)
    expect(syncRows.get('rcA')).toEqual(NOW)
    expect(countInvoicesAwaiting).toHaveBeenCalled()
  })

  it('of two racing first syncs only the one whose insert lands goes ahead', async () => {
    // The other request inserts between our update (0 rows) and our insert.
    syncUpdateMany.mockImplementationOnce(async () => {
      syncRows.set('rcA', NOW)
      return { count: 0 }
    })
    await syncSystemItems('rcA', NOW)
    expect(countInvoicesAwaiting).not.toHaveBeenCalled()
  })

  it('runs again once a minute has passed, and stamps the time', async () => {
    syncRows.set('rcA', new Date(NOW.getTime() - 90_000))
    await syncSystemItems('rcA', NOW)
    expect(countInvoicesAwaiting).toHaveBeenCalled()
    expect(syncRows.get('rcA')).toEqual(NOW)
  })

  it('keeps one throttle row per kitchen, and one for the whole house', async () => {
    syncRows.set('rcA', new Date(NOW.getTime() - 30_000))
    await syncSystemItems('rcB', NOW)
    await syncSystemItems(null, NOW)
    expect(syncRows.get('rcB')).toEqual(NOW)
    expect(syncRows.get('__global__')).toEqual(NOW)
  })
})

describe('syncSystemItems — reconcile', () => {
  it('creates new items OPEN with a RAISED event, tag found by built-in (not by id)', async () => {
    countInvoicesAwaiting.mockResolvedValue(3)
    await syncSystemItems('rcA', NOW)
    expect(itemCreateMany.mock.calls[0][0].skipDuplicates).toBe(true)
    expect(find('invoices:rcA')).toMatchObject({
      source: 'SYSTEM', status: 'OPEN', tagId: 'tag-money-renamed', severity: 'TODAY',
      title: '3 invoices to approve', managerOnly: true, revenueCenterId: 'rcA', href: '/invoices',
    })
    expect(eventsFor('invoices:rcA')).toEqual([{ itemId: find('invoices:rcA')!.id, kind: 'RAISED', note: 'Prices update when you approve' }])
  })

  it('clears an open item whose condition went away, with a CLEARED "Cleared itself" event', async () => {
    items.push(item({ sourceKey: 'invoices:rcA', title: '2 invoices to approve' }))
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')).toMatchObject({ status: 'DONE', clearedAt: NOW, doneById: null })
    expect(eventsFor('invoices:rcA')).toEqual([expect.objectContaining({ kind: 'CLEARED', note: CLEARED_ITSELF })])
  })

  it('clears snoozed and waiting items too', async () => {
    items.push(item({ sourceKey: 'count-stale:rcA', status: 'SNOOZED', snoozeUntil: NOW }))
    items.push(item({ sourceKey: `temp-missing:rcA:${DATE}`, status: 'WAITING' }))
    await syncSystemItems('rcA', NOW)
    expect(find('count-stale:rcA')!.status).toBe('DONE')
    expect(find(`temp-missing:rcA:${DATE}`)!.status).toBe('DONE')
  })

  it('reopens an item that cleared itself when the condition comes back', async () => {
    items.push(item({ sourceKey: 'invoices:rcA', status: 'DONE', clearedAt: new Date(NOW.getTime() - 3600_000), title: '1 invoice to approve' }))
    countInvoicesAwaiting.mockResolvedValue(2)
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')).toMatchObject({ status: 'OPEN', clearedAt: null, title: '2 invoices to approve' })
    expect(eventsFor('invoices:rcA').map(e => e.kind)).toEqual(['REOPENED'])
    expect(itemCreateMany).not.toHaveBeenCalled()
  })

  it('leaves an item a person marked done alone, even with the condition still there', async () => {
    items.push(item({ sourceKey: 'invoices:rcA', status: 'DONE', doneById: 'u-mgr', title: '1 invoice to approve' }))
    countInvoicesAwaiting.mockResolvedValue(2)
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')).toMatchObject({ status: 'DONE', doneById: 'u-mgr', title: '1 invoice to approve' })
    expect(events).toEqual([])
    expect(itemCreateMany).not.toHaveBeenCalled()
  })

  it('a changed count updates the open item’s title with no event', async () => {
    items.push(item({ sourceKey: 'invoices:rcA', title: '3 invoices to approve', body: 'Prices update when you approve' }))
    countInvoicesAwaiting.mockResolvedValue(4)
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')).toMatchObject({ status: 'OPEN', title: '4 invoices to approve' })
    expect(events).toEqual([])
  })

  it('an unchanged item is not written at all', async () => {
    items.push(item({ sourceKey: 'invoices:rcA', title: '3 invoices to approve', body: 'Prices update when you approve' }))
    countInvoicesAwaiting.mockResolvedValue(3)
    await syncSystemItems('rcA', NOW)
    expect(itemUpdate).not.toHaveBeenCalled()
  })

  it('a P2002 on create does not throw, and the rest of the sync still runs', async () => {
    itemCreateMany.mockRejectedValueOnce(P2002)
    items.push(item({ sourceKey: 'count-stale:rcA' }))
    countInvoicesAwaiting.mockResolvedValue(3)
    await expect(syncSystemItems('rcA', NOW)).resolves.toBeUndefined()
    expect(find('count-stale:rcA')!.status).toBe('DONE')
  })

  it('a row a concurrent sync inserted first gets no second RAISED event', async () => {
    countInvoicesAwaiting.mockResolvedValue(3)
    itemCreateMany.mockImplementationOnce(async () => {
      items.push(item({ id: 'theirs', sourceKey: 'invoices:rcA' }))
      return { count: 0 }
    })
    await syncSystemItems('rcA', NOW)
    expect(eventCreateMany).not.toHaveBeenCalled()
  })

  it('a sync for rc A never clears rc B’s items (even when the read returns them)', async () => {
    items.push(item({ sourceKey: 'invoices:rcB', revenueCenterId: 'rcB' }))
    items.push(item({ sourceKey: 'count-stale:rcB', revenueCenterId: 'rcB' }))
    items.push(item({ sourceKey: `temp-missing:rcB:${DATE}`, revenueCenterId: 'rcB' }))
    items.push(item({ sourceKey: `prep:p9:${DATE}`, revenueCenterId: 'rcB' }))
    items.push(item({ sourceKey: 'close-unsigned:r9', revenueCenterId: 'rcB' }))
    await syncSystemItems('rcA', NOW)
    expect(items.every(i => i.status === 'OPEN')).toBe(true)
    expect(events).toEqual([])
  })

  it('reads only this kitchen’s and whole-house open items, plus the keys present now', async () => {
    countInvoicesAwaiting.mockResolvedValue(1)
    await syncSystemItems('rcA', NOW)
    const existingRead = itemFindMany.mock.calls.map(c => c[0]).find(a => a.where.OR)!
    expect(existingRead.where).toEqual({
      source: 'SYSTEM',
      OR: [
        { sourceKey: { in: ['invoices:rcA'] } },
        { status: { not: 'DONE' }, OR: [{ revenueCenterId: 'rcA' }, { revenueCenterId: null }] },
        {
          status: 'DONE', clearedAt: null,
          OR: [{ revenueCenterId: 'rcA' }, { revenueCenterId: null }],
          AND: [{
            OR: [
              { doneAt: { gte: new Date(NOW.getTime() - 30 * 86_400_000) } },
              { sourceKey: { startsWith: 'invoices:' } },
              { sourceKey: { startsWith: 'count-stale:' } },
            ],
          }],
        },
      ],
    })
  })

  it('whole-house price items clear once the alert is acknowledged elsewhere', async () => {
    items.push(item({ sourceKey: 'price:pa1', revenueCenterId: null, managerOnly: true }))
    priceAlertFindMany.mockResolvedValue([])
    await syncSystemItems('rcA', NOW)
    expect(find('price:pa1')!.status).toBe('DONE')
    // An open price item's alert is read whatever its age, so it never ages out silently.
    expect(priceAlertFindMany.mock.calls[0][0]).toMatchObject({
      where: { acknowledged: false, direction: 'UP', OR: [expect.anything(), { id: { in: ['pa1'] } }] },
    })
  })

  it('a price rise and a pending phone become whole-house, manager-only items', async () => {
    priceAlertFindMany.mockResolvedValue([{
      id: 'pa1', changePct: '12.4', direction: 'UP',
      inventoryItem: { itemName: 'Goats Cheese' }, session: { supplierName: 'Sysco' },
    }])
    pinDeviceFindMany.mockResolvedValue([{
      id: 'd1', status: 'PENDING', createdAt: new Date(NOW.getTime() - 600_000), tokenHash: 'abc123',
      cook: { name: 'Sam', lastName: 'Lee', isActive: true, user: null },
    }])
    await syncSystemItems('rcA', NOW)
    expect(find('price:pa1')).toMatchObject({ title: 'Goats Cheese up 12% at Sysco', revenueCenterId: null, managerOnly: true })
    expect(find('phone:d1')).toMatchObject({
      title: "Sam Lee's phone wants your OK", tagId: 'tag-team', revenueCenterId: null, managerOnly: true,
    })
    expect(find('phone:d1')!.body).toMatch(/^Code /)
  })
})

describe('syncSystemItems — failures', () => {
  it('a failing source is logged; the others still sync, and its own items are not cleared', async () => {
    loadPrepItems.mockRejectedValue(new Error('theoretical stock blew up'))
    items.push(item({ sourceKey: `prep:p1:${DATE}` }))
    countInvoicesAwaiting.mockResolvedValue(2)
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')!.status).toBe('OPEN')
    expect(find(`prep:p1:${DATE}`)!.status).toBe('OPEN')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('source=prep'), expect.any(Error))
  })

  it('never throws to the caller, even when the throttle table fails', async () => {
    syncUpdateMany.mockRejectedValueOnce(new Error('db down'))
    await expect(syncSystemItems('rcA', NOW)).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
  })

  it('a clear that fails does not stop the next one', async () => {
    items.push(item({ sourceKey: 'invoices:rcA' }))
    items.push(item({ sourceKey: 'count-stale:rcA' }))
    tx.inboxItem.updateMany.mockRejectedValueOnce(new Error('deadlock'))
    await syncSystemItems('rcA', NOW)
    expect(find('count-stale:rcA')!.status).toBe('DONE')
  })
})

describe('syncSystemItems — a person-closed alert comes back', () => {
  it('invoices: done by a person → condition gone → re-armed (no event) → present → reopened', async () => {
    items.push(item({
      sourceKey: 'invoices:rcA', status: 'DONE', doneById: 'u-mgr', doneByName: 'Max',
      doneAt: new Date(NOW.getTime() - 3600_000), title: '2 invoices to approve',
    }))
    // Still waiting: the manager said it's handled — leave it.
    countInvoicesAwaiting.mockResolvedValue(2)
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcA')).toMatchObject({ status: 'DONE', clearedAt: null })

    // All approved: re-armed quietly.
    const t1 = new Date(NOW.getTime() + 2 * 60_000)
    countInvoicesAwaiting.mockResolvedValue(0)
    await syncSystemItems('rcA', t1)
    expect(find('invoices:rcA')).toMatchObject({ status: 'DONE', clearedAt: t1, doneById: 'u-mgr' })
    expect(events).toEqual([])

    // New invoices arrive: the same item reopens.
    const t2 = new Date(NOW.getTime() + 4 * 60_000)
    countInvoicesAwaiting.mockResolvedValue(1)
    await syncSystemItems('rcA', t2)
    expect(find('invoices:rcA')).toMatchObject({ status: 'OPEN', clearedAt: null, doneById: null, title: '1 invoice to approve' })
    expect(eventsFor('invoices:rcA').map(e => e.kind)).toEqual(['REOPENED'])
    expect(itemCreateMany).not.toHaveBeenCalled()
  })

  it('count-stale: a person-closed item re-arms once a new count lands', async () => {
    items.push(item({ sourceKey: 'count-stale:rcA', status: 'DONE', doneById: 'u-mgr', doneAt: NOW }))
    await syncSystemItems('rcA', NOW) // default count: yesterday — not stale
    expect(find('count-stale:rcA')!.clearedAt).toEqual(NOW)
  })

  // Read the real query (no over-fetch), a minute apart so the throttle lets each sync run.
  const DAY = 86_400_000
  const at = (days: number) => new Date(NOW.getTime() + days * DAY)
  const finalizedDaysBefore = (when: Date, days: number) =>
    countFindFirst.mockResolvedValue({ status: 'FINALIZED', finalizedAt: new Date(when.getTime() - days * DAY) })

  it('count-stale: closed by a person, stale for 40 days, then counted — re-arms and comes back', async () => {
    honestRead = true
    // Day 0: "Count is 5 days old", marked done by a manager.
    items.push(item({ sourceKey: 'count-stale:rcA', status: 'DONE', doneById: 'u-mgr', doneByName: 'Max', doneAt: NOW }))
    // Day 33: still stale, and the manager's close is now older than 30 days.
    finalizedDaysBefore(at(33), 38)
    await syncSystemItems('rcA', at(33))
    expect(find('count-stale:rcA')).toMatchObject({ status: 'DONE', clearedAt: null })
    // Day 40: the kitchen counts. The old close must still be found and re-armed.
    finalizedDaysBefore(at(40), 0)
    await syncSystemItems('rcA', at(40))
    expect(find('count-stale:rcA')!.clearedAt).toEqual(at(40))
    // Day 47: stale again — the alert comes back.
    finalizedDaysBefore(at(47), 7)
    await syncSystemItems('rcA', at(47))
    expect(find('count-stale:rcA')).toMatchObject({ status: 'OPEN', clearedAt: null, doneById: null })
    expect(eventsFor('count-stale:rcA').map(e => e.kind)).toEqual(['REOPENED'])
  })

  it('invoices: a backlog older than 30 days after the close still re-arms once cleared', async () => {
    honestRead = true
    items.push(item({ sourceKey: 'invoices:rcA', status: 'DONE', doneById: 'u-mgr', doneAt: NOW, title: '2 invoices to approve' }))
    countInvoicesAwaiting.mockResolvedValue(0)
    await syncSystemItems('rcA', at(45))
    expect(find('invoices:rcA')!.clearedAt).toEqual(at(45))
    countInvoicesAwaiting.mockResolvedValue(1)
    await syncSystemItems('rcA', at(46))
    expect(find('invoices:rcA')).toMatchObject({ status: 'OPEN', title: '1 invoice to approve' })
  })

  it('a daily key closed more than 30 days ago is left alone (the lookback still holds)', async () => {
    honestRead = true
    items.push(item({ sourceKey: 'temp-missing:rcA:2026-09-01', status: 'DONE', doneById: 'u-mgr', doneAt: at(-40) }))
    await syncSystemItems('rcA', NOW)
    expect(find('temp-missing:rcA:2026-09-01')!.clearedAt).toBeNull()
  })

  it('never re-arms another kitchen’s person-closed item', async () => {
    items.push(item({ sourceKey: 'invoices:rcB', revenueCenterId: 'rcB', status: 'DONE', doneById: 'u-mgr', doneAt: NOW }))
    await syncSystemItems('rcA', NOW)
    expect(find('invoices:rcB')!.clearedAt).toBeNull()
  })
})

describe('syncSystemItems — every clear says why', () => {
  const noteOf = (key: string) => eventsFor(key).find(e => e.kind === 'CLEARED')?.note

  it('"Cleared itself" when today’s condition genuinely went away', async () => {
    items.push(item({ sourceKey: `temp-missing:rcA:${DATE}` }))
    items.push(item({ sourceKey: 'invoices:rcA' }))
    await syncSystemItems('rcA', NOW)
    expect(noteOf(`temp-missing:rcA:${DATE}`)).toBe(CLEAR_NOTES.resolved)
    expect(noteOf('invoices:rcA')).toBe(CLEARED_ITSELF)
  })

  it('"Opening window ended — never started" for a station once the phase is CLOSE', async () => {
    const afternoon = new Date('2026-10-30T22:00:00Z') // 15:00 Pacific
    items.push(item({ sourceKey: `station-open:s1:${DATE}` }))
    await syncSystemItems('rcA', afternoon)
    expect(find(`station-open:s1:${DATE}`)!.status).toBe('DONE')
    expect(noteOf(`station-open:s1:${DATE}`)).toBe(CLEAR_NOTES.openingEnded)
  })

  it('"Day ended — not fixed" for yesterday’s dated keys', async () => {
    const keys = [
      'temp-bad:u1:2026-10-29', 'temp-missing:rcA:2026-10-29', 'station-open:s1:2026-10-29', 'prep:p1:2026-10-29',
    ]
    for (const k of keys) items.push(item({ sourceKey: k }))
    await syncSystemItems('rcA', NOW)
    for (const k of keys) expect(noteOf(k)).toBe(CLEAR_NOTES.dayEnded)
  })

  it('"Older than 2 days — never signed" for a closing list that left the window unsigned', async () => {
    items.push(item({ sourceKey: 'close-unsigned:r1' }))
    items.push(item({ sourceKey: 'close-unsigned:r2' }))
    agedRuns(['r1']) // r2 was signed (or is gone)
    await syncSystemItems('rcA', NOW)
    expect(noteOf('close-unsigned:r1')).toBe(CLEAR_NOTES.closeAged)
    expect(noteOf('close-unsigned:r2')).toBe(CLEAR_NOTES.resolved)
  })

  it('a failed age check leaves the closing items as they are — no false "Cleared itself"', async () => {
    items.push(item({ sourceKey: 'close-unsigned:r1' }))
    runFindMany.mockImplementation(async (a?: unknown) => {
      if ((a as { where: { id?: unknown } }).where.id) throw new Error('timeout')
      return [] // the window read worked: r1 is no longer in it
    })
    await syncSystemItems('rcA', NOW)
    expect(find('close-unsigned:r1')!.status).toBe('OPEN')
    expect(eventsFor('close-unsigned:r1')).toEqual([])
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('source=closeAged'), expect.any(Error))
  })
})
