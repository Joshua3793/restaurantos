import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit } from '@/lib/utils'

// GET /api/invoices/sessions — list all sessions
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const where = rcId
    ? (isDefault
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : { revenueCenterId: rcId })
    : {}

  const sessions = await prisma.invoiceSession.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      files: { select: { id: true, fileName: true, ocrStatus: true } },
      _count: { select: { scanItems: true, priceAlerts: true, recipeAlerts: true } },
    },
  })
  return NextResponse.json(sessions, {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' },
  })
}

// DELETE /api/invoices/sessions — bulk delete sessions by id list
// Body: { ids: string[] }
export async function DELETE(req: NextRequest) {
  const { ids } = await req.json().catch(() => ({ ids: [] as string[] }))
  if (!Array.isArray(ids) || ids.length === 0)
    return NextResponse.json({ error: 'ids array required' }, { status: 400 })

  let pricesReverted = 0

  for (const id of ids) {
    const session = await prisma.invoiceSession.findUnique({
      where: { id },
      select: {
        id: true, status: true,
        scanItems: {
          where: { action: 'UPDATE_PRICE', approved: true },
          select: {
            matchedItemId: true, previousPrice: true,
            matchedItem: { select: { id: true, qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true, packSize: true, packUOM: true } },
          },
        },
      },
    })
    if (!session) continue

    if (session.status === 'APPROVED') {
      for (const scanItem of session.scanItems) {
        if (!scanItem.matchedItemId || scanItem.previousPrice === null || !scanItem.matchedItem) continue
        const prevPrice = Number(scanItem.previousPrice)
        await prisma.inventoryItem.update({
          where: { id: scanItem.matchedItemId },
          data: {
            purchasePrice: prevPrice,
            pricePerBaseUnit: calcPricePerBaseUnit(
              prevPrice,
              Number(scanItem.matchedItem.qtyPerPurchaseUnit),
              scanItem.matchedItem.qtyUOM ?? 'each',
              scanItem.matchedItem.innerQty != null ? Number(scanItem.matchedItem.innerQty) : null,
              Number(scanItem.matchedItem.packSize),
              scanItem.matchedItem.packUOM ?? 'each',
            ),
          },
        })
        pricesReverted++
      }
    }

    await prisma.invoiceSession.delete({ where: { id } })
  }

  return NextResponse.json({ ok: true, deleted: ids.length, pricesReverted })
}

// POST /api/invoices/sessions — create a new session
export async function POST(req: NextRequest) {
  const { supplierName, supplierId, revenueCenterId } = await req.json().catch(() => ({}))

  const session = await prisma.invoiceSession.create({
    data: {
      status: 'UPLOADING',
      supplierName: supplierName || null,
      supplierId: supplierId || null,
      revenueCenterId: revenueCenterId || null,
    },
  })

  return NextResponse.json(session, { status: 201 })
}
