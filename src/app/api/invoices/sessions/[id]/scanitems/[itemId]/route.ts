import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// PATCH /api/invoices/sessions/[id]/scanitems/[itemId]
// Updates editable fields on a scan item. Recalculates rawLineTotal when qty/price change.
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; itemId: string } }
) {
  const body = await req.json()
  const updates: Record<string, unknown> = {}

  if ('editedDescription' in body) {
    updates.editedDescription = body.editedDescription ? String(body.editedDescription).trim() || null : null
  }

  const hasQty   = 'rawQty'        in body
  const hasPrice = 'rawUnitPrice'  in body

  const newQty   = hasQty   ? (body.rawQty   != null ? Number(body.rawQty)   : null) : undefined
  const newPrice = hasPrice ? (body.rawUnitPrice != null ? Number(body.rawUnitPrice) : null) : undefined

  if (hasQty)   updates.rawQty        = newQty
  if (hasPrice) updates.rawUnitPrice  = newPrice

  // Recalculate line total when at least one of qty/price is being updated
  if (hasQty || hasPrice) {
    const existing = await prisma.invoiceScanItem.findUnique({
      where: { id: params.itemId },
      select: { rawQty: true, rawUnitPrice: true },
    })
    const resolvedQty   = newQty   ?? (existing?.rawQty   != null ? Number(existing.rawQty)   : null)
    const resolvedPrice = newPrice ?? (existing?.rawUnitPrice != null ? Number(existing.rawUnitPrice) : null)
    if (resolvedQty != null && resolvedPrice != null) {
      updates.rawLineTotal = Math.round(resolvedQty * resolvedPrice * 100) / 100
    }
  }

  if ('rawLineTotal' in body && body.rawLineTotal != null) {
    updates.rawLineTotal = Number(body.rawLineTotal)
  }

  const updated = await prisma.invoiceScanItem.update({
    where: { id: params.itemId, sessionId: params.id },
    data: updates,
    include: {
      matchedItem: {
        select: {
          id: true, itemName: true, purchaseUnit: true,
          pricePerBaseUnit: true, purchasePrice: true,
          qtyPerPurchaseUnit: true, packSize: true, packUOM: true, baseUnit: true,
        },
      },
    },
  })

  return NextResponse.json(updated)
}
