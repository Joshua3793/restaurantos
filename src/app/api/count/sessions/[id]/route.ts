import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/count/sessions/:id
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: [{ sortOrder: 'asc' }, { inventoryItem: { category: 'asc' } }, { inventoryItem: { itemName: 'asc' } }],
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const total   = session.lines.length
  const counted = session.lines.filter(l => l.countedQty !== null && !l.skipped).length
  const skipped = session.lines.filter(l => l.skipped).length

  return NextResponse.json({ ...session, counts: { total, counted, skipped, pctComplete: total > 0 ? counted / total : 0 } })
}

// PATCH /api/count/sessions/:id  — update label / reopen finalized session
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.label       !== undefined) data.label       = body.label
  if (body.countedBy   !== undefined) data.countedBy   = body.countedBy
  if (body.sessionDate !== undefined) data.sessionDate = new Date(body.sessionDate)
  if (body.status      !== undefined) data.status      = body.status
  const updated = await prisma.countSession.update({ where: { id: params.id }, data })
  return NextResponse.json(updated)
}

// DELETE /api/count/sessions/:id
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.countSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
