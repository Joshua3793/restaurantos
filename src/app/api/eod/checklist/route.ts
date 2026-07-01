import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const itemSelect = {
  id: true, revenueCenterId: true, section: true, title: true,
  meta: true, sortOrder: true, isBlocker: true,
} as const

export async function GET(req: NextRequest) {
  try {
    await requireSession('ADMIN')
    const rcId = new URL(req.url).searchParams.get('rcId')
    if (!rcId) return NextResponse.json({ error: 'rcId required' }, { status: 400 })
    const items = await prisma.eodCheckItem.findMany({
      where: { revenueCenterId: rcId, isActive: true },
      select: itemSelect,
      orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    })
    return NextResponse.json(items, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('GET /api/eod/checklist', e)
    return NextResponse.json({ error: 'Failed to load checklist' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireSession('ADMIN')
    const body = await req.json()
    const revenueCenterId = String(body.revenueCenterId ?? '')
    const section = String(body.section ?? '').trim()
    const title = String(body.title ?? '').trim()
    if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId required' }, { status: 400 })
    if (!section) return NextResponse.json({ error: 'section required' }, { status: 400 })
    if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 })
    const max = await prisma.eodCheckItem.aggregate({ where: { revenueCenterId }, _max: { sortOrder: true } })
    const item = await prisma.eodCheckItem.create({
      data: {
        revenueCenterId, section, title,
        meta: body.meta ? String(body.meta) : null,
        isBlocker: Boolean(body.isBlocker),
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
      select: itemSelect,
    })
    return NextResponse.json(item, { status: 201 })
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    console.error('POST /api/eod/checklist', e)
    return NextResponse.json({ error: 'Failed to create item' }, { status: 500 })
  }
}
