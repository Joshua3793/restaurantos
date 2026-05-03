import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/count/sessions/:id/lines — add a single item to an existing session
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { inventoryItemId } = await req.json()

  const session = await prisma.countSession.findUnique({ where: { id: params.id } })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status === 'FINALIZED') return NextResponse.json({ error: 'Session is finalized' }, { status: 400 })

  // Prevent duplicate lines
  const existing = await prisma.countLine.findFirst({
    where: { sessionId: params.id, inventoryItemId },
  })
  if (existing) return NextResponse.json({ error: 'Item already in session' }, { status: 409 })

  const item = await prisma.inventoryItem.findUnique({
    where: { id: inventoryItemId },
    include: { storageArea: true },
  })
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  const maxSort = await prisma.countLine.aggregate({
    where: { sessionId: params.id },
    _max: { sortOrder: true },
  })

  const line = await prisma.countLine.create({
    data: {
      sessionId: params.id,
      inventoryItemId,
      expectedQty: Number(item.stockOnHand),
      selectedUom: item.countUOM || item.baseUnit,
      priceAtCount: Number(item.pricePerBaseUnit),
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    include: { inventoryItem: { include: { storageArea: true } } },
  })

  return NextResponse.json(line, { status: 201 })
}
