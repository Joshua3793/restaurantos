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

  // Customer tips — TRI-STATE, mirroring POST. The key being ABSENT means "leave
  // the column alone" (an API caller that doesn't know about tips must not wipe
  // them); '' or null means "clear it" (null = "no tip data for this day", which
  // a TIPS_COLLECTED-basis payout treats as a blocking error, not as zero); a
  // number is stored. The /sales form always sends the key, so an edited figure
  // now persists instead of being silently discarded.
  const tipsSent =
    Object.prototype.hasOwnProperty.call(rest, 'tipsCollected') && rest.tipsCollected !== undefined
  let tipsCollected: number | null = null
  if (tipsSent && rest.tipsCollected !== null && rest.tipsCollected !== '') {
    const v = Number(rest.tipsCollected)
    if (!isFinite(v) || v < 0) {
      return NextResponse.json({ error: 'tipsCollected must be zero or a positive number' }, { status: 400 })
    }
    tipsCollected = Math.round(v * 100) / 100
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
      ...(tipsSent ? { tipsCollected } : {}),
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
