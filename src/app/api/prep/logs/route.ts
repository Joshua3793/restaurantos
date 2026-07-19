import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { validatePrepQty } from '@/lib/prep-utils'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const dateStr    = searchParams.get('date')
  const prepItemId = searchParams.get('prepItemId')
  const daysStr    = searchParams.get('days') // if set + prepItemId, return last N days (no single-date filter)

  // Per-item recent history mode: ?prepItemId=X&days=7
  if (prepItemId && daysStr) {
    const days  = Math.min(parseInt(daysStr, 10) || 7, 90)
    const since = new Date()
    since.setDate(since.getDate() - days)
    since.setHours(0, 0, 0, 0)

    const logs = await prisma.prepLog.findMany({
      where:   { prepItemId, logDate: { gte: since } },
      orderBy: { logDate: 'desc' },
    })
    return NextResponse.json(logs)
  }

  const date = dateStr ? new Date(dateStr) : new Date()
  date.setHours(0, 0, 0, 0)
  const nextDay = new Date(date.getTime() + 86_400_000)

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
  const body = await req.json()
  const { prepItemId, logDate, status, requiredQty, actualPrepQty, assignedTo, dueTime, note } = body

  if (!prepItemId) return NextResponse.json({ error: 'prepItemId is required' }, { status: 400 })

  const date = logDate ? new Date(logDate) : new Date()
  date.setHours(0, 0, 0, 0)

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
  const existing = await prisma.prepLog.findUnique({
    where: { prepItemId_logDate: { prepItemId, logDate: date } },
    select: { startedAt: true },
  })

  const now = new Date()
  const stamp: { startedAt?: Date; completedAt?: Date | null } = {}
  if (status === 'IN_PROGRESS') {
    stamp.startedAt = existing?.startedAt ?? now
    if (body.completedAt === null) stamp.completedAt = null
  }
  if (status === 'DONE') stamp.completedAt = now

  const log = await prisma.prepLog.upsert({
    where: { prepItemId_logDate: { prepItemId, logDate: date } },
    create: {
      prepItemId,
      logDate:         date,
      revenueCenterId,
      status:       status      ?? 'NOT_STARTED',
      requiredQty:  requiredQty  ? parseFloat(String(requiredQty))  : null,
      actualPrepQty: actualPrepQty ? parseFloat(String(actualPrepQty)) : null,
      assignedTo:   assignedTo   ?? null,
      dueTime:      dueTime      ?? null,
      note:         note         ?? null,
      ...stamp,
    },
    update: {
      revenueCenterId,
      ...(status        !== undefined && { status }),
      ...(requiredQty   !== undefined && { requiredQty:  parseFloat(String(requiredQty)) }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
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
