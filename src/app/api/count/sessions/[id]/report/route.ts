import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase } from '@/lib/count-uom'

// GET /api/count/sessions/:id/report
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const lines = session.lines
    .filter(l => l.countedQty !== null && !l.skipped)
    .sort((a, b) => Math.abs(Number(b.varianceCost ?? 0)) - Math.abs(Number(a.varianceCost ?? 0)))

  const totalValue = lines.reduce((s, l) => {
    const item = l.inventoryItem
    const itemDims = {
      baseUnit: item.baseUnit, purchaseUnit: item.purchaseUnit,
      qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit), packSize: Number(item.packSize),
      packUOM: item.packUOM, countUOM: item.countUOM,
    }
    const qtyBase = convertCountQtyToBase(Number(l.countedQty), l.selectedUom, itemDims)
    return s + qtyBase * Number(l.priceAtCount)
  }, 0)
  const totalVarianceCost  = lines.reduce((s, l) => s + Math.abs(Number(l.varianceCost ?? 0)), 0)
  const itemsWithLargeVariance = lines.filter(l => Math.abs(Number(l.variancePct ?? 0)) > 15).length

  return NextResponse.json({
    session: {
      id: session.id, label: session.label, sessionDate: session.sessionDate,
      countedBy: session.countedBy, status: session.status, finalizedAt: session.finalizedAt,
    },
    summary: { totalValue, totalVarianceCost, itemsWithLargeVariance },
    lines: lines.map(l => ({
      id: l.id,
      itemName:    l.inventoryItem.itemName,
      category:    l.inventoryItem.category,
      location:    l.inventoryItem.location ?? l.inventoryItem.storageArea?.name ?? null,
      expectedQty: Number(l.expectedQty),
      countedQty:  Number(l.countedQty),
      selectedUom: l.selectedUom,
      variancePct: Number(l.variancePct ?? 0),
      varianceCost:Number(l.varianceCost ?? 0),
      priceAtCount:Number(l.priceAtCount),
    })),
  })
}
