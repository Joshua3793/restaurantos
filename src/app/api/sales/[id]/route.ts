import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toastCoveredDays, toastOverlapMessage } from '@/lib/sales-guard'

const RECIPE_SELECT = {
  id: true, name: true, menuPrice: true,
  portionSize: true, portionUnit: true, yieldUnit: true, baseYieldQty: true,
  category: { select: { name: true, color: true } },
}

const RC_SELECT = { id: true, name: true, color: true }

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const entry = await prisma.salesEntry.findUnique({
    where: { id: params.id },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: { include: { recipe: { select: RECIPE_SELECT } }, orderBy: { qtySold: 'desc' } },
    },
  })
  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(entry)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  // Guard: don't let a MANUAL entry be moved onto Toast-covered days (double-counts
  // revenue — reports have no source dedup). Toast rows are exempt (editing Toast over
  // other Toast is the sync's concern, not a double-count). Exclude self from the check.
  const existing = await prisma.salesEntry.findUnique({ where: { id: params.id }, select: { source: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.source !== 'toast') {
    const covered = await toastCoveredDays(revenueCenterId, new Date(rest.date), rest.endDate ? new Date(rest.endDate) : null, params.id)
    if (covered.length > 0) {
      return NextResponse.json({ error: toastOverlapMessage(covered) }, { status: 409 })
    }
  }

  // Replace all line items
  await prisma.saleLineItem.deleteMany({ where: { saleId: params.id } })

  const entry = await prisma.salesEntry.update({
    where: { id: params.id },
    data: {
      date:         new Date(rest.date),
      totalRevenue: parseFloat(rest.totalRevenue) || 0,
      foodSalesPct: parseFloat(rest.foodSalesPct) || 0.7,
      covers:       rest.covers ? parseInt(rest.covers) : null,
      notes:        rest.notes || null,
      periodType:   rest.periodType ?? 'day',
      endDate:      rest.endDate ? new Date(rest.endDate) : null,
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
  return NextResponse.json(entry)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.salesEntry.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
