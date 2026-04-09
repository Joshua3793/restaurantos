import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// GET /api/invoices/alerts — get all unacknowledged alerts
export async function GET() {
  const [priceAlerts, recipeAlerts] = await Promise.all([
    prisma.priceAlert.findMany({
      where: { acknowledged: false },
      include: {
        inventoryItem: { select: { id: true, itemName: true } },
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
