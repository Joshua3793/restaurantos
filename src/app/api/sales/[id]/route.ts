import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope, assertRcWritable } from '@/lib/rc-scope'
import { toastCoveredDays, toastOverlapMessage } from '@/lib/sales-guard'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

const RECIPE_SELECT = {
  id: true, name: true, menuPrice: true,
  portionSize: true, portionUnit: true, yieldUnit: true, baseYieldQty: true,
  category: { select: { name: true, color: true } },
}

const RC_SELECT = { id: true, name: true, color: true }

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const entry = await prisma.salesEntry.findUnique({
    where: { id: params.id },
    include: {
      revenueCenter: { select: RC_SELECT },
      lineItems: { include: { recipe: { select: RECIPE_SELECT } }, orderBy: { qtySold: 'desc' } },
    },
  })
  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: a scoped manager can't read an entry outside their revenue centers.
  // 404 (not 403) so the response doesn't confirm the row exists.
  if (!(await isRcInScope(user, entry.revenueCenterId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json(entry)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  // Authenticate BEFORE touching the body: an unauthenticated caller should not be
  // able to make the server parse arbitrary input.
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { lineItems = [], revenueCenterId, ...rest } = body

  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  // Guard: don't let a MANUAL entry be moved onto Toast-covered days (double-counts
  // revenue — reports have no source dedup). Toast rows are exempt (editing Toast over
  // other Toast is the sync's concern, not a double-count). Exclude self from the check.
  const existing = await prisma.salesEntry.findUnique({ where: { id: params.id }, select: { source: true, revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: check both the entry's current RC and the (possibly changed) target RC —
  // mirrors the write guard in /api/prep/items/[id] PUT.
  try {
    await assertRcWritable(user, existing.revenueCenterId)
    if (revenueCenterId !== existing.revenueCenterId) await assertRcWritable(user, revenueCenterId)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.salesEntry.findUnique({ where: { id: params.id }, select: { revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try { await assertRcWritable(user, existing.revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  await prisma.salesEntry.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
