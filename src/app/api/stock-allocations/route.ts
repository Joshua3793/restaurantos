import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/stock-allocations?itemId= — allocations for a specific inventory item
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const itemId = searchParams.get('itemId')

  if (!itemId) return NextResponse.json({ error: 'itemId required' }, { status: 400 })

  const allocations = await prisma.stockAllocation.findMany({
    where: { inventoryItemId: itemId },
    include: { revenueCenter: { select: { id: true, name: true, color: true } } },
  })

  return NextResponse.json(allocations)
}
