import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/revenue-centers — the RCs this item is a member of.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const memberships = await prisma.itemRevenueCenter.findMany({
    where: { inventoryItemId: params.id },
    select: { revenueCenter: { select: { id: true, name: true, color: true, isDefault: true } } },
    orderBy: { revenueCenter: { name: 'asc' } },
  })
  return NextResponse.json(memberships.map(m => m.revenueCenter))
}

// POST /api/inventory/[id]/revenue-centers — add a membership { revenueCenterId }.
// Idempotent (unique constraint → no-op if already a member).
async function handlePOST(req: NextRequest, { params }: { params: { id: string } }) {
  // Item edits are MANAGER+ (src/lib/inventory-redact.ts canEditItems).
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { revenueCenterId } = await req.json().catch(() => ({}))
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })

  await prisma.itemRevenueCenter.upsert({
    where: { inventoryItemId_revenueCenterId: { inventoryItemId: params.id, revenueCenterId } },
    create: { inventoryItemId: params.id, revenueCenterId },
    update: {},
  })
  return NextResponse.json({ ok: true }, { status: 201 })
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const POST = invalidatesTheoretical(handlePOST)
