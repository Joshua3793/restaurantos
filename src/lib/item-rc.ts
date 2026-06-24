import { prisma } from './prisma'

// Item↔revenue-center membership helpers. See
// docs/superpowers/specs/2026-06-24-item-rc-membership-design.md

export interface RemovalGuard {
  ok: boolean
  reason?: string
}

/**
 * Whether an item still holds stock in an RC (which would be orphaned by removing the
 * membership): the default RC's stock is global `stockOnHand`; a non-default RC's is its
 * `StockAllocation.quantity`.
 */
export async function rcHasStockForItem(inventoryItemId: string, revenueCenterId: string): Promise<boolean> {
  const rc = await prisma.revenueCenter.findUnique({
    where: { id: revenueCenterId },
    select: { isDefault: true },
  })
  if (!rc) return false
  if (rc.isDefault) {
    const item = await prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: { stockOnHand: true },
    })
    return !!item && Number(item.stockOnHand) > 0
  }
  const alloc = await prisma.stockAllocation.findUnique({
    where: { revenueCenterId_inventoryItemId: { revenueCenterId, inventoryItemId } },
    select: { quantity: true },
  })
  return !!alloc && Number(alloc.quantity) > 0
}

/**
 * Guard a single membership removal: block when the RC still holds stock for the item,
 * and block removing an item's last RC (every item must belong to ≥ 1 RC). Pass
 * `remainingAfter` to evaluate the last-RC rule against a batch (how many memberships
 * the item will keep once the whole batch is applied); defaults to a live count − 1.
 */
export async function checkMembershipRemoval(
  inventoryItemId: string,
  revenueCenterId: string,
  remainingAfter?: number,
): Promise<RemovalGuard> {
  const remaining =
    remainingAfter ?? (await prisma.itemRevenueCenter.count({ where: { inventoryItemId } })) - 1
  if (remaining < 1) return { ok: false, reason: 'An item must belong to at least one revenue center.' }

  const rc = await prisma.revenueCenter.findUnique({
    where: { id: revenueCenterId },
    select: { name: true },
  })
  if (await rcHasStockForItem(inventoryItemId, revenueCenterId)) {
    return { ok: false, reason: `Zero out stock in ${rc?.name ?? 'that revenue center'} first.` }
  }
  return { ok: true }
}
