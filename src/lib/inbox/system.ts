// Server-only: files the app's own alerts (temps, stations, prep, money,
// stock, phones) into the Inbox for one kitchen. Each alert opens when its
// condition appears, clears itself when it goes, and reopens if it comes back.
// Throttled to once a minute per kitchen; never throws to the caller.
import 'server-only'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { ensureInboxSeeded } from '@/lib/inbox/tags'
import { reconcile } from '@/lib/inbox/rules'
import {
  collectConditions, loadedFamilies, ownsItem, clearNote, CLEAR_NOTES,
  type Condition, type ConditionsInput, type TempUnitIn, type PrepItemIn,
} from '@/lib/inbox/conditions'
import { defaultPhase, minusDays, pacificDate, shiftBusinessDate } from '@/lib/checklists/rules'
import { applicableJobCounts } from '@/lib/checklists/applicable'
import { loadTempUnits } from '@/lib/temps/units'
import { loadPrepItems } from '@/lib/prep-items-server'
import { countInvoicesAwaiting, invoiceRcWhere } from '@/lib/invoice-awaiting'
import { daysSinceCount } from '@/lib/start-page'
import { blockedOf } from '@/lib/pin/crew-status'
import { PENDING_MAX_AGE_MS, pairCode, pinFullName } from '@/lib/pin/rules'

export const SYNC_EVERY_MS = 60_000
const GLOBAL_SYNC_KEY = '__global__'
const DAY_MS = 24 * 60 * 60 * 1000
const PRICE_PREFIX = 'price:'
const CLOSE_PREFIX = 'close-unsigned:'
/**
 * A person-closed daily item is re-armed only if it was closed within this
 * many days. The rolling, undated keys (REARM_ALWAYS) re-arm at any age.
 */
const REARM_LOOKBACK_DAYS = 30
/**
 * Undated keys that live forever, one per kitchen: their condition can stay
 * present for longer than the lookback after a person closes them, so they
 * are always read back for re-arming — or the alert would go silent for good.
 */
const REARM_ALWAYS = ['invoices:', 'count-stale:'] as const
/** How far back a NEW price rise is filed (older unacknowledged ones stay behind the bell). */
const PRICE_LOOKBACK_DAYS = 14
/** The two days before the current closing shift. */
const CLOSE_LOOKBACK_DAYS = 2
export const CLEARED_ITSELF = CLEAR_NOTES.resolved

/**
 * Claim this minute's sync for the kitchen in one conditional write: bump `at`
 * only if it is older than a minute; with no row yet, insert one with
 * skipDuplicates — so a throttled poll never raises a unique-violation error,
 * and of two racing first syncs only the one whose insert lands goes ahead.
 */
async function claimSync(key: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - SYNC_EVERY_MS)
  const bumped = await prisma.inboxSync.updateMany({
    where: { revenueCenterId: key, at: { lt: cutoff } },
    data: { at: now },
  })
  if (bumped.count > 0) return true
  const inserted = await prisma.inboxSync.createMany({
    data: [{ revenueCenterId: key, at: now }],
    skipDuplicates: true,
  })
  return inserted.count === 1 // 0 = synced within the last minute
}

// ── Loading the inputs (Prisma reads only) ──────────────────────────────────

type Loaders = { [K in Exclude<keyof ConditionsInput, 'rcId' | 'now' | 'date'>]?: () => Promise<ConditionsInput[K]> }

