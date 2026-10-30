import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

const syncUpdateMany = vi.fn(async (a: { where: { revenueCenterId: string; at: { lt: Date } }; data: { at: Date } }) => {
  const at = syncRows.get(a.where.revenueCenterId)
  if (at && at < a.where.at.lt) { syncRows.set(a.where.revenueCenterId, a.data.at); return { count: 1 } }
  return { count: 0 }
})
const syncCreate = vi.fn(async (a: { data: { revenueCenterId: string; at: Date } }) => {
  if (syncRows.has(a.data.revenueCenterId)) throw P2002
  syncRows.set(a.data.revenueCenterId, a.data.at)
  return a.data
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
  // The sync's "existing" read. Deliberately over-fetch every SYSTEM item, from
  // every kitchen: the ownership guard — not the query — must keep rc B safe.
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

type GuardWhere = { id: string; status: string | { not: string }; clearedAt?: { not: null } }
const matches = (i: Item, w: GuardWhere) =>
  i.id === w.id &&
  (typeof w.status === 'string' ? i.status === w.status : i.status !== w.status.not) &&
  (w.clearedAt ? i.clearedAt != null : true)
const tx = {
  inboxItem: {
    updateMany: vi.fn(async (a: { where: GuardWhere; data: Partial<Item> }) => {
      const hit = items.filter(i => matches(i, a.where))
      hit.forEach(i => Object.assign(i, a.data))
      return { count: hit.length }
    }),
  },
  inboxEvent: {
    create: vi.fn(async (a: { data: Event }) => { events.push(a.data); return a.data }),
  },
}

const priceAlertFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const pinDeviceFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const stationFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const runFindMany = vi.fn(async (_a?: unknown): Promise<unknown[]> => [])
const countFindFirst = vi.fn()
const rcFindUnique = vi.fn(async () => ({ isDefault: false }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inboxSync: { updateMany: (a: never) => syncUpdateMany(a), create: (a: never) => syncCreate(a) },
    inboxItem: {
      findMany: (a: never) => itemFindMany(a),
      createMany: (a: never) => itemCreateMany(a),
      update: (a: never) => itemUpdate(a),
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
  syncRows = new Map()
  countFindFirst.mockResolvedValue({ status: 'FINALIZED', finalizedAt: new Date(NOW.getTime() - 86_400_000) })
  countInvoicesAwaiting.mockResolvedValue(0)
  loadPrepItems.mockResolvedValue([])
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
