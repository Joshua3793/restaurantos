import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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

  const log = await prisma.prepLog.upsert({
    where: { prepItemId_logDate: { prepItemId, logDate: date } },
    create: {
      prepItemId,
      logDate:      date,
      status:       status      ?? 'NOT_STARTED',
      requiredQty:  requiredQty  ? parseFloat(String(requiredQty))  : null,
      actualPrepQty: actualPrepQty ? parseFloat(String(actualPrepQty)) : null,
      assignedTo:   assignedTo   ?? null,
      dueTime:      dueTime      ?? null,
      note:         note         ?? null,
    },
    update: {
      ...(status        !== undefined && { status }),
      ...(requiredQty   !== undefined && { requiredQty:  parseFloat(String(requiredQty)) }),
      ...(actualPrepQty !== undefined && { actualPrepQty: parseFloat(String(actualPrepQty)) }),
      ...(assignedTo    !== undefined && { assignedTo }),
      ...(dueTime       !== undefined && { dueTime }),
      ...(note          !== undefined && { note }),
    },
  })

  return NextResponse.json(log, { status: 201 })
}
