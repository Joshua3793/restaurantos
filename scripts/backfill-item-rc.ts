import { prisma } from '../src/lib/prisma'

// Seed ItemRevenueCenter so behavior is unchanged on day one:
//  1. every active item → the default RC
//  2. every existing StockAllocation (item, rc) → membership
async function main() {
  const defaultRc = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!defaultRc) throw new Error('No default revenue center found')

  const items = await prisma.inventoryItem.findMany({ where: { isActive: true }, select: { id: true } })
  const allocs = await prisma.stockAllocation.findMany({ select: { inventoryItemId: true, revenueCenterId: true } })

  // Build the unique set of (item, rc) memberships to ensure.
  const pairs = new Map<string, { inventoryItemId: string; revenueCenterId: string }>()
  for (const it of items) pairs.set(`${it.id}:${defaultRc.id}`, { inventoryItemId: it.id, revenueCenterId: defaultRc.id })
  for (const a of allocs) pairs.set(`${a.inventoryItemId}:${a.revenueCenterId}`, { inventoryItemId: a.inventoryItemId, revenueCenterId: a.revenueCenterId })

  const data = Array.from(pairs.values())
  const res = await prisma.itemRevenueCenter.createMany({ data, skipDuplicates: true })
  const total = await prisma.itemRevenueCenter.count()
  console.log(JSON.stringify({ defaultRc: defaultRc.name, activeItems: items.length, allocations: allocs.length, attempted: data.length, inserted: res.count, totalNow: total }, null, 2))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
