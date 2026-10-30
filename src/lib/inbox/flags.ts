// Server-only: keeps a flagged checklist job and its Inbox item in step.
// Both functions run INSIDE the caller's transaction, so the job and its Inbox
// item always change together.
import 'server-only'
import type { Prisma } from '@prisma/client'
import { flagTagId, flagSeverity, type TagLite } from '@/lib/inbox/rules'

export const FLAG_KEY_PREFIX = 'flag:'
export const flagKey = (lineId: string) => `${FLAG_KEY_PREFIX}${lineId}`
export const CLEARED_NOTE = 'Cleared itself — the job was redone'

const TITLE_MAX = 120
const FLAG_HREF = '/checklist/today'

const REASON_LABEL: Record<string, string> = {
  BROKEN: 'Broken',
  RAN_OUT: 'Ran out',
  OUT_OF_RANGE: 'Out of range',
  OTHER: 'Flagged',
}

/** The line as it stands AFTER the update. */
export type FlagLine = {
  id: string
  title: string
  isBlocker: boolean
  status: 'TODO' | 'DONE' | 'FLAGGED'
  flagReason: string | null
  flagNote: string | null
  value: number | string | { toString(): string } | null
  unit: string | null
}

export type FlagWho = { id: string; name: string }

function flagTitle(line: FlagLine, reason: string): string {
  return `${line.title} · ${REASON_LABEL[reason] ?? REASON_LABEL.OTHER}`.slice(0, TITLE_MAX)
}

function flagBody(line: FlagLine, reason: string): string | null {
  if (reason === 'OUT_OF_RANGE') {
    return line.value == null ? null : `Read ${line.value} ${line.unit ?? ''}`.trim()
  }
  return line.flagNote?.trim() || null
}

/**
 * Called after a line's answer is saved. A FLAGGED line puts (or keeps) one
 * Inbox item on `flag:<lineId>`; any other answer closes an open one.
 */
export async function syncFlagItem(
  tx: Prisma.TransactionClient,
  args: {
    line: FlagLine
    run: { id: string }
    station: { name: string; revenueCenterId: string | null }
    who: FlagWho
  },
): Promise<void> {
  const { line, station, who } = args
  const sourceKey = flagKey(line.id)
  const existing = await tx.inboxItem.findUnique({
    where: { sourceKey },
    select: { id: true, status: true },
  })

  if (line.status !== 'FLAGGED') {
    if (!existing || existing.status === 'DONE') return
    await tx.inboxItem.update({
      where: { id: existing.id },
      data: { status: 'DONE', snoozeUntil: null, clearedAt: new Date(), doneById: null, doneByName: null, doneAt: null },
    })
    await tx.inboxEvent.create({
      data: { itemId: existing.id, kind: 'CLEARED', byId: who.id, byName: who.name, note: CLEARED_NOTE },
    })
    return
  }

  const reason = line.flagReason ?? 'OTHER'
  const [tags, routeRows] = await Promise.all([
    tx.inboxTag.findMany({
      select: { id: true, builtIn: true, name: true, color: true, cookCanPick: true, managerOnly: true, isActive: true },
    }),
    tx.inboxFlagRoute.findMany({ select: { reason: true, tagId: true } }),
  ])
  const tagList: TagLite[] = tags.map(t => ({ ...t, builtIn: t.builtIn as string | null }))
  const routes: Record<string, string> = {}
  for (const r of routeRows) routes[r.reason] = r.tagId
  const tagId = flagTagId(reason, routes, tagList)
  const tag = tagList.find(t => t.id === tagId)

  const fields = {
    tagId,
    severity: flagSeverity(line.isBlocker),
    title: flagTitle(line, reason),
    body: flagBody(line, reason),
    managerOnly: tag?.managerOnly ?? false,
  }

  if (!existing) {
    const created = await tx.inboxItem.create({
      data: {
        ...fields,
        sourceKey,
        source: 'FLAG',
        status: 'OPEN',
        place: station.name,
        revenueCenterId: station.revenueCenterId,
        href: FLAG_HREF,
        raisedById: who.id,
        raisedByName: who.name,
      },
      select: { id: true },
    })
    await tx.inboxEvent.create({
      data: { itemId: created.id, kind: 'RAISED', byId: who.id, byName: who.name, note: fields.body },
    })
    return
  }

  if (existing.status === 'DONE') {
    await tx.inboxItem.update({
      where: { id: existing.id },
      data: {
        ...fields,
        status: 'OPEN', snoozeUntil: null, clearedAt: null,
        doneById: null, doneByName: null, doneAt: null,
      },
    })
    await tx.inboxEvent.create({
      data: { itemId: existing.id, kind: 'REOPENED', byId: who.id, byName: who.name, note: null },
    })
    return
  }

  await tx.inboxItem.update({ where: { id: existing.id }, data: fields })
}

/**
 * The board's "Mark fixed" closes the Inbox item too: if one is still open for
 * this line, mark it DONE by the resolver.
 */
export async function closeFlagItem(
  tx: Prisma.TransactionClient,
  lineId: string,
  who: FlagWho,
  now = new Date(),
): Promise<void> {
  const item = await tx.inboxItem.findUnique({
    where: { sourceKey: flagKey(lineId) },
    select: { id: true, status: true },
  })
  if (!item || item.status === 'DONE') return
  await tx.inboxItem.update({
    where: { id: item.id },
    data: { status: 'DONE', snoozeUntil: null, clearedAt: null, doneById: who.id, doneByName: who.name, doneAt: now },
  })
  await tx.inboxEvent.create({
    data: { itemId: item.id, kind: 'DONE', byId: who.id, byName: who.name, note: null },
  })
}
