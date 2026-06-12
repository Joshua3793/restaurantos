import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildConsumptionMap, buildPrepMap, buildPurchaseMap, buildWastageMap, computeExpected } from '@/lib/count-expected'
import { convertCountQtyToBase, resolveCountUom } from '@/lib/count-uom'

// POST /api/count/sessions/:id/sync
// Full sync: adds new active items, removes lines for deleted/inactive items,
// and refreshes expectedQty + priceAtCount for unchanged (uncounted) lines
// using the same theoretical expected calculation as session creation.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: {
      lines: {
        include: { inventoryItem: true },
      },
    },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (session.status === 'FINALIZED') return NextResponse.json({ error: 'Session is finalized' }, { status: 400 })

  const areaIds: string[] = session.areaFilter
    ? session.areaFilter.split(',').map(s => s.trim()).filter(Boolean)
    : []

  // Fetch all currently-active inventory items in scope
  const activeItems = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const activeItemMap = new Map(activeItems.map(item => [item.id, item]))
  const existingLines = session.lines

  // ── 1. Lines to remove (item deleted or deactivated) ──────────────────────
  const toRemove = existingLines.filter(l => !activeItemMap.has(l.inventoryItemId))

  // ── 2. Lines to add (new active items not yet in session) ─────────────────
  const existingIds = new Set(existingLines.map(l => l.inventoryItemId))
  const toAdd = activeItems.filter(item => !existingIds.has(item.id))

  // ── 3. Uncounted lines to refresh ─────────────────────────────────────────
  const toUpdate = existingLines.filter(l => {
    if (!activeItemMap.has(l.inventoryItemId)) return false
    if (l.countedQty !== null || l.skipped) return false  // preserve counted work
    return true  // refresh expectedQty and price for all uncounted lines
  })

  // ── 4. Counted/skipped lines whose price drifted ──────────────────────────
  // Refreshing the unit price does NOT discard counted work — countedQty and
  // selectedUom are preserved; only the snapshotted price (and the variance
  // derived from it) are re-pulled from the now-corrected inventory item.
  // This is what makes a post-count inventory price fix actually flow through.
  const toReprice = existingLines.filter(l => {
    const item = activeItemMap.get(l.inventoryItemId)
    if (!item) return false
    if (l.countedQty === null && !l.skipped) return false  // uncounted → handled by toUpdate
    return Number(l.priceAtCount) !== Number(item.pricePerBaseUnit)  // only when it changed
  })

  // ── Build theoretical expected maps ───────────────────────────────────────
  // Use the earliest lastCountDate across all active items as the lookback window,
  // matching the approach used when the session was first created.
  const itemIds = activeItems.map(i => i.id)
  const earliestLastCount = activeItems
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  const [consumptionMap, purchaseMap, wastageMap, prepMap] = earliestLastCount
    ? await Promise.all([
        buildConsumptionMap(earliestLastCount, session.revenueCenterId),
        buildPurchaseMap(earliestLastCount, session.revenueCenterId),
        buildWastageMap(earliestLastCount, itemIds, session.revenueCenterId),
        buildPrepMap(earliestLastCount, session.revenueCenterId),
      ])
    : [new Map<string, number>(), new Map<string, number>(), new Map<string, number>(), { consumption: new Map<string, number>(), output: new Map<string, number>() }]

  // RC stock allocation baseline (same rules as session creation: non-default RC
  // with no allocation falls back to 0, not global stockOnHand).
  const stockAllocationMap = new Map<string, number>()
  let isDefaultRc = false
  if (session.revenueCenterId && itemIds.length > 0) {
    const rc = await prisma.revenueCenter.findUnique({
      where: { id: session.revenueCenterId },
      select: { isDefault: true },
    })
    isDefaultRc = !!rc?.isDefault
    const allocations = await prisma.stockAllocation.findMany({
      where: { revenueCenterId: session.revenueCenterId, inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocations) {
      stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
    }
  }

  const rcId = session.revenueCenterId
  function getExpected(itemId: string, stockOnHand: number): number {
    const baseStock = rcId
      ? (stockAllocationMap.has(itemId) ? stockAllocationMap.get(itemId)! : (isDefaultRc ? stockOnHand : 0))
      : stockOnHand
    return computeExpected(itemId, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output)
  }

  // Build nextSort from current max
  const maxSort = await prisma.countLine.aggregate({
    where: { sessionId: params.id },
    _max: { sortOrder: true },
  })
  let nextSort = (maxSort._max.sortOrder ?? -1) + 1

  await prisma.$transaction([
    // Remove stale lines
    ...(toRemove.length > 0
      ? [prisma.countLine.deleteMany({ where: { id: { in: toRemove.map(l => l.id) } } })]
      : []),

    // Refresh uncounted lines with theoretical expected + current price.
    // Preserve the user's selectedUom choice — they may have switched it.
    ...toUpdate.map(l => {
      const item = activeItemMap.get(l.inventoryItemId)!
      return prisma.countLine.update({
        where: { id: l.id },
        data: {
          expectedQty:  getExpected(item.id, Number(item.stockOnHand)),
          priceAtCount: item.pricePerBaseUnit,
        },
      })
    }),

    // Refresh price on counted/skipped lines and recompute their variance.
    // Counted work (countedQty, selectedUom) is left untouched.
    ...toReprice.map(l => {
      const item = activeItemMap.get(l.inventoryItemId)!
      if (l.skipped || l.countedQty === null) {
        // skipped lines carry no variance (qty == expected); price only
        return prisma.countLine.update({
          where: { id: l.id },
          data: { priceAtCount: item.pricePerBaseUnit },
        })
      }
      const itemDims = {
        baseUnit:           item.baseUnit,
        purchaseUnit:       item.purchaseUnit,
        qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
        qtyUOM:             item.qtyUOM ?? 'each',
        innerQty:           item.innerQty != null ? Number(item.innerQty) : null,
        packSize:           Number(item.packSize),
        packUOM:            item.packUOM,
        countUOM:           item.countUOM,
      }
      const countedBase = convertCountQtyToBase(Number(l.countedQty), l.selectedUom, itemDims)
      const expected    = Number(l.expectedQty)
      return prisma.countLine.update({
        where: { id: l.id },
        data: {
          priceAtCount: item.pricePerBaseUnit,
          variancePct:  expected > 0 ? ((countedBase - expected) / expected) * 100 : 0,
          varianceCost: (countedBase - expected) * Number(item.pricePerBaseUnit),
        },
      })
    }),

    // Add new lines with theoretical expected
    ...toAdd.map(item =>
      prisma.countLine.create({
        data: {
          sessionId:       params.id,
          inventoryItemId: item.id,
          expectedQty:     getExpected(item.id, Number(item.stockOnHand)),
          selectedUom:     resolveCountUom({
            baseUnit:           item.baseUnit,
            purchaseUnit:       item.purchaseUnit,
            qtyPerPurchaseUnit: Number(item.qtyPerPurchaseUnit),
            qtyUOM:             item.qtyUOM ?? 'each',
            innerQty:           item.innerQty != null ? Number(item.innerQty) : null,
            packSize:           Number(item.packSize),
            packUOM:            item.packUOM,
            countUOM:           item.countUOM ?? 'each',
          }) || item.baseUnit,
          priceAtCount:    item.pricePerBaseUnit,
          sortOrder:       nextSort++,
        },
      })
    ),
  ])

  // Re-fetch updated lines to return the full updated set
  const updatedLines = await prisma.countLine.findMany({
    where: { sessionId: params.id },
    include: { inventoryItem: { include: { storageArea: true } } },
    orderBy: { sortOrder: 'asc' },
  })

  // Enrich with per-RC parLevel
  const parMap3 = new Map<string, number>()
  if (session.revenueCenterId) {
    const allocs = await prisma.stockAllocation.findMany({
      where: {
        revenueCenterId: session.revenueCenterId,
        inventoryItemId: { in: updatedLines.map(l => l.inventoryItemId) },
      },
      select: { inventoryItemId: true, parLevel: true },
    })
    for (const a of allocs) {
      if (a.parLevel != null) parMap3.set(a.inventoryItemId, Number(a.parLevel))
    }
  }
  const enriched = updatedLines.map(l => ({
    ...l,
    inventoryItem: { ...l.inventoryItem, parLevel: parMap3.get(l.inventoryItemId) ?? null },
  }))

  return NextResponse.json({
    added:   toAdd.length,
    removed: toRemove.length,
    updated: toUpdate.length + toReprice.length,
    lines:   enriched,
  })
}
