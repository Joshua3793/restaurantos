import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// GET /api/inventory/[id]/revenue-centers — the RCs this item is a member of.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const memberships = await prisma.itemRevenueCenter.findMany({
    where: { inventoryItemId: params.id },
    select: { revenueCenter: { select: { id: true, name: true, color: true, isDefault: true } } },
    orderBy: { revenueCenter: { name: 'asc' } },
  })
  return NextResponse.json(memberships.map(m => m.revenueCenter))
}

// POST /api/inventory/[id]/revenue-centers — add a membership { revenueCenterId }.
// Idempotent (unique constraint → no-op if already a member).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { revenueCenterId } = await req.json().catch(() => ({}))
  if (!revenueCenterId) return NextResponse.json({ error: 'revenueCenterId is required' }, { status: 400 })

  await prisma.itemRevenueCenter.upsert({
    where: { inventoryItemId_revenueCenterId: { inventoryItemId: params.id, revenueCenterId } },
    create: { inventoryItemId: params.id, revenueCenterId },
    update: {},
  })
  return NextResponse.json({ ok: true }, { status: 201 })
}
