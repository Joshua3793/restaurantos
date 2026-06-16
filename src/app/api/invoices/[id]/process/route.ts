import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

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
    const packUOM  = item.packUOM
    // Price-only update: rebuild `pricing` to match the new price (do NOT touch
    // packChain — the pack format is unchanged here). For a UOM/rate item, the
    // price is a rate; for a CASE item it's the pack purchase price.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemAny = item as any
    const newPricing =
      itemAny.priceType === 'UOM'
        ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: itemAny.baseUnit || packUOM || 'each' }
        : { mode: 'PACK', purchasePrice: newPurchasePrice }
    await prisma.inventoryItem.update({
      where: { id: item.id },
      data: {
        purchasePrice: newPurchasePrice,
        lastUpdated: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pricing: newPricing as any,
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
