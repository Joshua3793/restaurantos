import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'

const RECIPE_SELECT = {
  id: true, name: true, menuPrice: true,
  portionSize: true, portionUnit: true, yieldUnit: true, baseYieldQty: true,
  category: { select: { name: true, color: true } },
}

const RC_SELECT = { id: true, name: true, color: true }

export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: false })

  const dateWhere: Record<string, unknown> = {}
  if (startDate) dateWhere.gte = new Date(startDate)
  if (endDate)   dateWhere.lte = new Date(endDate + 'T23:59:59.999Z')

  const sales = await prisma.salesEntry.findMany({
    where: {
      AND: [
        Object.keys(dateWhere).length ? { date: dateWhere } : {},
        scopeWhere,
      ],
    },
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
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { lineItems = [], revenueCenterId: bodyRcId, ...rest } = body

  const revenueCenterId: string | null = bodyRcId ?? null
  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const entry = await prisma.salesEntry.create({
    data: {
      date:           new Date(rest.date),
      totalRevenue:   parseFloat(rest.totalRevenue) || 0,
      foodSalesPct:   parseFloat(rest.foodSalesPct) || 0.7,
      covers:         rest.covers ? parseInt(rest.covers) : null,
      notes:          rest.notes || null,
      periodType:     rest.periodType ?? 'day',
      endDate:        rest.endDate ? new Date(rest.endDate) : null,
      revenueCenterId,
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
