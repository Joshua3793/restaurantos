import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { validatePrepQty } from '@/lib/prep-utils'
import { prepDayFrom, prepDayRange, prepDayStart, prepDaysAgo } from '@/lib/prep-day'
import { LIVE_LOG_SELECT } from '@/lib/prep-plan-server'
import { isLiveLog } from '@/lib/prep-plan'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const dateStr    = searchParams.get('date')
  const prepItemId = searchParams.get('prepItemId')
  const daysStr    = searchParams.get('days') // if set + prepItemId, return last N days (no single-date filter)

  // Per-item recent history mode: ?prepItemId=X&days=7
  if (prepItemId && daysStr) {
    const days  = Math.min(parseInt(daysStr, 10) || 7, 90)
    const since = prepDaysAgo(days)

    const logs = await prisma.prepLog.findMany({
      where:   { prepItemId, logDate: { gte: since } },
      orderBy: { logDate: 'desc' },
    })
    return NextResponse.json(logs)
  }

  // `date` arrives as a bare 'YYYY-MM-DD' from the History picker; prepDayFrom
  // takes that as the day itself rather than re-deriving one from an instant.
  const { gte: date, lt: nextDay } = prepDayRange(dateStr)

  const logs = await prisma.prepLog.findMany({
    where: {
      ...(prepItemId ? { prepItemId } : {}),
      logDate: { gte: date, lt: nextDay },
    },
    include: {
      prepItem: { select: { id: true, name: true, unit: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(logs)
}

export async function POST(req: NextRequest) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { prepItemId, logDate, status, requiredQty, actualPrepQty, assignedTo, dueTime, note, listOrder } = body

  if (!prepItemId) return NextResponse.json({ error: 'prepItemId is required' }, { status: 400 })

  // The prep day a log belongs to is the RESTAURANT's day (src/lib/prep-day.ts):
  // on server wall-clock (UTC in prod) an evening entry opened a row dated
  // tomorrow instead of the day the cook was actually working.
  const explicitDay = logDate ? prepDayFrom(logDate) : null

  const prepItem = await prisma.prepItem.findUnique({
    where: { id: prepItemId },
    select: { revenueCenterId: true, unit: true, linkedRecipe: { select: { yieldUnit: true, baseYieldQty: true } } },
  })

  const revenueCenterId: string | null = prepItem?.revenueCenterId ?? body.revenueCenterId ?? null
  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  // Guard against unit-magnitude typos in "how much did you make?".
  if (actualPrepQty !== undefined && actualPrepQty !== null && prepItem?.linkedRecipe) {
    const err = validatePrepQty(parseFloat(String(actualPrepQty)), prepItem.unit, prepItem.linkedRecipe.yieldUnit, Number(prepItem.linkedRecipe.baseYieldQty))
    if (err) return NextResponse.json({ error: err }, { status: 400 })
  }

  // Stamp start/completion on status transitions so the run sheet's live
  // in-progress timers work. IN_PROGRESS sets startedAt once (never overwrites
  // an existing start); an explicit completedAt:null in the same request clears
  // completedAt (the "reopen" case). DONE stamps completedAt.
  //
  // Which row: the item's LIVE log — today's, or a job carried over from an
  // earlier list, so a cook picking up yesterday's unfinished prep keeps its
  // timer and planned qty instead of starting a parallel row. A caller that
  // names a day (a back-dated entry) gets exactly that day.
  const existing = explicitDay
    ? await prisma.prepLog.findUnique({
        where: { prepItemId_logDate: { prepItemId, logDate: explicitDay } },
        select: { id: true, startedAt: true },
      })
    : await prisma.prepLog
        .findFirst({
          where: { prepItemId },
          orderBy: { logDate: 'desc' },
          select: { ...LIVE_LOG_SELECT, startedAt: true },
        })
        .then(log => (log && isLiveLog(log, prepDayStart().getTime()) ? log : null))
  const date = explicitDay ?? prepDayStart()

  const now = new Date()
  const stamp: { startedAt?: Date; completedAt?: Date | null } = {}
  if (status === 'IN_PROGRESS') {
    stamp.startedAt = existing?.startedAt ?? now
    if (body.completedAt === null) stamp.completedAt = null
  }
  if (status === 'DONE') stamp.completedAt = now

  const log = existing
    ? await prisma.prepLog.update({
        where: { id: existing.id },
        data: {
          revenueCenterId,
          ...(status        !== undefined && { status }),
          ...(requiredQty   !== undefined && { requiredQty:  parseFloat(String(requiredQty)) }),
          ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
          ...(assignedTo    !== undefined && { assignedTo }),
          ...(dueTime       !== undefined && { dueTime }),
          ...(note          !== undefined && { note }),
          ...(listOrder     !== undefined && { listOrder }),
          ...stamp,
        },
      })
    : await prisma.prepLog.create({
        data: {
          prepItemId,
          logDate:         date,
          revenueCenterId,
          status:       status      ?? 'NOT_STARTED',
          requiredQty:  requiredQty  ? parseFloat(String(requiredQty))  : null,
          actualPrepQty: actualPrepQty ? parseFloat(String(actualPrepQty)) : null,
          assignedTo:   assignedTo   ?? null,
          dueTime:      dueTime      ?? null,
          note:         note         ?? null,
          listOrder:    listOrder    ?? null,
          ...stamp,
        },
      })

  // Keep `isOnList` coherent with status when one is supplied (mirrors the log PUT
  // route): completing/removing clears the item from today's list, starting/resetting
  // re-arms it. A statusless create (the common "ensure a log exists" call) leaves it.
  if (status !== undefined) {
    const data: { manualPriorityOverride?: null; isOnList?: boolean } = {}
    if (status === 'DONE' || status === 'PARTIAL') { data.manualPriorityOverride = null; data.isOnList = false }
    else if (status === 'SKIPPED') data.isOnList = false
    else if (status === 'NOT_STARTED' || status === 'IN_PROGRESS') data.isOnList = true
    if (Object.keys(data).length) {
      await prisma.prepItem.update({ where: { id: prepItemId }, data })
    }
  }

  return NextResponse.json(log, { status: 201 })
}
