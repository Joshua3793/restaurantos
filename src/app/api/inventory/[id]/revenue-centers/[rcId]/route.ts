import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { checkMembershipRemoval } from '@/lib/item-rc'

export const dynamic = 'force-dynamic'

// DELETE /api/inventory/[id]/revenue-centers/[rcId] — remove a membership.
// Blocked when the RC still holds stock for the item, or it's the item's last RC.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; rcId: string } },
) {
  const guard = await checkMembershipRemoval(params.id, params.rcId)
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: 409 })

  await prisma.itemRevenueCenter.deleteMany({
    where: { inventoryItemId: params.id, revenueCenterId: params.rcId },
  })
  return NextResponse.json({ ok: true })
}
