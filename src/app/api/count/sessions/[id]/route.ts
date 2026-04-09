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

// DELETE /api/count/sessions/:id
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.countSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
