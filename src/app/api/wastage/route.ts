import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { movementQtyBase } from '@/lib/movement-qty'
import { itemCost } from '@/lib/cost-basis'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { prepDayFrom, prepDayRange } from '@/lib/prep-day'
import { displayName } from '@/lib/checklists/who'

export const dynamic = 'force-dynamic'

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
        startDate ? { date: { gte: prepDayFrom(startDate) } }   : {},
        // Through the END of the end day (a bare `lte` marker dropped anything
        // stored later that day).
        endDate   ? { date: { lt: prepDayRange(endDate).lt } } : {},
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
  // `loggedBy` in the body is ignored: the signed-in person is who logged it (a
  // blank typed box used to save "System").
  const { inventoryItemId, qtyWasted, unit, reason, notes, date } = body

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
  const conv = item ? movementQtyBase(parseFloat(qtyWasted), unit, item) : null
  if (conv?.unbridged) {
    const own = item!.dimension === 'MASS' ? 'g or kg' : item!.dimension === 'VOLUME' ? 'ml or l' : 'each'
    return NextResponse.json({ error: `${item!.itemName} can't be logged in ${unit} — log it in ${own}` }, { status: 400 })
  }
  const qtyBase = conv ? conv.qtyBase : parseFloat(qtyWasted)
  const costImpact = qtyBase * ppbu

  const log = await prisma.wastageLog.create({
    data: {
      inventoryItemId,
      // The restaurant's (Pacific) day as a UTC-midnight marker — the same
      // convention as PrepLog.logDate (src/lib/prep-day.ts). A bare 'YYYY-MM-DD'
      // stays that day; missing → today in Pacific, not UTC (`new Date()` rolled
      // the day over at ~4–5pm, so evening waste landed on tomorrow).
      date:            prepDayFrom(date),
      qtyWasted:       parseFloat(qtyWasted),
      unit,
      reason:          reason || 'UNKNOWN',
      costImpact,
      loggedBy:        await displayName(user),
      notes,
      revenueCenterId,
    },
    include: { inventoryItem: true },
  })
  return NextResponse.json(log, { status: 201 })
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
