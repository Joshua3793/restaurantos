import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { movementQtyBase } from '@/lib/movement-qty'
import { itemCost } from '@/lib/cost-basis'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'

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
  const itemId    = searchParams.get('itemId')
  const reason    = searchParams.get('reason')
  const scopeWhere = await scopeWhereFromParams(user, searchParams, { nullable: false })

  const logs = await prisma.wastageLog.findMany({
    where: {
      AND: [
        startDate ? { date: { gte: new Date(startDate) } } : {},
        endDate   ? { date: { lte: new Date(endDate) } }  : {},
        itemId    ? { inventoryItemId: itemId }            : {},
        reason    ? { reason }                             : {},
        scopeWhere,
      ],
    },
    include: { inventoryItem: true },
    orderBy: { date: 'desc' },
  })
  return NextResponse.json(logs)
}

async function handlePOST(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { inventoryItemId, qtyWasted, unit, reason, loggedBy, notes, date } = body

  const revenueCenterId: string | null = body.revenueCenterId ?? null
  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } })
  // Wastage is an expense, costed like a recipe line: what a base unit actually
  // cost us lately (30-day average across suppliers), LAST when nothing was bought.
  const ppbu = item ? (await itemCost(item.id, 'AVG_30D'))?.pricePerBase ?? 0 : 0
  const qtyBase = item ? movementQtyBase(parseFloat(qtyWasted), unit, item).qtyBase : parseFloat(qtyWasted)
  const costImpact = qtyBase * ppbu

  const log = await prisma.wastageLog.create({
    data: {
      inventoryItemId,
      date:            date ? new Date(date) : new Date(),
      qtyWasted:       parseFloat(qtyWasted),
      unit,
      reason:          reason || 'UNKNOWN',
      costImpact,
      loggedBy:        loggedBy || 'System',
      notes,
      revenueCenterId,
    },
    include: { inventoryItem: true },
  })
  return NextResponse.json(log, { status: 201 })
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
