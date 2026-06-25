import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const taskSelect = {
  id: true,
  name: true,
  revenueCenterId: true,
  linkedInventoryItemId: true,
  sortOrder: true,
  isActive: true,
  linkedInventoryItem: { select: { id: true, itemName: true } },
} as const

function dayBounds(dateStr: string | null) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setHours(0, 0, 0, 0)
  return { start: d, end: new Date(d.getTime() + 86_400_000) }
}

export async function GET(req: NextRequest) {
  try {
    await requireSession()
    const { searchParams } = new URL(req.url)
    const rcId = searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const { start, end } = dayBounds(searchParams.get('date'))

    const library = await prisma.prepTask.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      select: taskSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    const today = await prisma.prepTaskLog.findMany({
      where: { prepTask: { revenueCenterId: rcId }, logDate: { gte: start, lt: end } },
      select: { id: true, prepTaskId: true, logDate: true },
    })
    return NextResponse.json({ library, today })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/prep/tasks', e)
    return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession()
    const body = await req.json()
    const name = String(body.name ?? '').trim()
    const revenueCenterId = String(body.revenueCenterId ?? '')
    const linkedInventoryItemId = body.linkedInventoryItemId ? String(body.linkedInventoryItemId) : null
    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
    if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId required' }, { status: 400 })

    const max = await prisma.prepTask.aggregate({
      where: { revenueCenterId },
      _max: { sortOrder: true },
    })
    const task = await prisma.prepTask.create({
      data: {
        name,
        revenueCenterId,
        linkedInventoryItemId,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      select: taskSelect,
    })
    return NextResponse.json(task, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/prep/tasks', e)
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 })
  }
}
