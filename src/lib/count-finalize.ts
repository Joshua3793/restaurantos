import { prisma } from '@/lib/prisma'
import { lineCountedBase } from '@/lib/count-uom'
import { LARGE_VARIANCE_PCT } from '@/lib/count-constants'
import { asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export interface FinalizeSummary {
  itemsUpdated:      number
  itemsSkipped:      number
  totalValue:        number
  largeVariances:    number
  totalVarianceCost: number
}

export type FinalizeResult =
  | { ok: true;  summary: FinalizeSummary }
  | { ok: false; error: string; status: number }

/**
 * Finalize a count session: for every line, lock the price, compute variance,
 * write an InventorySnapshot, and push the counted quantity back to stock
 * (global `stockOnHand` for the default/unscoped RC, `StockAllocation` for a
 * non-default RC). Flips the session to FINALIZED.
 *
 * Single source of truth shared by the full-session finalize route and the
 * single-item quick-count endpoint — keep all finalize behaviour here so the
 * two paths can never diverge.
 */
export async function finalizeCountSession(sessionId: string): Promise<FinalizeResult> {
  const session = await prisma.countSession.findUnique({
    where: { id: sessionId },
    include: {
      lines: { include: { inventoryItem: true } },
      revenueCenter: { select: { isDefault: true } },
    },
  })
  if (!session) return { ok: false, error: 'Not found', status: 404 }
  // UPDATING is the transitional state set by the client before firing this request
  if (session.status === 'FINALIZED') return { ok: false, error: 'Already finalized', status: 400 }

  // Counts scoped to a non-default RC must NOT touch global stockOnHand —
  // they only update the StockAllocation for that RC. Otherwise an RC-scoped
  // count would clobber the main (default RC) pool.
  const isRcScopedCount = !!session.revenueCenterId && !session.revenueCenter?.isDefault

  const now = new Date()
  let totalCountedValue = 0
  let itemsUpdated = 0
  let itemsSkipped = 0
  let totalVarianceCost = 0

  const stockUpdates: ReturnType<typeof prisma.inventoryItem.update>[] = []
  const lineUpdates:  ReturnType<typeof prisma.countLine.update>[] = []
  const snapshotData: {
    sessionId: string; inventoryItemId: string; snapshotDate: Date
    qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number; category: string
  }[] = []

  for (const line of session.lines) {
    const item = line.inventoryItem
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

    // Always use the current price from the inventory item — ensures that any
    // invoice approvals that happened after the count was created are reflected
    // in the snapshot value and the session's totalCountedValue.
    const price = pricePerBaseUnit(asChainItem(item))

    if (line.skipped || line.countedQty !== null) {
      // rawQty is in line.selectedUom; convert to baseUnit for stockOnHand
      const rawQty  = Number(line.skipped ? line.expectedQty : line.countedQty)
      // skipped lines use expectedQty which is already in baseUnit
      const qtyBase = line.skipped
        ? rawQty
        : lineCountedBase(line, itemDims)
      const value   = qtyBase * price
      totalCountedValue += value

      snapshotData.push({
        sessionId: session.id, inventoryItemId: item.id,
        snapshotDate: now, qtyOnHand: qtyBase, unit: item.baseUnit,
        pricePerBaseUnit: price, totalValue: value, category: item.category,
      })

      // Lock the snapshot: priceAtCount = the live price at finalize, and
      // recompute variance from it so the locked record matches what review
      // showed live (review uses live price for in-progress sessions).
      const expected    = Number(line.expectedQty)
      const lineVarCost = line.skipped ? 0 : (qtyBase - expected) * price
      lineUpdates.push(
        prisma.countLine.update({
          where: { id: line.id },
          data: line.skipped
            ? { priceAtCount: price }
            : {
                priceAtCount: price,
                variancePct:  expected > 0 ? ((qtyBase - expected) / expected) * 100 : 0,
                varianceCost: lineVarCost,
              },
        })
      )

      if (line.skipped) {
        itemsSkipped++
      } else {
        itemsUpdated++
        totalVarianceCost += Math.abs(lineVarCost)
        // For RC-scoped counts only update lastCountDate/lastCountQty (stock lives in StockAllocation).
        // For default-RC and unscoped counts also update the global stockOnHand.
        stockUpdates.push(
          prisma.inventoryItem.update({
            where: { id: item.id },
            data: isRcScopedCount
              ? { lastCountDate: now, lastCountQty: qtyBase }
              : { stockOnHand: qtyBase, lastCountDate: now, lastCountQty: qtyBase },
          })
        )
      }
    } else {
      // Uncounted — snapshot with expected qty (already in baseUnit)
      const qty = Number(line.expectedQty)
      totalCountedValue += qty * price
      snapshotData.push({
        sessionId: session.id, inventoryItemId: item.id,
        snapshotDate: now, qtyOnHand: qty, unit: item.baseUnit,
        pricePerBaseUnit: price, totalValue: qty * price, category: item.category,
      })
    }
  }

  await prisma.$transaction([
    ...stockUpdates,
    ...lineUpdates,
    prisma.inventorySnapshot.createMany({ data: snapshotData }),
    prisma.countSession.update({
      where: { id: session.id },
      data: { status: 'FINALIZED', finalizedAt: now, totalCountedValue },
    }),
  ])

  // Update StockAllocation for this RC if one is set.
  // The default RC's stock lives in inventoryItem.stockOnHand (written above) —
  // it must NOT also get a StockAllocation row, or the "All RCs" view double-counts it.
  if (session.revenueCenterId && !session.revenueCenter?.isDefault) {
    const allocationUpdates = session.lines
      .filter(line => !line.skipped && line.countedQty !== null)
      .map(line => {
        const item = line.inventoryItem
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
        const qtyBase = lineCountedBase(line, itemDims)
        return prisma.stockAllocation.upsert({
          where: {
            revenueCenterId_inventoryItemId: {
              revenueCenterId: session.revenueCenterId!,
              inventoryItemId: line.inventoryItemId,
            },
          },
          update: { quantity: qtyBase },
          create: {
            revenueCenterId: session.revenueCenterId!,
            inventoryItemId: line.inventoryItemId,
            quantity: qtyBase,
          },
        })
      })
    await Promise.all(allocationUpdates)
  }

  const largeVariances = session.lines.filter(
    l => l.variancePct !== null && Math.abs(Number(l.variancePct)) > LARGE_VARIANCE_PCT
  )

  return {
    ok: true,
    summary: {
      itemsUpdated,
      itemsSkipped,
      totalValue: totalCountedValue,
      largeVariances: largeVariances.length,
      totalVarianceCost,
    },
  }
}
