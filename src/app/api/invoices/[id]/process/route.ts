import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit } from '@/lib/utils'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: params.id },
    include: { lineItems: { include: { inventoryItem: true } } },
  })
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await prisma.invoice.update({ where: { id: params.id }, data: { status: 'PROCESSING' } })

  for (const li of invoice.lineItems) {
    const item = li.inventoryItem
    const newPurchasePrice = parseFloat(String(li.priceOverride ?? li.unitPrice))
    const qty      = parseFloat(String(item.qtyPerPurchaseUnit))
    const packSize = parseFloat(String(item.packSize))
    const packUOM  = item.packUOM
    const newPPBU  = calcPricePerBaseUnit(newPurchasePrice, qty, packSize, packUOM)
    const newStock = parseFloat(String(item.stockOnHand)) + parseFloat(String(li.qtyPurchased))

    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: {
        purchasePrice: newPurchasePrice,
        pricePerBaseUnit: newPPBU,
        stockOnHand: newStock,
        lastUpdated: new Date(),
      },
    })
  }

  const updated = await prisma.invoice.update({
    where: { id: params.id },
    data: { status: 'COMPLETE' },
    include: { supplier: true, lineItems: { include: { inventoryItem: true } } },
  })

  return NextResponse.json(updated)
}