function loaders(rcId: string | null, now: Date): Loaders {
  // The default kitchen also owns legacy null-RC invoices and counts.
  let isDefault: Promise<boolean> | null = null
  const rcIsDefault = () => (isDefault ??= prisma.revenueCenter
    .findUnique({ where: { id: rcId! }, select: { isDefault: true } })
    .then(r => r?.isDefault ?? false))

  const global: Loaders = {
    priceAlerts: async () => {
      // New price rises come from the last two weeks; an alert already in the
      // Inbox stays live (whatever its age) until someone acknowledges it.
      const open = await prisma.inboxItem.findMany({
        where: { source: 'SYSTEM', sourceKey: { startsWith: PRICE_PREFIX }, status: { not: 'DONE' } },
        select: { sourceKey: true },
      })
      const keep = open.map(o => o.sourceKey!.slice(PRICE_PREFIX.length))
      const rows = await prisma.priceAlert.findMany({
        where: {
          acknowledged: false,
          direction: 'UP',
          OR: [
            { createdAt: { gte: new Date(now.getTime() - PRICE_LOOKBACK_DAYS * DAY_MS) } },
            ...(keep.length ? [{ id: { in: keep } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, changePct: true, direction: true,
          inventoryItem: { select: { itemName: true } },
          session: { select: { supplierName: true } },
        },
      })
      return rows.map(r => ({
        id: r.id,
        changePct: Number(r.changePct),
        direction: r.direction,
        itemName: r.inventoryItem?.itemName ?? null,
        supplierName: r.session?.supplierName ?? null,
      }))
    },
    phones: async () => {
      const rows = await prisma.pinDevice.findMany({
        where: {
          status: 'PENDING',
          createdAt: { gte: new Date(now.getTime() - PENDING_MAX_AGE_MS) },
        },
        select: {
          id: true, status: true, createdAt: true, tokenHash: true,
          cook: {
            select: { name: true, lastName: true, isActive: true, user: { select: { role: true, isActive: true } } },
          },
        },
      })
      return rows.map(d => ({
        id: d.id,
        name: pinFullName(d.cook),
        pairCode: pairCode(d.tokenHash),
        status: d.status,
        createdAt: d.createdAt,
        blocked: !d.cook.isActive || blockedOf(d.cook.user) != null,
      }))
    },
  }

  const date = pacificDate(now)
  // Today's readings, oldest first. `type` is the Prisma enum, serialized as a string.
  const temps = async (rcIds: string[]): Promise<TempUnitIn[]> =>
    (await loadTempUnits(rcIds, date)).map(u => ({ ...u, type: u.type as TempUnitIn['type'] }))
  // The prep list exactly as GET /api/prep/items computes it, narrowed to what the alert reads.
  const prep = async (rcIn: string[]): Promise<PrepItemIn[]> =>
    (await loadPrepItems({ rcIn, activeOnly: true, includeHidden: false })).map(i => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      onHand: i.onHand,
      parLevel: i.parLevel,
      priority: i.priority as PrepItemIn['priority'],
      assignedCook: i.assignedCook,
      todayLog: i.todayLog
        ? { status: i.todayLog.status, postedAt: i.todayLog.postedAt ? new Date(i.todayLog.postedAt).toISOString() : null }
        : null,
      revenueCenterId: i.revenueCenterId,
    }))

  // No kitchen: shared temp units and shared prep only, plus the global sources.
  if (!rcId) {
    return {
      ...global,
      temps: () => temps([]),
      prep: () => prep([]),
    }
  }

  return {
    ...global,
    temps: () => temps([rcId]),
    prep: () => prep([rcId]),
    stations: async () => {
      const phase = defaultPhase(now)
      const businessDate = shiftBusinessDate('OPEN', now)
      // Out of the opening window nothing is late to open (and open ones clear).
      if (phase !== 'OPEN') return { phase, businessDate, list: [] }
      const stations = await prisma.checklistStation.findMany({
        where: { revenueCenterId: rcId, isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true },
      })
      const runs = await prisma.checklistRun.findMany({
        where: { stationId: { in: stations.map(s => s.id) }, phase: 'OPEN', businessDate },
        select: { stationId: true },
      })
      const started = new Set(runs.map(r => r.stationId))
      const counts = await applicableJobCounts(
        stations.filter(s => !started.has(s.id)).map(s => s.id), 'OPEN', businessDate,
      )
      return {
        phase,
        businessDate,
        list: stations.map(s => ({
          id: s.id, name: s.name, revenueCenterId: rcId,
          hasRun: started.has(s.id), jobCount: counts.get(s.id) ?? 0,
        })),
      }
    },
    closeRuns: async () => {
      const closeDate = shiftBusinessDate('CLOSE', now)
      const rows = await prisma.checklistRun.findMany({
        where: {
          phase: 'CLOSE',
          status: { not: 'SIGNED' },
          businessDate: { lt: closeDate, gte: minusDays(closeDate, CLOSE_LOOKBACK_DAYS) },
          station: { revenueCenterId: rcId, isShared: false, isActive: true },
          lines: { some: {} },
        },
        select: { id: true, businessDate: true, station: { select: { name: true } } },
      })
      return rows.map(r => ({
        id: r.id, stationName: r.station.name, revenueCenterId: rcId, businessDate: r.businessDate,
      }))
    },
    closeAged: async () => {
      // Open close-unsigned items whose run is still unsigned but now older
      // than the window: they expire, and the note must say so.
      const open = await prisma.inboxItem.findMany({
        where: {
          source: 'SYSTEM', sourceKey: { startsWith: CLOSE_PREFIX }, status: { not: 'DONE' },
          revenueCenterId: rcId,
        },
        select: { sourceKey: true },
      })
      if (open.length === 0) return []
      const windowStart = minusDays(shiftBusinessDate('CLOSE', now), CLOSE_LOOKBACK_DAYS)
      const aged = await prisma.checklistRun.findMany({
        where: {
          id: { in: open.map(o => o.sourceKey!.slice(CLOSE_PREFIX.length)) },
          status: { not: 'SIGNED' },
          businessDate: { lt: windowStart },
        },
        select: { id: true },
      })
      return aged.map(r => r.id)
    },
    invoices: async () => ({
      awaiting: await countInvoicesAwaiting(
        invoiceRcWhere({ rcId, isDefault: await rcIsDefault(), locRcIds: null }),
      ),
    }),
    count: async () => {
      const rcWhere = (await rcIsDefault())
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: rcId }
      const latest = await prisma.countSession.findFirst({
        where: { AND: [{ type: { not: 'QUICK' } }, { status: 'FINALIZED', finalizedAt: { not: null } }, rcWhere] },
        orderBy: { finalizedAt: 'desc' },
        select: { status: true, finalizedAt: true },
      })
      const sessions = latest
        ? [{ status: latest.status, finalizedAt: latest.finalizedAt?.toISOString() ?? null }]
        : []
      return { days: daysSinceCount(sessions, now.getTime()) }
    },
  }
}

/** Run every loader; a failing one is logged and left out (so it clears nothing). */
export async function loadInput(rcId: string | null, now: Date): Promise<ConditionsInput> {
  const input: ConditionsInput = { rcId, now, date: pacificDate(now) }
  const entries = Object.entries(loaders(rcId, now)) as [keyof Loaders, () => Promise<unknown>][]
  const results = await Promise.allSettled(entries.map(([, load]) => load()))
  results.forEach((r, i) => {
    const family = entries[i][0]
    if (r.status === 'fulfilled') {
      ;(input as Record<string, unknown>)[family] = r.value
    } else {
      console.error(`[inbox sync] rc=${rcId ?? 'global'} source=${family} failed`, r.reason)
    }
  })
  return input
}

// ── Applying them ───────────────────────────────────────────────────────────

type Existing = {
  id: string
  sourceKey: string | null
  status: 'OPEN' | 'SNOOZED' | 'WAITING' | 'DONE'
  clearedAt: Date | null
  doneById: string | null
  title: string
  body: string | null
  revenueCenterId: string | null
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

async function createItems(rcId: string | null, conds: Condition[], tagIds: Map<string, string>): Promise<void> {
  const rows = conds.flatMap(c => {
    const tagId = tagIds.get(c.tagBuiltIn)
    if (!tagId) {
      console.error(`[inbox sync] rc=${rcId ?? 'global'} no ${c.tagBuiltIn} tag for ${c.sourceKey}`)
      return []
    }
    return [{
      id: randomUUID() as string,
      revenueCenterId: c.revenueCenterId,
      tagId,
      severity: c.severity,
      title: c.title,
      body: c.body ?? null,
      place: c.place ?? null,
      href: c.href,
      source: 'SYSTEM' as const,
      sourceKey: c.sourceKey,
      managerOnly: c.managerOnly,
      status: 'OPEN' as const,
    }]
  })
  if (rows.length === 0) return
  await prisma.inboxItem.createMany({ data: rows, skipDuplicates: true })
  // Only the rows this call inserted get a RAISED event: a concurrent sync that
  // won the race on a key owns that row (and its event).
  const ours = new Map(rows.map(r => [r.id, r]))
  const landed = await prisma.inboxItem.findMany({
    where: { sourceKey: { in: rows.map(r => r.sourceKey) } },
    select: { id: true },
  })
  const raised = landed.filter(l => ours.has(l.id))
  if (raised.length === 0) return
  await prisma.inboxEvent.createMany({
    data: raised.map(l => ({ itemId: l.id, kind: 'RAISED' as const, note: ours.get(l.id)!.body })),
  })
}

async function clearItem(item: Existing, now: Date, note: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const res = await tx.inboxItem.updateMany({
      where: { id: item.id, status: { not: 'DONE' } },
      data: { status: 'DONE', snoozeUntil: null, clearedAt: now, doneById: null, doneByName: null, doneAt: null },
    })
    if (res.count === 0) return
    await tx.inboxEvent.create({ data: { itemId: item.id, kind: 'CLEARED', note } })
  })
}

