import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'

async function handlePOST(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({ where: { id: params.id } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.inventoryItem.update({
    where: { id: params.id },
    data: { lastCountDate: new Date(), lastCountQty: item.stockOnHand },
  })
  return NextResponse.json(updated)
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
