import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkMembershipRemoval } from '@/lib/item-rc'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'
import { requireSession, AuthError } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// DELETE /api/inventory/[id]/revenue-centers/[rcId] — remove a membership.
// Blocked when the RC still holds stock for the item, or it's the item's last RC.
async function handleDELETE(
  _req: NextRequest,
  { params }: { params: { id: string; rcId: string } },
) {
  // Item edits are MANAGER+ (src/lib/inventory-redact.ts canEditItems).
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const guard = await checkMembershipRemoval(params.id, params.rcId)
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 409 })

  await prisma.itemRevenueCenter.deleteMany({
    where: { inventoryItemId: params.id, revenueCenterId: params.rcId },
  })
  return NextResponse.json({ ok: true })
}

// Stock-moving writes drop the cached theoretical-stock map (inventory list, cost chrome).
export const DELETE = invalidatesTheoretical(handleDELETE)
