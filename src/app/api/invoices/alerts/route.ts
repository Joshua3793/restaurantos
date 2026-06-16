import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

// GET /api/invoices/alerts — get all unacknowledged alerts
export async function GET() {
  const [priceAlertsRaw, recipeAlerts] = await Promise.all([
    prisma.priceAlert.findMany({
      where: { acknowledged: false },
      include: {
        inventoryItem: { select: { id: true, itemName: true, purchaseUnit: true, ...PRICING_SELECT } },
        session: { select: { id: true, supplierName: true, invoiceDate: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.recipeAlert.findMany({
      where: { acknowledged: false },
      include: {
        recipe: { select: { id: true, name: true, menuPrice: true } },
        session: { select: { id: true, supplierName: true, invoiceDate: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  // Keep the response's inventoryItem.pricePerBaseUnit field populated for the
  // alert UI by computing it from the chain (survives the legacy column drop).
  const priceAlerts = priceAlertsRaw.map(a =>
    a.inventoryItem
      ? { ...a, inventoryItem: { ...a.inventoryItem, pricePerBaseUnit: pricePerBaseUnit(asChainItem(a.inventoryItem)) } }
      : a
  )

  return NextResponse.json({
    priceAlerts,
    recipeAlerts,
    totalUnread: priceAlerts.length + recipeAlerts.length,
  })
}

// PATCH /api/invoices/alerts — acknowledge alerts
export async function PATCH(req: NextRequest) {
  const { priceAlertIds = [], recipeAlertIds = [], acknowledgeAll = false } = await req.json()

  if (acknowledgeAll) {
    await Promise.all([
      prisma.priceAlert.updateMany({ data: { acknowledged: true } }),
      prisma.recipeAlert.updateMany({ data: { acknowledged: true } }),
    ])
  } else {
    await Promise.all([
      priceAlertIds.length > 0 &&
        prisma.priceAlert.updateMany({
          where: { id: { in: priceAlertIds } },
          data: { acknowledged: true },
        }),
      recipeAlertIds.length > 0 &&
        prisma.recipeAlert.updateMany({
          where: { id: { in: recipeAlertIds } },
          data: { acknowledged: true },
        }),
    ])
  }

  return NextResponse.json({ ok: true })
}
