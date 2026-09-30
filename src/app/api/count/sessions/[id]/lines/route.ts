import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { asChainItem, pricePerBaseUnit, withPpb } from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { seesCountMoney, redactLineMoney } from '@/lib/count-redact'

export const dynamic = 'force-dynamic'

// POST /api/count/sessions/:id/lines — add a single item to an existing session
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  // Authenticate BEFORE touching the body.
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { inventoryItemId } = await req.json()

  const session = await prisma.countSession.findUnique({ where: { id: params.id } })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // RC scope: mirrors the write guard on /api/count/sessions/[id] PATCH/DELETE —
  // a session with no RC (legacy "all items") is left unguarded.
  if (session.revenueCenterId) {
    try { await assertRcWritable(user, session.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  if (session.status === 'FINALIZED') return NextResponse.json({ error: 'Session is finalized' }, { status: 400 })

  // Prevent duplicate lines
  const existing = await prisma.countLine.findFirst({
    where: { sessionId: params.id, inventoryItemId },
  })
  if (existing) return NextResponse.json({ error: 'Item already in session' }, { status: 409 })

  const item = await prisma.inventoryItem.findUnique({
    where: { id: inventoryItemId },
    include: { storageArea: true },
  })
  if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 })

  const maxSort = await prisma.countLine.aggregate({
    where: { sessionId: params.id },
    _max: { sortOrder: true },
  })

  const line = await prisma.countLine.create({
    data: {
      sessionId: params.id,
      inventoryItemId,
      expectedQty: Number(item.stockOnHand),
      selectedUom: item.countUnit ?? item.baseUnit,
      priceAtCount: pricePerBaseUnit(asChainItem(item)),
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    include: { inventoryItem: { include: { storageArea: true } } },
  })

  // Re-populate the computed pricePerBaseUnit the count page reads off the line.
  const out = { ...line, inventoryItem: withPpb(line.inventoryItem) }
  // Below MANAGER: no price on the line or its item.
  return NextResponse.json(seesCountMoney(user.role) ? out : redactLineMoney(out), { status: 201 })
}
