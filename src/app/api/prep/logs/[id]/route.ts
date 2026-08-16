import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { validatePrepQty } from '@/lib/prep-utils'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { markPlanDirty, prepDayStart, postedOpenWhere } from '@/lib/prep-plan-server'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

const COMPLETION_STATUSES = new Set(['DONE', 'PARTIAL'])

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { status, actualPrepQty, assignedTo, dueTime, note, blockedReason, requiredQty, listOrder } = body

  // Planner draft fields (planned qty, chef note, bucket order) are the chef's:
  // LEAD+. `assignedTo` deliberately stays session-only — cooks claim their own.
  const editsPlan = requiredQty !== undefined || listOrder !== undefined || note !== undefined
  if (editsPlan) {
    try { await requireSession('LEAD') }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Require actualPrepQty when completing
  const qty =
    actualPrepQty !== undefined
      ? parseFloat(String(actualPrepQty))
      : existing.actualPrepQty
        ? parseFloat(String(existing.actualPrepQty))
        : null

  if (status && COMPLETION_STATUSES.has(status) && !qty) {
    return NextResponse.json(
      { error: 'actualPrepQty is required to mark as Done or Partial' },
      { status: 400 },
    )
  }

  // Guard against unit-magnitude typos (e.g. 25000 into a kg field). Only when a
  // new qty is being recorded — leave existing rows untouched on metadata edits.
  if (actualPrepQty !== undefined && qty != null) {
    const prepItem = await prisma.prepItem.findUnique({
      where: { id: existing.prepItemId },
      select: { unit: true, linkedRecipe: { select: { yieldUnit: true, baseYieldQty: true } } },
    })
    if (prepItem?.linkedRecipe) {
      const err = validatePrepQty(qty, prepItem.unit, prepItem.linkedRecipe.yieldUnit, Number(prepItem.linkedRecipe.baseYieldQty))
      if (err) return NextResponse.json({ error: err }, { status: 400 })
    }
  }

  // Stamp start/completion on status transitions so the run sheet's live
  // in-progress timers work. IN_PROGRESS sets startedAt once (never overwrites
  // an existing start); an explicit completedAt:null in the same request clears
  // completedAt (the "reopen" case). DONE stamps completedAt.
  const now = new Date()
  const stamp: { startedAt?: Date; completedAt?: Date | null; logDate?: Date } = {}
  if (status === 'IN_PROGRESS') {
    stamp.startedAt = existing.startedAt ?? now
    if (body.completedAt === null) stamp.completedAt = null
  }
  if (status === 'DONE') stamp.completedAt = now

  // A job carried over from an earlier list is finished TODAY — re-date it, or the
  // production lands on the day it was posted for. That is not cosmetic: the
  // theoretical-stock engine windows prep against `logDate` (prepEventCounts in
  // count-expected.ts), so a stale date can push the yield behind a count cutoff
  // and the stock never gets credited. Skipped when the item already has a row
  // for today (the unique prepItemId+logDate would collide) — rare, and the
  // completedAt stamp still records the moment.
  if (status !== undefined && COMPLETION_STATUSES.has(status)) {
    const today = prepDayStart()
    if (existing.logDate.getTime() < today.getTime()) {
      const clash = await prisma.prepLog.findUnique({
        where: { prepItemId_logDate: { prepItemId: existing.prepItemId, logDate: today } },
        select: { id: true },
      })
      if (!clash) stamp.logDate = today
    }
  }

  const log = await prisma.prepLog.update({
    where: { id: params.id },
    data: {
      ...(status        !== undefined && { status }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
      ...(blockedReason !== undefined && { blockedReason }),
      ...(requiredQty   !== undefined && { requiredQty: requiredQty === null ? null : parseFloat(String(requiredQty)) }),
      ...(listOrder     !== undefined && { listOrder }),
      ...stamp,
    },
  })

  // Finishing the job clears any OLDER row still holding this item on the
  // kitchen's list. Those rows are what carry an unfinished job forward; left
  // posted, the oldest one would hand the item straight back tomorrow as if it
  // had never been made. (Their status stays as it was — the history is that the
  // job wasn't done that day.)
  if (status !== undefined && COMPLETION_STATUSES.has(status)) {
    await prisma.prepLog.updateMany({
      where: {
        prepItemId: existing.prepItemId,
        logDate: { lt: stamp.logDate ?? existing.logDate },
        ...postedOpenWhere,
      },
      data: { postedAt: null },
    })
  }

  // Draft edits after posting → the kitchen is on a stale list; flag the post.
  if (editsPlan) await markPlanDirty(existing.revenueCenterId)

  // Completing (or reverting) a prep changes theoretical stock — buildPrepMap counts
  // DONE/PARTIAL logs — so drop the cache when a completion is involved either way.
  if (COMPLETION_STATUSES.has(status) || COMPLETION_STATUSES.has(existing.status)) {
    invalidateTheoreticalCache()
  }

  // Keep `isOnList` coherent with status: completing/removing clears the item from
  // today's list (frees the Smart Prep "Add" button — the prep stays in History);
  // starting or resetting re-arms it onto the list. Completing also clears the
  // manual priority override so Plan Prep resets to auto.
  if (status !== undefined) {
    const data: { manualPriorityOverride?: null; isOnList?: boolean } = {}
    if (COMPLETION_STATUSES.has(status)) { data.manualPriorityOverride = null; data.isOnList = false }
    else if (status === 'SKIPPED') data.isOnList = false
    else if (status === 'NOT_STARTED' || status === 'IN_PROGRESS') data.isOnList = true
    if (Object.keys(data).length) {
      await prisma.prepItem.update({ where: { id: existing.prepItemId }, data })
    }
  }

  return NextResponse.json(log)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.prepLog.findUnique({ where: { id: params.id } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await prisma.prepLog.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
