// Server-only: the Inbox reads and writes. Every visibility decision goes
// through `canSee` (rules.ts) — applied in SQL where it can be, then again in JS.
import 'server-only'
import type { Prisma, User, InboxEventKind } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { atLeast } from '@/lib/roles'
import { isRcInScope, assertRcWritable } from '@/lib/rc-scope'
import { whoOf } from '@/lib/checklists/who'
import { FLAG_KEY_PREFIX } from '@/lib/inbox/flags'
import {
  canSee, badgeCount, snoozeUntilTomorrow,
  type ItemLite, type TagLite, type Severity, type Status,
} from '@/lib/inbox/rules'

const DAY_MS = 24 * 60 * 60 * 1000
/** System price-rise items are keyed `price:<priceAlertId>`. */
const PRICE_KEY_PREFIX = 'price:'
/** Done items and a cook's own reports both look back this far. */
export const LOOKBACK_DAYS = 14
const NOTE_MAX = 500
const TEXT_MIN = 3
const TEXT_MAX = 500
const TITLE_MAX = 80
const PLACE_MAX = 40
const LIST_CAP = 500

/** A refusal the routes turn into `{ error }` with this status. */
export class InboxError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message)
    this.name = 'InboxError'
  }
}

export type ItemView = ItemLite & {
  title: string
  body: string | null
  place: string | null
  href: string | null
  source: 'REPORT' | 'FLAG' | 'SYSTEM'
  tag: TagLite
  raisedById: string | null
  raisedByName: string | null
  doneByName: string | null
  doneAt: string | null
  unread: boolean
  revenueCenterId: string | null
}

export type MineView = ItemView & {
  /** Done since this cook last opened it — what the STAFF bell counts. */
  fixedSinceSeen: boolean
}

export type EventView = {
  kind: InboxEventKind
  byName: string | null
  note: string | null
  at: string
}

export type InboxAction =
  | { kind: 'note'; note: string }
  | { kind: 'snooze' }
  | { kind: 'wait'; note: string | null }
  | { kind: 'done'; note: string | null }
  | { kind: 'reopen' }
  | { kind: 'retag'; tagId: string }

export type Counts = { byTag: Record<string, number>; open: number; done: number; snoozed: number }

export type ListStatus = 'open' | 'snoozed' | 'done'

// ── selects + mapping ──────────────────────────────────────────────────────

const TAG_SELECT = {
  id: true, builtIn: true, name: true, color: true,
  cookCanPick: true, managerOnly: true, isActive: true,
} as const

function itemSelect(userId: string) {
  return {
    id: true, tagId: true, severity: true, status: true, managerOnly: true,
    snoozeUntil: true, clearedAt: true, doneById: true, createdAt: true,
    title: true, body: true, place: true, href: true, source: true, sourceKey: true,
    raisedById: true, raisedByName: true, doneByName: true, doneAt: true,
    revenueCenterId: true,
    tag: { select: TAG_SELECT },
    // This viewer's latest SEEN, if any. None = unread.
    events: {
      where: { kind: 'SEEN' as const, byId: userId },
      orderBy: { at: 'desc' as const },
      take: 1,
      select: { at: true },
    },
  } satisfies Prisma.InboxItemSelect
}

type ItemRow = Prisma.InboxItemGetPayload<{ select: ReturnType<typeof itemSelect> }>

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString()

const toTag = (t: ItemRow['tag']): TagLite => ({ ...t, builtIn: (t.builtIn as string | null) ?? null })

function lastSeen(row: Pick<ItemRow, 'events'>): Date | null {
  const at = row.events[0]?.at
  return at ? new Date(at) : null
}

/** A cook's own report that was fixed after they last looked at it. */
function fixedSinceSeen(row: Pick<ItemRow, 'status' | 'doneAt' | 'events'>): boolean {
  if (row.status !== 'DONE' || !row.doneAt) return false
  const seen = lastSeen(row)
  return !seen || new Date(row.doneAt).getTime() > seen.getTime()
}

function toView(row: ItemRow): ItemView {
  return {
    id: row.id,
    tagId: row.tagId,
    severity: row.severity as Severity,
    status: row.status as Status,
    managerOnly: row.managerOnly,
    snoozeUntil: iso(row.snoozeUntil),
    clearedAt: iso(row.clearedAt),
    doneById: row.doneById,
    createdAt: iso(row.createdAt)!,
    title: row.title,
    body: row.body,
    place: row.place,
    href: row.href,
    source: row.source,
    tag: toTag(row.tag),
    raisedById: row.raisedById,
    raisedByName: row.raisedByName,
    doneByName: row.doneByName,
    doneAt: iso(row.doneAt),
    unread: row.events.length === 0,
    revenueCenterId: row.revenueCenterId,
  }
}

