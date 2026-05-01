import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase } from '@/lib/count-uom'

// PATCH /api/count/sessions/:id/lines/:lineId
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; lineId: string } }
) {
  const body = await req.json()
  const { countedQty, selectedUom, skipped, notes } = body

  const line = await prisma.countLine.findUnique({
    where: { id: params.lineId },
    include: { inventoryItem: true },
  })
  if (!line) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const item = line.inventoryItem
  const itemDims = {
    baseUnit:           item.baseUnit,
    purchaseUnit:       item.purchaseUnit,
    qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
    packSize:           Number(item.packSize),
    packUOM:            item.packUOM,
  }

  let data: Parameters<typeof prisma.countLine.update>[0]['data'] = {}

  if (skipped === true) {
    data = { skipped: true, countedQty: line.expectedQty, variancePct: 0, varianceCost: 0 }
  } else if (countedQty !== undefined) {
    const counted   = parseFloat(String(countedQty))
    // selectedUom from body takes priority; fall back to what's already on the line
    const uom       = selectedUom ?? line.selectedUom
    // Convert entered qty to baseUnit for variance comparison (expectedQty is in baseUnit)
    const countedBase = convertCountQtyToBase(counted, uom, itemDims)
    const expected  = Number(line.expectedQty)
    const price     = Number(line.priceAtCount)
    data = {
      countedQty:   counted,
      skipped:      false,
      variancePct:  expected > 0 ? ((countedBase - expected) / expected) * 100 : 0,
      varianceCost: (countedBase - expected) * price,
      ...(selectedUom !== undefined ? { selectedUom } : {}),
      ...(notes       !== undefined ? { notes }       : {}),
    }
  } else {
    if (selectedUom !== undefined) data.selectedUom = selectedUom
    if (notes       !== undefined) data.notes       = notes
  }

  const updated = await prisma.countLine.update({
    where: { id: params.lineId },
    data,
    include: { inventoryItem: { include: { storageArea: true } } },
  })

  return NextResponse.json(updated)
}
