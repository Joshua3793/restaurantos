import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/invoices/sessions/[id] — get session with full details
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: { select: { id: true, fileName: true, fileType: true, ocrStatus: true, ocrRawJson: true } },
      scanItems: {
        include: { matchedItem: { select: { id: true, itemName: true, purchaseUnit: true, pricePerBaseUnit: true, purchasePrice: true } } },
        orderBy: { sortOrder: 'asc' },
      },
      priceAlerts: {
        include: { inventoryItem: { select: { id: true, itemName: true } } },
      },
      recipeAlerts: {
        include: { recipe: { select: { id: true, name: true, menuPrice: true } } },
      },
    },
  })

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(session)
}

// PATCH /api/invoices/sessions/[id] — update session header fields or scan item actions
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  // Update scan item action/match
  if (body.scanItemId) {
    const item = await prisma.invoiceScanItem.update({
      where: { id: body.scanItemId },
      data: {
        action:         body.action,
        matchedItemId:  body.matchedItemId,
        newPrice:       body.newPrice !== undefined ? body.newPrice : undefined,
        approved:       body.approved !== undefined ? body.approved : undefined,
        isNewItem:      body.isNewItem !== undefined ? body.isNewItem : undefined,
        newItemData:    body.newItemData !== undefined ? JSON.stringify(body.newItemData) : undefined,
      },
    })
    return NextResponse.json(item)
  }

  // Update session header
  const session = await prisma.invoiceSession.update({
    where: { id: params.id },
    data: {
      supplierName:  body.supplierName,
      invoiceDate:   body.invoiceDate,
      invoiceNumber: body.invoiceNumber,
      subtotal:      body.subtotal !== undefined ? body.subtotal : undefined,
      tax:           body.tax !== undefined ? body.tax : undefined,
      total:         body.total !== undefined ? body.total : undefined,
      status:        body.status,
    },
  })
  return NextResponse.json(session)
}

// DELETE /api/invoices/sessions/[id]
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.invoiceSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