const SEVERITY_RANK: Record<Severity, number> = { NOW: 0, TODAY: 1, FYI: 2 }

function bySeverityThenNewest(a: ItemView, b: ItemView): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.createdAt.localeCompare(a.createdAt)
}

// ── where fragments ────────────────────────────────────────────────────────

/** This kitchen plus whole-house (null rc) items; LEAD loses manager-only items and tags. */
function visibleWhere(user: Pick<User, 'role'>, rcId: string): Prisma.InboxItemWhereInput[] {
  const parts: Prisma.InboxItemWhereInput[] = [
    { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] },
  ]
  if (!atLeast(user.role, 'MANAGER')) {
    parts.push({ managerOnly: false, tag: { managerOnly: false } })
  }
  return parts
}

/** `isOpenNow` in SQL: OPEN or WAITING, or SNOOZED once the snooze has passed. */
const openWhere = (now: Date): Prisma.InboxItemWhereInput => ({
  OR: [
    { status: { in: ['OPEN', 'WAITING'] } },
    { status: 'SNOOZED', snoozeUntil: { lte: now } },
  ],
})

/** Snoozed and still asleep: these are not in the open list until `snoozeUntil` passes. */
const snoozedWhere = (now: Date): Prisma.InboxItemWhereInput => ({ status: 'SNOOZED', snoozeUntil: { gt: now } })

const statusWhere = (status: ListStatus, now: Date): Prisma.InboxItemWhereInput =>
  status === 'done' ? doneWhere(now) : status === 'snoozed' ? snoozedWhere(now) : openWhere(now)

/** DONE in the lookback window — by a person (doneAt) or by itself (clearedAt). */
const doneWhere = (now: Date): Prisma.InboxItemWhereInput => {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS)
  return { status: 'DONE', OR: [{ doneAt: { gte: since } }, { clearedAt: { gte: since } }] }
}

// ── reads ──────────────────────────────────────────────────────────────────

export async function loadItems(
  user: User,
  opts: { rcId: string; status: ListStatus; tagId?: string | null; from?: string | null; place?: string | null },
  now = new Date(),
): Promise<ItemView[]> {
  const and: Prisma.InboxItemWhereInput[] = [
    ...visibleWhere(user, opts.rcId),
    statusWhere(opts.status, now),
  ]
  if (opts.tagId) and.push({ tagId: opts.tagId })
  if (opts.from) and.push({ raisedById: opts.from })
  if (opts.place) and.push({ place: opts.place })

  const rows = await prisma.inboxItem.findMany({
    where: { AND: and },
    select: itemSelect(user.id),
    orderBy: { createdAt: 'desc' },
    take: LIST_CAP,
  })
  return rows
    .filter(r => canSee(user.role, r, r.tag))
    .map(toView)
    .sort(bySeverityThenNewest)
}

/** Open count per tag (for the chips), plus the Open / Snoozed / Done totals. Ignores list filters. */
export async function loadCounts(user: User, rcId: string, tags: TagLite[], now = new Date()): Promise<Counts> {
  const visible = visibleWhere(user, rcId)
  const [grouped, done, snoozed] = await Promise.all([
    prisma.inboxItem.groupBy({
      by: ['tagId'],
      where: { AND: [...visible, openWhere(now)] },
      _count: { _all: true },
    }),
    prisma.inboxItem.count({ where: { AND: [...visible, doneWhere(now)] } }),
    prisma.inboxItem.count({ where: { AND: [...visible, snoozedWhere(now)] } }),
  ])
  const tagsById = new Map(tags.map(t => [t.id, t]))
  const byTag: Record<string, number> = {}
  let open = 0
  for (const g of grouped) {
    // Double-check: a tag this viewer may not see never shows a count.
    if (!canSee(user.role, { managerOnly: false }, tagsById.get(g.tagId))) continue
    byTag[g.tagId] = g._count._all
    open += g._count._all
  }
  return { byTag, open, done, snoozed }
}

/** Active tags this viewer may see (chips + retag choices). */
export function visibleTags(user: Pick<User, 'role'>, tags: TagLite[]): TagLite[] {
  return tags.filter(t => t.isActive && canSee(user.role, { managerOnly: false }, t))
}

