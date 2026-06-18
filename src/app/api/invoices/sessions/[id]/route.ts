import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { learnAlias } from '@/lib/supplier-matcher'
import { requireSession, AuthError } from '@/lib/auth'
import { PRICING_SELECT, withPpb } from '@/lib/item-model'

// GET /api/invoices/sessions/[id] — get session with full details
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      files: { select: { id: true, fileName: true, fileType: true, fileUrl: true, ocrStatus: true }, orderBy: { createdAt: 'asc' } },
      scanItems: {
        include: { matchedItem: { select: { id: true, itemName: true, ...PRICING_SELECT, purchasePrice: true, supplierPrices: true } } },
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
  // Re-populate the computed pricePerBaseUnit on each matchedItem so the invoice
  // review UI (computeNormalisedPrices, composites/card/issues) survives the drop.
  const scanItems = session.scanItems.map(si =>
    si.matchedItem ? { ...si, matchedItem: withPpb(si.matchedItem) } : si
  )
  return NextResponse.json({ ...session, scanItems })
}

// PATCH /api/invoices/sessions/[id] — update session header fields or scan item actions
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
        // Accept either an object (AddNewItemModal) or an already-stringified
        // JSON payload (drawer line edits stage the stored string shape) —
        // never double-encode.
        newItemData:        body.newItemData !== undefined
          ? (typeof body.newItemData === 'string' ? body.newItemData : JSON.stringify(body.newItemData))
          : undefined,
        invoicePackQty:     body.invoicePackQty !== undefined ? body.invoicePackQty : undefined,
        invoicePackSize:    body.invoicePackSize !== undefined ? body.invoicePackSize : undefined,
        invoicePackUOM:     body.invoicePackUOM !== undefined ? body.invoicePackUOM : undefined,
        totalQty:           body.totalQty !== undefined ? body.totalQty : undefined,
        totalQtyUOM:        body.totalQtyUOM !== undefined ? body.totalQtyUOM : undefined,
        revenueCenterId:    body.revenueCenterId !== undefined ? body.revenueCenterId : undefined,
        // Mode-aware fields (editable from v2 drawer)
        pricingMode:        body.pricingMode       !== undefined ? body.pricingMode       : undefined,
        pricingModeSignal:  body.pricingModeSignal !== undefined ? body.pricingModeSignal : undefined,
        qtyOrdered:         body.qtyOrdered        !== undefined ? body.qtyOrdered        : undefined,
        qtyOrderedUOM:      body.qtyOrderedUOM     !== undefined ? body.qtyOrderedUOM     : undefined,
        rate:               body.rate              !== undefined ? body.rate              : undefined,
        rateUOM:            body.rateUOM           !== undefined ? body.rateUOM           : undefined,
        isCatchweight:      body.isCatchweight     !== undefined ? body.isCatchweight     : undefined,
        nominalWeight:      body.nominalWeight     !== undefined ? body.nominalWeight     : undefined,
        lineCategory:       body.lineCategory      !== undefined ? body.lineCategory      : undefined,
        supplierItemCode:   body.supplierItemCode  !== undefined ? body.supplierItemCode  : undefined,
        matchConfidence:    body.matchConfidence   !== undefined ? body.matchConfidence   : undefined,
        matchScore:         body.matchScore        !== undefined ? body.matchScore        : undefined,
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

      // Adopt orphaned offers: supplier prices recorded under this OCR text name
      // with no supplier link belong to the now-linked supplier. Backfilling lets
      // the Suppliers page attribute their spend/history to the real record.
      await prisma.inventorySupplierPrice.updateMany({
        where: { supplierName: session.supplierName, supplierId: null },
        data:  { supplierId: body.supplierId },
      })
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
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
              baseUnit: true,
              pricing: true,
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
      // Revert the spine by rolling the `pricing` chain back to the previous price
      // (the computed pricePerBaseUnit derives from it). The pricing MODE follows
      // the item's existing chain pricing (RATE keeps the rate's own unit), so a
      // rate-priced item stays a rate; everything else is PACK. Pack FORMAT is untouched.
      const mi = scanItem.matchedItem
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const miPricing = mi.pricing as any
      const revertedPricing =
        miPricing?.mode === 'RATE'
          ? { mode: 'RATE', rate: prevPrice, rateUnit: miPricing.rateUnit || mi.baseUnit || 'each' }
          : { mode: 'PACK', purchasePrice: prevPrice }

      await prisma.inventoryItem.update({
        where: { id: scanItem.matchedItemId },
        data: {
          purchasePrice: prevPrice,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pricing: revertedPricing as any,
        },
      })
      pricesReverted++
    }
  }

  await prisma.invoiceSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true, pricesReverted })
}
