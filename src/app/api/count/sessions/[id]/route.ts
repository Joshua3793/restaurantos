import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withPpb } from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { isRcInScope, assertRcWritable } from '@/lib/rc-scope'

// Mutating handlers must never be statically prerendered — a prerendered
// route serves GET only and returns 405 for everything else.
export const dynamic = 'force-dynamic'

// GET /api/count/sessions/:id
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: [{ sortOrder: 'asc' }, { inventoryItem: { category: 'asc' } }, { inventoryItem: { itemName: 'asc' } }],
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: a scoped user can't read a session outside their revenue centers.
  // A session with no RC (legacy "all items") is shared — visible to everyone,
  // mirroring scopeWhereFromParams({ nullable: true }) on the collection route.
  // 404 (not 403) so the response doesn't confirm the row exists.
  if (session.revenueCenterId && !(await isRcInScope(user, session.revenueCenterId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Pull StockAllocation.parLevel for this session's RC so count cards can display
  // the per-RC par level alongside the item's own lastCountQty (which is on the item).
  const parMap = new Map<string, number>()
  if (session.revenueCenterId) {
    const allocs = await prisma.stockAllocation.findMany({
      where: {
        revenueCenterId: session.revenueCenterId,
        inventoryItemId: { in: session.lines.map(l => l.inventoryItemId) },
      },
      select: { inventoryItemId: true, parLevel: true },
    })
    for (const a of allocs) {
      if (a.parLevel != null) parMap.set(a.inventoryItemId, Number(a.parLevel))
    }
  }

  const lines = session.lines.map(l => ({
    ...l,
    // withPpb re-populates the computed pricePerBaseUnit the count page reads
    // (page.tsx:2574 `l.inventoryItem.pricePerBaseUnit ?? l.priceAtCount`).
    inventoryItem: {
      ...withPpb(l.inventoryItem),
      parLevel: parMap.get(l.inventoryItemId) ?? null,
    },
  }))

  const total   = lines.length
  const counted = lines.filter(l => l.countedQty !== null && !l.skipped).length
  const skipped = lines.filter(l => l.skipped).length

  return NextResponse.json({ ...session, lines, counts: { total, counted, skipped, pctComplete: total > 0 ? counted / total : 0 } })
}

// PATCH /api/count/sessions/:id  — update label / reopen finalized session
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  // Authenticate BEFORE touching the body: an unauthenticated caller should not be
  // able to make the server parse arbitrary input.
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.countSession.findUnique({ where: { id: params.id }, select: { revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: a session with no RC (legacy "all items") is left unguarded here,
  // mirroring the collection route's write guard (assertRcWritable only fires
  // for an RC-scoped session — see /api/prep/items/[id] PUT for the same pattern).
  if (existing.revenueCenterId) {
    try { await assertRcWritable(user, existing.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const body = await req.json()
  const data: Record<string, unknown> = {}
  if (body.label       !== undefined) data.label       = body.label
  if (body.countedBy   !== undefined) data.countedBy   = body.countedBy
  if (body.sessionDate !== undefined) data.sessionDate = new Date(body.sessionDate)
  if (body.status      !== undefined) data.status      = body.status
  const updated = await prisma.countSession.update({ where: { id: params.id }, data })
  return NextResponse.json(updated)
}

// DELETE /api/count/sessions/:id
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const existing = await prisma.countSession.findUnique({ where: { id: params.id }, select: { revenueCenterId: true } })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (existing.revenueCenterId) {
    try { await assertRcWritable(user, existing.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  await prisma.countSession.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
