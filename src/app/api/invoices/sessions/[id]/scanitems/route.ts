import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

// POST /api/invoices/sessions/[id]/scanitems — manually add a line item
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  const session = await prisma.invoiceSession.findUnique({ where: { id: params.id }, select: { id: true, status: true } })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  // Get the next sort order
  const last = await prisma.invoiceScanItem.findFirst({
    where: { sessionId: params.id },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })

  const qty       = body.qty       != null ? Number(body.qty)       : null
  const unitPrice = body.unitPrice != null ? Number(body.unitPrice) : null
  const lineTotal = body.lineTotal != null
    ? Number(body.lineTotal)
    : (qty !== null && unitPrice !== null ? qty * unitPrice : null)

  const item = await prisma.invoiceScanItem.create({
    data: {
      sessionId:      params.id,
      rawDescription: String(body.description || 'Manual item').trim(),
      rawQty:         qty,
      rawUnit:        body.unit   ?? 'cs',
      rawUnitPrice:   unitPrice,
      rawLineTotal:   lineTotal,
      matchConfidence: 'NONE',
      matchScore:      0,
      action:          'CREATE_NEW',
      sortOrder:       (last?.sortOrder ?? -1) + 1,
    },
    include: {
      matchedItem: {
        select: {
          id: true, itemName: true, purchaseUnit: true,
          ...PRICING_SELECT, purchasePrice: true,
          qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
          priceType: true, qtyUOM: true, innerQty: true,
        },
      },
    },
  })

  // Keep the response's matchedItem.pricePerBaseUnit field populated for the
  // drawer by computing it from the chain (survives the legacy column drop).
  const out = item.matchedItem
    ? { ...item, matchedItem: { ...item.matchedItem, pricePerBaseUnit: pricePerBaseUnit(asChainItem(item.matchedItem)) } }
    : item

  return NextResponse.json(out, { status: 201 })
}
