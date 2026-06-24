import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { rcHasStockForItem } from '@/lib/item-rc'

export const dynamic = 'force-dynamic'

interface Blocked { itemId: string; rcId: string; reason: string }

// POST /api/inventory/revenue-centers/bulk
// { itemIds: string[], rcIds: string[], action: 'add' | 'remove' }
// Add: idempotent upsert of every (item, rc) pair.
// Remove: per item, skip pairs that still hold stock or would empty the item's RC set;
// blocked pairs are reported, never silently dropped.
export async function POST(req: NextRequest) {
  const { itemIds, rcIds, action } = await req.json().catch(() => ({}))
  if (!Array.isArray(itemIds) || !Array.isArray(rcIds) || itemIds.length === 0 || rcIds.length === 0) {
    return NextResponse.json({ error: 'itemIds and rcIds are required (non-empty arrays)' }, { status: 400 })
  }
  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json({ error: "action must be 'add' or 'remove'" }, { status: 400 })
  }

  // Validate the RCs exist (FK would error mid-batch otherwise).
  const validRcs = await prisma.revenueCenter.findMany({
    where: { id: { in: rcIds } }, select: { id: true },
  })
  const validRcIds = new Set(validRcs.map(r => r.id))
  const rcs = rcIds.filter((r: string) => validRcIds.has(r))
  if (rcs.length === 0) return NextResponse.json({ error: 'No valid revenue centers' }, { status: 400 })

  if (action === 'add') {
    const data = itemIds.flatMap((inventoryItemId: string) =>
      rcs.map((revenueCenterId: string) => ({ inventoryItemId, revenueCenterId })))
    const res = await prisma.itemRevenueCenter.createMany({ data, skipDuplicates: true })
    return NextResponse.json({ added: res.count, removed: 0, blocked: [] })
  }

  // remove
  const blocked: Blocked[] = []
  const toDelete: { inventoryItemId: string; revenueCenterId: string }[] = []
  for (const inventoryItemId of itemIds as string[]) {
    const current = await prisma.itemRevenueCenter.findMany({
      where: { inventoryItemId }, select: { revenueCenterId: true },
    })
    const currentSet = new Set(current.map(c => c.revenueCenterId))
    const requested = rcs.filter((r: string) => currentSet.has(r))

    const removable: string[] = []
    for (const revenueCenterId of requested) {
      if (await rcHasStockForItem(inventoryItemId, revenueCenterId)) {
        blocked.push({ itemId: inventoryItemId, rcId: revenueCenterId, reason: 'has stock in this RC' })
        continue
      }
      removable.push(revenueCenterId)
    }
    if (removable.length > 0 && currentSet.size - removable.length < 1) {
      // Would leave the item with zero RCs — block this item's removals.
      for (const revenueCenterId of removable) {
        blocked.push({ itemId: inventoryItemId, rcId: revenueCenterId, reason: 'item must keep at least one RC' })
      }
      continue
    }
    for (const revenueCenterId of removable) toDelete.push({ inventoryItemId, revenueCenterId })
  }

  let removed = 0
  if (toDelete.length > 0) {
    const res = await prisma.itemRevenueCenter.deleteMany({
      where: { OR: toDelete },
    })
    removed = res.count
  }
  return NextResponse.json({ added: 0, removed, blocked })
}
