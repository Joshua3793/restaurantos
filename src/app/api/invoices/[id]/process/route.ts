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
    // Price-only update: rebuild `pricing` to match the new price (do NOT touch
    // packChain — the pack format is unchanged here). The pricing MODE + rate
    // unit come from the item's existing chain pricing: a rate-priced item keeps
    // its rate (and its rate's own unit); everything else is a PACK purchase price.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemAny = item as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingPricing = itemAny.pricing as any
    const newPricing =
      existingPricing?.mode === 'RATE'
        ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: existingPricing.rateUnit || itemAny.baseUnit || 'each' }
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