/**
 * A person closed it and the condition has since gone: stamp clearedAt (no
 * event) so the alert reopens if the condition comes back.
 */
async function rearmItem(item: Existing, now: Date): Promise<void> {
  await prisma.inboxItem.updateMany({
    where: { id: item.id, status: 'DONE', clearedAt: null },
    data: { clearedAt: now },
  })
}

async function reopenItem(item: Existing, cond: Condition): Promise<void> {
  await prisma.$transaction(async tx => {
    const res = await tx.inboxItem.updateMany({
      where: { id: item.id, status: 'DONE', clearedAt: { not: null } },
      data: {
        status: 'OPEN', snoozeUntil: null, clearedAt: null,
        doneById: null, doneByName: null, doneAt: null,
        title: cond.title, body: cond.body ?? null,
      },
    })
    if (res.count === 0) return
    await tx.inboxEvent.create({ data: { itemId: item.id, kind: 'REOPENED', note: cond.body ?? null } })
  })
}

/** Run one write; log (and carry on past) anything it throws. */
async function guarded(rcId: string | null, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (e) {
    console.error(`[inbox sync] rc=${rcId ?? 'global'} ${what} failed`, e)
  }
}

export async function applyConditions(rcId: string | null, input: ConditionsInput): Promise<void> {
  const now = input.now
  const conds = collectConditions(input)
  const loaded = loadedFamilies(input)
  const byKey = new Map(conds.map(c => [c.sourceKey, c]))
  const presentKeys = [...byKey.keys()]

  const existing = (await prisma.inboxItem.findMany({
    where: {
      source: 'SYSTEM',
      OR: [
        ...(presentKeys.length ? [{ sourceKey: { in: presentKeys } }] : []),
        { status: { not: 'DONE' }, OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] },
        // Closed by a person and not yet re-armed: recently, or any time for a
        // rolling key (at most one row per kitchen each). ownsItem narrows it below.
        {
          status: 'DONE', clearedAt: null,
          OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }],
          AND: [{
            OR: [
              { doneAt: { gte: new Date(now.getTime() - REARM_LOOKBACK_DAYS * DAY_MS) } },
              ...REARM_ALWAYS.map(prefix => ({ sourceKey: { startsWith: prefix } })),
            ],
          }],
        },
      ],
    },
    select: {
      id: true, sourceKey: true, status: true, clearedAt: true, doneById: true,
      title: true, body: true, revenueCenterId: true,
    },
  })) as Existing[]
  const existingByKey = new Map(existing.filter(e => e.sourceKey).map(e => [e.sourceKey!, e]))

  const tags = await prisma.inboxTag.findMany({
    where: { builtIn: { not: null } },
    select: { id: true, builtIn: true },
  })
  const tagIds = new Map(tags.map(t => [t.builtIn as string, t.id]))

  const toCreate: Condition[] = []
  for (const cond of conds) {
    const item = existingByKey.get(cond.sourceKey) ?? null
    const lite = item && { status: item.status, clearedAt: iso(item.clearedAt), doneById: item.doneById }
    const { action } = reconcile(lite, true, now)
    if (action === 'create') toCreate.push(cond)
    else if (action === 'reopen' && item) {
      await guarded(rcId, `reopen ${cond.sourceKey}`, () => reopenItem(item, cond))
    } else if (action === 'none' && item && item.status !== 'DONE') {
      // Same alert, new wording (e.g. "3 invoices" → "4 invoices"): no event.
      const body = cond.body ?? null
      if (item.title !== cond.title || item.body !== body) {
        await guarded(rcId, `refresh ${cond.sourceKey}`, async () => {
          await prisma.inboxItem.update({ where: { id: item.id }, data: { title: cond.title, body } })
        })
      }
    }
  }
  if (toCreate.length) {
    await guarded(rcId, `create ${toCreate.length}`, () => createItems(rcId, toCreate, tagIds))
  }

  for (const item of existing) {
    if (!item.sourceKey || byKey.has(item.sourceKey)) continue
    if (!ownsItem(item, rcId, loaded)) continue
    const lite = { status: item.status, clearedAt: iso(item.clearedAt), doneById: item.doneById }
    const { action } = reconcile(lite, false, now)
    if (action === 'clear') {
      const note = clearNote(item.sourceKey, input)
      await guarded(rcId, `clear ${item.sourceKey}`, () => clearItem(item, now, note))
    } else if (action === 'rearm') {
      await guarded(rcId, `rearm ${item.sourceKey}`, () => rearmItem(item, now))
    }
  }
}

/**
 * Files the app's own alerts for one kitchen (null = whole-house sources
 * only). Called by GET /api/inbox and GET /api/inbox/count. Never throws.
 */
export async function syncSystemItems(rcId: string | null, now: Date = new Date()): Promise<void> {
  try {
    if (!(await claimSync(rcId ?? GLOBAL_SYNC_KEY, now))) return
    await ensureInboxSeeded()
    const input = await loadInput(rcId, now)
    await applyConditions(rcId, input)
  } catch (e) {
    console.error(`[inbox sync] rc=${rcId ?? 'global'} failed`, e)
  }
}
