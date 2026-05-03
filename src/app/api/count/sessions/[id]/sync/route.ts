import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/count/sessions/:id/sync
// Adds any active inventory items not yet in the session as new count lines.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: { lines: { select: { inventoryItemId: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status === 'FINALIZED') return NextResponse.json({ error: 'Session is finalized' }, { status: 400 })

  const existingIds = new Set(session.lines.map(l => l.inventoryItemId))

  const areaIds: string[] = session.areaFilter
    ? session.areaFilter.split(',').map(s => s.trim()).filter(Boolean)
    : []

  const newItems = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      id: { notIn: [...existingIds] },
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  if (newItems.length === 0) return NextResponse.json({ added: 0 })

  const maxSort = await prisma.countLine.aggregate({
    where: { sessionId: params.id },
    _max: { sortOrder: true },
  })
  let nextSort = (maxSort._max.sortOrder ?? -1) + 1

  const lines = await prisma.$transaction(
    newItems.map(item =>
      prisma.countLine.create({
        data: {
          sessionId:       params.id,
          inventoryItemId: item.id,
          expectedQty:     Number(item.stockOnHand),
          selectedUom:     item.countUOM || item.baseUnit,
          priceAtCount:    item.pricePerBaseUnit,
          sortOrder:       nextSort++,
        },
        include: { inventoryItem: { include: { storageArea: true } } },
      })
    )
  )

  return NextResponse.json({ added: lines.length, lines })
}
