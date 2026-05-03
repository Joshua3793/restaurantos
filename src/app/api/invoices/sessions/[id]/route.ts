import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { learnAlias } from '@/lib/supplier-matcher'
import { calcPricePerBaseUnit } from '@/lib/utils'

// GET /api/invoices/sessions/[id] — get session with full details
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: { select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true, ocrRawJson: true } },
      scanItems: {
        include: { matchedItem: { select: { id: true, itemName: true, purchaseUnit: true, pricePerBaseUnit: true, purchasePrice: true, qtyPerPurchaseUnit: true, packSize: true, packUOM: true, baseUnit: true } } },
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
        action:             body.action,
        matchedItemId:      body.matchedItemId,
        rawQty:             body.rawQty !== undefined ? body.rawQty : undefined,
        rawUnit:            body.rawUnit !== undefined ? body.rawUnit : undefined,
        rawUnitPrice:       body.rawUnitPrice !== undefined ? body.rawUnitPrice : undefined,
        rawLineTotal:       body.rawLineTotal !== undefined ? body.rawLineTotal : undefined,
        newPrice:           body.newPrice !== undefined ? body.newPrice : undefined,
        previousPrice:      body.previousPrice !== undefined ? body.previousPrice : undefined,
        priceDiffPct:       body.priceDiffPct !== undefined ? body.priceDiffPct : undefined,
        approved:           body.approved !== undefined ? body.approved : undefined,
        isNewItem:          body.isNewItem !== undefined ? body.isNewItem : undefined,
        newItemData:        body.newItemData !== undefined ? JSON.stringify(body.newItemData) : undefined,
        invoicePackQty:     body.invoicePackQty !== undefined ? body.invoicePackQty : undefined,
        invoicePackSize:    body.invoicePackSize !== undefined ? body.invoicePackSize : undefined,
        invoicePackUOM:     body.invoicePackUOM !== undefined ? body.invoicePackUOM : undefined,
        rawPriceType:       body.rawPriceType !== undefined ? body.rawPriceType : undefined,
        needsFormatConfirm: body.needsFormatConfirm !== undefined ? body.needsFormatConfirm : undefined,
        revenueCenterId:    body.revenueCenterId !== undefined ? body.revenueCenterId : undefined,
      },
    })
    return NextResponse.json(item)
  }

  // Update supplier assignment — also learns the alias
  if (body.supplierId !== undefined && !body.scanItemId) {
    const session = await prisma.invoiceSession.findUnique({
      where: { id: params.id },
      select: { supplierName: true },
    })
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const updated = await prisma.invoiceSession.update({
      where: { id: params.id },
      data: { supplierId: body.supplierId },
    })

    // Learn alias: associate this OCR name with the chosen supplier
    if (body.supplierId && session.supplierName) {
      await learnAlias(body.supplierId, session.supplierName)
    }

    return NextResponse.json(updated)
  }

  // Update session header
  const session = await prisma.invoiceSession.update({
    where: { id: params.id },
    data: {
      supplierName:    body.supplierName,
      invoiceDate:     body.invoiceDate,
      invoiceNumber:   body.invoiceNumber,
      subtotal:        body.subtotal !== undefined ? body.subtotal : undefined,
      tax:             body.tax !== undefined ? body.tax : undefined,
      total:           body.total !== undefined ? body.total : undefined,
      status:          body.status,
      revenueCenterId: body.revenueCenterId !== undefined ? body.revenueCenterId : undefined,
    },
  })
  return NextResponse.json(session)
}

// DELETE /api/invoices/sessions/[id]
// For APPROVED sessions, reverts inventory prices that were applied.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      status: true,
      scanItems: {
        where: { action: 'UPDATE_PRICE', approved: true },
        select: {
          matchedItemId: true,
          previousPrice: true,
          matchedItem: {
            select: {
              id: true,
              qtyPerPurchaseUnit: true,
              packSize: true,
              packUOM: true,
            },
          },
        },
      },
    },
  })

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let pricesReverted = 0

  // Revert inventory prices if session was approved
  if (session.status === 'APPROVED' && session.scanItems.length > 0) {
    for (const scanItem of session.scanItems) {
      if (!scanItem.matchedItemId || scanItem.previousPrice === null || !scanItem.matchedItem) continue

      const prevPrice = Number(scanItem.previousPrice)
      const pricePerBaseUnit = calcPricePerBaseUnit(
        prevPrice,
        Number(scanItem.matchedItem.qtyPerPurchaseUnit),
        Number(scanItem.matchedItem.packSize),
        scanItem.matchedItem.packUOM ?? 'each',
      )

      await prisma.inventoryItem.update({
        where: { id: scanItem.matchedItemId },
        data: { purchasePrice: prevPrice, pricePerBaseUnit },
      })
      pricesReverted++
    }
  }

  await prisma.invoiceSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true, pricesReverted })
}
