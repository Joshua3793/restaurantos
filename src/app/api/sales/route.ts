import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

const RECIPE_SELECT = {
  id: true, name: true, menuPrice: true,
  portionSize: true, portionUnit: true, yieldUnit: true, baseYieldQty: true,
  category: { select: { name: true, color: true } },
}

const RC_SELECT = { id: true, name: true, color: true }

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const where: Record<string, unknown> = {}
  if (startDate) where.date = { ...(where.date as object ?? {}), gte: new Date(startDate) }
  if (endDate)   where.date = { ...(where.date as object ?? {}), lte: new Date(endDate + 'T23:59:59.999Z') }
  if (rcId) {
    where.OR = isDefault
      ? [{ revenueCenterId: rcId }, { revenueCenterId: null }]
      : [{ revenueCenterId: rcId }]
  }

  const sales = await prisma.salesEntry.findMany({
    where,
    orderBy: { date: 'desc' },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: {
        include: { recipe: { select: RECIPE_SELECT } },
        orderBy: { qtySold: 'desc' },
      },
    },
  })
  return NextResponse.json(sales)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  const entry = await prisma.salesEntry.create({
    data: {
      date:           new Date(rest.date),
      totalRevenue:   parseFloat(rest.totalRevenue) || 0,
      foodSalesPct:   parseFloat(rest.foodSalesPct) || 0.7,
      covers:         rest.covers ? parseInt(rest.covers) : null,
      notes:          rest.notes || null,
      revenueCenterId: revenueCenterId || null,
      lineItems: {
        create: (lineItems as { recipeId: string; qtySold: number }[])
          .filter(li => li.recipeId && li.qtySold > 0)
          .map(li => ({ recipeId: li.recipeId, qtySold: parseInt(String(li.qtySold)) })),
      },
    },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: { include: { recipe: { select: RECIPE_SELECT } } },
    },
  })
  return NextResponse.json(entry, { status: 201 })
}