/** LEAD+: open NOW + TODAY items they can see in this kitchen. */
export async function leadBadge(user: User, rcId: string, now = new Date()): Promise<number> {
  const rows = await prisma.inboxItem.findMany({
    where: { AND: [...visibleWhere(user, rcId), openWhere(now), { severity: { in: ['NOW', 'TODAY'] } }] },
    select: {
      id: true, tagId: true, severity: true, status: true, managerOnly: true,
      snoozeUntil: true, clearedAt: true, doneById: true, createdAt: true,
      tag: { select: { managerOnly: true } },
    },
  })
  const items: ItemLite[] = rows.map(r => ({
    id: r.id, tagId: r.tagId, severity: r.severity as Severity, status: r.status as Status,
    managerOnly: r.managerOnly, snoozeUntil: iso(r.snoozeUntil), clearedAt: iso(r.clearedAt),
    doneById: r.doneById, createdAt: iso(r.createdAt)!,
  }))
  const tagsById = new Map(rows.map(r => [r.tagId, r.tag]))
  return badgeCount(items, user.role, tagsById, now)
}

/** STAFF: their own reports (last 14 days) fixed since they last opened them. */
export async function staffBadge(user: User, now = new Date()): Promise<number> {
  const rows = await prisma.inboxItem.findMany({
    where: {
      raisedById: user.id,
      source: 'REPORT',
      status: 'DONE',
      createdAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS) },
    },
    select: {
      status: true, doneAt: true,
      events: {
        where: { kind: 'SEEN', byId: user.id },
        orderBy: { at: 'desc' },
        take: 1,
        select: { at: true },
      },
    },
  })
  return rows.filter(fixedSinceSeen).length
}

/** The caller's own reports from the last 14 days, newest first. Reading this marks nothing seen. */
export async function loadMine(user: User, now = new Date()): Promise<MineView[]> {
  const rows = await prisma.inboxItem.findMany({
    where: {
      raisedById: user.id,
      source: 'REPORT',
      createdAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS) },
    },
    select: itemSelect(user.id),
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return rows.map(r => ({ ...toView(r), fixedSinceSeen: fixedSinceSeen(r) }))
}

/** Manager-only by itself or by its tag, for a viewer below MANAGER. */
const hiddenFrom = (user: Pick<User, 'role'>, row: Pick<ItemRow, 'managerOnly' | 'tag'>): boolean =>
  !atLeast(user.role, 'MANAGER') && (row.managerOnly || row.tag.managerOnly)

/** Non-managers' writes only land while the item is still visible to them. */
const visibleToWriter = (user: Pick<User, 'role'>): Prisma.InboxItemWhereInput =>
  atLeast(user.role, 'MANAGER') ? {} : { managerOnly: false, tag: { managerOnly: false } }

/**
 * How much of the item this viewer may open:
 * - 'full': LEAD+ who can see it, in a kitchen in their scope; or the person
 *   who raised a REPORT that is not manager-only.
 * - 'limited': the person who raised a REPORT that has since become
 *   manager-only (e.g. a manager retagged it into Money). They get the title
 *   and whether it is fixed, never the notes or history.
 * - null: anything else (a 404). The owner shortcut is REPORT-only, so a cook
 *   whose checklist flag was routed into a manager-only tag gets nothing.
 */
async function openLevel(user: User, row: ItemRow): Promise<'full' | 'limited' | null> {
  if (
    canSee(user.role, row, row.tag) &&
    (row.revenueCenterId == null || (await isRcInScope(user, row.revenueCenterId)))
  ) return 'full'
  if (row.source === 'REPORT' && row.raisedById === user.id) {
    return hiddenFrom(user, row) ? 'limited' : 'full'
  }
  return null
}

