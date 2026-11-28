import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { movementQtyBase } from '@/lib/movement-qty'
import { itemCost } from '@/lib/cost-basis'
import { requireSession, AuthError } from '@/lib/auth'
import { scopeWhereFromParams, assertRcWritable } from '@/lib/rc-scope'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { prepDayFrom, prepDayRange } from '@/lib/prep-day'
import { displayName } from '@/lib/checklists/who'
import { isWasteReason } from '@/components/wastage/reasons'
import { cleanPhotoUrl } from '@/lib/photo-url'
import { seesWasteMoney, redactWasteLog, canDeleteWaste, WASTE_ITEM_SELECT } from './rules'

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
    // Only what the list shows — the whole item row used to ride along, pricing and all.
    include: { inventoryItem: { select: WASTE_ITEM_SELECT } },
    // Newest first within a day too (the day marker ties; a cuid id sorts by time).
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  })
  // Below MANAGER the dollars are nulled server-side (src/app/api/wastage/rules.ts);
  // `canDelete` tells each row's ⋯ whether this viewer may delete it.
  const money = seesWasteMoney(user.role)
  const name = await displayName(user)
  const now = new Date()
  return NextResponse.json(logs.map(l => {
    const row = { ...l, canDelete: canDeleteWaste({ role: user.role, name }, l, now) }
    return money ? row : redactWasteLog(row)
  }))
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
  const { inventoryItemId, qtyWasted, unit, reason, notes, date, photoUrl } = body

  // A reason is a pick, never a default: the old form saved UNKNOWN for anyone who
  // didn't touch the dropdown.
  if (!isWasteReason(reason)) {
    return NextResponse.json({ error: 'Pick a reason.' }, { status: 400 })
  }
  const qty = parseFloat(qtyWasted)
  if (!(qty > 0) || typeof unit !== 'string' || !unit) {
    return NextResponse.json({ error: 'Enter how much was wasted.' }, { status: 400 })
  }

  const revenueCenterId: string | null = body.revenueCenterId ?? null
  if (!revenueCenterId) {
    return NextResponse.json({ error: 'A revenue center must be selected to record this.' }, { status: 400 })
  }

  try { await assertRcWritable(user, revenueCenterId) }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const item = inventoryItemId ? await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } }) : null
  if (!item) return NextResponse.json({ error: 'Pick an item.' }, { status: 400 })
  // Wastage is an expense, costed like a recipe line: what a base unit actually
  // cost us lately (30-day average across suppliers), LAST when nothing was bought.
  const ppbu = (await itemCost(item.id, 'AVG_30D'))?.pricePerBase ?? 0
  const conv = movementQtyBase(qty, unit, item)
  if (conv.unbridged) {
    const own = item.dimension === 'MASS' ? 'g or kg' : item.dimension === 'VOLUME' ? 'ml or l' : 'each'
    return NextResponse.json({ error: `${item.itemName} can't be logged in ${unit} — log it in ${own}` }, { status: 400 })
  }
  const qtyBase = conv.qtyBase
  const costImpact = qtyBase * ppbu

  const name = await displayName(user)
  const log = await prisma.wastageLog.create({
    data: {
      inventoryItemId,
      // The restaurant's (Pacific) day as a UTC-midnight marker — the same
      // convention as PrepLog.logDate (src/lib/prep-day.ts). A bare 'YYYY-MM-DD'
      // stays that day; missing → today in Pacific, not UTC (`new Date()` rolled
      // the day over at ~4–5pm, so evening waste landed on tomorrow).
      date:            prepDayFrom(date),
      qtyWasted:       qty,
      unit,
      reason,
      costImpact,
      loggedBy:        name,
      notes:           typeof notes === 'string' && notes.trim() ? notes.trim() : null,
      // Optional, and only an UploadThing file link (src/lib/photo-url.ts); anything
      // else is dropped and the entry saves without it — a photo never blocks a save.
      photoUrl:        cleanPhotoUrl(photoUrl),
      revenueCenterId,
    },
    include: { inventoryItem: { select: WASTE_ITEM_SELECT } },
  })
  // The person who just logged it may always undo it (inside the 24 h window).
  const row = { ...log, canDelete: true }
  return NextResponse.json(seesWasteMoney(user.role) ? row : redactWasteLog(row), { status: 201 })
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