/** Keep only the first (earliest) SEEN per person; events arrive oldest first. */
function collapseSeen<T extends { kind: string; byId: string | null }>(events: T[]): T[] {
  const seen = new Set<string>()
  return events.filter(e => {
    if (e.kind !== 'SEEN') return true
    const key = e.byId ?? ''
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * One item with its history. The first open writes SEEN. A cook re-opening
 * their own report after it was fixed writes a fresh SEEN, so the bell clears.
 * Anything the viewer may not see is a 404, never a 403.
 */
export async function getItem(
  user: User,
  id: string,
): Promise<{ item: ItemView; events: EventView[]; limited?: true }> {
  const row = await prisma.inboxItem.findUnique({ where: { id }, select: itemSelect(user.id) })
  const level = row ? await openLevel(user, row) : null
  if (!row || !level) throw new InboxError(404, 'Not found')

  const firstLook = row.events.length === 0
  const ownFixNews = row.raisedById === user.id && fixedSinceSeen(row)
  if (firstLook || ownFixNews) {
    const who = await whoOf(user)
    await prisma.inboxEvent.create({
      data: { itemId: row.id, kind: 'SEEN', byId: who.id, byName: who.name },
    })
  }

  if (level === 'limited') {
    // Title, status and who fixed it — no body, place, link, notes or history.
    return {
      item: { ...toView(row), unread: false, body: null, place: null, href: null },
      events: [],
      limited: true,
    }
  }

  const events = await prisma.inboxEvent.findMany({
    where: { itemId: row.id },
    orderBy: { at: 'asc' },
    select: { kind: true, byId: true, byName: true, note: true, at: true },
  })
  return {
    item: { ...toView(row), unread: false },
    events: collapseSeen(events).map(e => ({ kind: e.kind, byName: e.byName, note: e.note, at: iso(e.at)! })),
  }
}

// ── writes ─────────────────────────────────────────────────────────────────

const cleanNote = (v: unknown): string | null =>
  typeof v === 'string' ? v.trim().slice(0, NOTE_MAX) || null : null

/** Body → action. Null for anything it does not recognise ("Unknown action"). */
export function parseAction(body: unknown): InboxAction | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  switch (b.kind) {
    case 'note': {
      const note = cleanNote(b.note)
      if (!note) throw new InboxError(400, 'Write a note')
      return { kind: 'note', note }
    }
    case 'snooze': return { kind: 'snooze' }
    case 'wait': return { kind: 'wait', note: cleanNote(b.note) }
    case 'done': return { kind: 'done', note: cleanNote(b.note) }
    case 'reopen': return { kind: 'reopen' }
    case 'retag': {
      if (typeof b.tagId !== 'string' || !b.tagId) throw new InboxError(400, 'Pick a tag')
      return { kind: 'retag', tagId: b.tagId }
    }
    default: return null
  }
}

/** The fields Task 5 / 6 hooks need when an item is marked done. */
export type DoneItem = {
  id: string
  source: 'REPORT' | 'FLAG' | 'SYSTEM'
  sourceKey: string | null
  revenueCenterId: string | null
}

/**
 * Runs inside the "done" transaction: whatever else must happen when an item
 * is marked done, by where it came from. Add new sources as further branches.
 */
export async function onItemDone(
  item: DoneItem,
  who: { id: string; name: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (item.source === 'FLAG' && item.sourceKey?.startsWith(FLAG_KEY_PREFIX)) {
    // Fixing it here marks the checklist job fixed too — only while it is still flagged and unresolved.
    await tx.checklistRunLine.updateMany({
      where: { id: item.sourceKey.slice(FLAG_KEY_PREFIX.length), status: 'FLAGGED', resolvedAt: null },
      data: { resolvedById: who.id, resolvedByName: who.name, resolvedAt: new Date() },
    })
    return
  }
  if (item.source === 'SYSTEM' && item.sourceKey?.startsWith(PRICE_KEY_PREFIX)) {
    // Fixing a price rise here acknowledges it on the invoices side too.
    await tx.priceAlert.updateMany({
      where: { id: item.sourceKey.slice(PRICE_KEY_PREFIX.length), acknowledged: false },
      data: { acknowledged: true },
    })
  }
}

/** Apply one action: update the item and write its event in one transaction. */
export async function act(user: User, id: string, action: InboxAction, now = new Date()): Promise<ItemView> {
  const row = await prisma.inboxItem.findUnique({ where: { id }, select: itemSelect(user.id) })
  if (!row || !canSee(user.role, row, row.tag)) throw new InboxError(404, 'Not found')
  if (row.revenueCenterId) {
    if (!(await isRcInScope(user, row.revenueCenterId))) throw new InboxError(404, 'Not found')
    await assertRcWritable(user, row.revenueCenterId)
  }

  let toTagRow: TagLite | null = null
  if (action.kind === 'retag') {
    const tag = await prisma.inboxTag.findUnique({ where: { id: action.tagId }, select: TAG_SELECT })
    if (!tag || !tag.isActive) throw new InboxError(400, 'Pick a tag')
    if (tag.managerOnly && !atLeast(user.role, 'MANAGER')) {
      throw new InboxError(403, 'Only a manager can file it there')
    }
    toTagRow = { ...tag, builtIn: (tag.builtIn as string | null) ?? null }
    if (tag.id === row.tagId) return toView(row)
  }

  const who = await whoOf(user)
  const by = { byId: who.id, byName: who.name }

  const visible = visibleToWriter(user)
  return prisma.$transaction(async tx => {
    // Still there and still visible to this writer? (A manager may have just
    // retagged it into Money.) No → 404, same as if it never existed.
    const stillVisible = async () => {
      const hit = await tx.inboxItem.findFirst({ where: { id: row.id, ...visible }, select: { id: true } })
      if (!hit) throw new InboxError(404, 'Not found')
    }
    const update = async (
      guard: Prisma.InboxItemWhereInput,
      data: Prisma.InboxItemUpdateManyMutationInput | Prisma.InboxItemUncheckedUpdateManyInput,
      conflict: string,
    ) => {
      const res = await tx.inboxItem.updateMany({ where: { id: row.id, ...visible, ...guard }, data })
      if (res.count === 0) {
        await stillVisible() // 404 when visibility is what failed
        throw new InboxError(409, conflict)
      }
    }
    const event = (kind: InboxEventKind, note: string | null = null) =>
      tx.inboxEvent.create({ data: { itemId: row.id, kind, ...by, note } })

    switch (action.kind) {
      case 'note':
        await stillVisible()
        await event('NOTE', action.note)
        break
      case 'snooze':
        await update({ status: { not: 'DONE' } },
          { status: 'SNOOZED', snoozeUntil: snoozeUntilTomorrow(now) }, 'Already fixed')
        await event('SNOOZED')
        break
      case 'wait':
        await update({ status: { not: 'DONE' } },
          { status: 'WAITING', snoozeUntil: null }, 'Already fixed')
        await event('WAITING', action.note)
        break
      case 'done':
        await update({ status: { not: 'DONE' } }, {
          status: 'DONE', snoozeUntil: null, clearedAt: null,
          doneById: who.id, doneByName: who.name, doneAt: now,
        }, 'Already fixed')
        await event('DONE', action.note)
        await onItemDone(
          { id: row.id, source: row.source, sourceKey: row.sourceKey, revenueCenterId: row.revenueCenterId },
          who, tx,
        )
        break
      case 'reopen':
        await update({ status: 'DONE' }, {
          status: 'OPEN', snoozeUntil: null, clearedAt: null,
          doneById: null, doneByName: null, doneAt: null,
        }, 'Already open')
        await event('REOPENED')
        break
      case 'retag':
        await update({}, { tagId: toTagRow!.id }, 'Not found')
        await event('RETAGGED', `${row.tag.name} → ${toTagRow!.name}`)
        break
    }

    const fresh = await tx.inboxItem.findUnique({ where: { id: row.id }, select: itemSelect(user.id) })
    return toView(fresh ?? row)
  })
}

/**
 * A cook (or anyone signed in) reports something. Scope is checked first so an
 * out-of-scope report writes nothing. The tag must be one this person may pick.
 */
export async function createReport(user: User, body: unknown): Promise<ItemView> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const rcId = typeof b.rcId === 'string' ? b.rcId : null
  await assertRcWritable(user, rcId)

  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (text.length < TEXT_MIN || text.length > TEXT_MAX) {
    throw new InboxError(400, 'Say what’s going on')
  }

  const tag = typeof b.tagId === 'string' && b.tagId
    ? await prisma.inboxTag.findUnique({ where: { id: b.tagId }, select: TAG_SELECT })
    : null
  if (!tag || !mayPickTag(user, tag)) throw new InboxError(400, 'Pick a tag')

  const place = typeof b.place === 'string' ? b.place.trim().slice(0, PLACE_MAX) || null : null
  const title = text.split(/\r?\n/)[0].trim().slice(0, TITLE_MAX)
  const who = await whoOf(user)

  const row = await prisma.inboxItem.create({
    data: {
      revenueCenterId: rcId,
      tagId: tag.id,
      severity: b.urgent === true ? 'NOW' : 'TODAY',
      title,
      body: text,
      place,
      source: 'REPORT',
      managerOnly: false,
      status: 'OPEN',
      raisedById: who.id,
      raisedByName: who.name,
      events: { create: { kind: 'RAISED', byId: who.id, byName: who.name, note: text } },
    },
    select: itemSelect(user.id),
  }).catch((e: unknown) => {
    // A kitchen id that does not exist (foreign key) is a bad pick, not a crash.
    if ((e as { code?: unknown })?.code === 'P2003') throw new InboxError(400, 'Pick a kitchen')
    throw e
  })
  return toView(row)
}

/** STAFF: active + cooks-can-pick + not manager-only. LEAD: active, not manager-only. MANAGER+: any active. */
export function mayPickTag(user: Pick<User, 'role'>, tag: Pick<TagLite, 'isActive' | 'cookCanPick' | 'managerOnly'>): boolean {
  if (!tag.isActive) return false
  if (atLeast(user.role, 'MANAGER')) return true
  if (tag.managerOnly) return false
  return atLeast(user.role, 'LEAD') || tag.cookCanPick
}
