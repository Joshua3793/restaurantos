import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertCountQtyToBase } from '@/lib/count-uom'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: { lines: { include: { inventoryItem: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // UPDATING is the transitional state set by the client before firing this request
  if (session.status === 'FINALIZED') return NextResponse.json({ error: 'Already finalized' }, { status: 400 })

  const now = new Date()
  let totalCountedValue = 0
  let itemsUpdated = 0
  let itemsSkipped = 0
  let totalVarianceCost = 0

  const stockUpdates: ReturnType<typeof prisma.inventoryItem.update>[] = []
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
      packSize:           Number(item.packSize),
      packUOM:            item.packUOM,
    }

    if (line.skipped || line.countedQty !== null) {
      // rawQty is in line.selectedUom; convert to baseUnit for stockOnHand
      const rawQty  = Number(line.skipped ? line.expectedQty : line.countedQty)
      // skipped lines use expectedQty which is already in baseUnit
      const qtyBase = line.skipped
        ? rawQty
        : convertCountQtyToBase(rawQty, line.selectedUom, itemDims)
      const price   = Number(line.priceAtCount)
      const value   = qtyBase * price
      totalCountedValue += value

      snapshotData.push({
        sessionId: session.id, inventoryItemId: item.id,
        snapshotDate: now, qtyOnHand: qtyBase, unit: item.baseUnit,
        pricePerBaseUnit: price, totalValue: value, category: item.category,
      })

      if (line.skipped) {
        itemsSkipped++
      } else {
        itemsUpdated++
        totalVarianceCost += Math.abs(Number(line.varianceCost ?? 0))
        stockUpdates.push(
          prisma.inventoryItem.update({
            where: { id: item.id },
            data: { stockOnHand: qtyBase, lastCountDate: now, lastCountQty: qtyBase },
          })
        )
      }
    } else {
      // Uncounted — snapshot with expected qty (already in baseUnit)
      const qty   = Number(line.expectedQty)
      const price = Number(line.priceAtCount)
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
    prisma.inventorySnapshot.createMany({ data: snapshotData }),
    prisma.countSession.update({
      where: { id: params.id },
      data: { status: 'FINALIZED', finalizedAt: now, totalCountedValue },
    }),
  ])

  // Update StockAllocation for this RC if one is set
  if (session.revenueCenterId) {
    const allocationUpdates = session.lines
      .filter(line => !line.skipped && line.countedQty !== null)
      .map(line =>
        prisma.stockAllocation.upsert({
          where: {
            revenueCenterId_inventoryItemId: {
              revenueCenterId: session.revenueCenterId!,
              inventoryItemId: line.inventoryItemId,
            },
          },
          update: { quantity: Number(line.countedQty) },
          create: {
            revenueCenterId: session.revenueCenterId!,
            inventoryItemId: line.inventoryItemId,
            quantity: Number(line.countedQty),
          },
        })
      )
    await Promise.all(allocationUpdates)
  }

  const largeVariances = session.lines.filter(
    l => l.variancePct !== null && Math.abs(Number(l.variancePct)) > 15
  )

  return NextResponse.json({
    ok: true,
    summary: {
      itemsUpdated,
      itemsSkipped,
      totalValue: totalCountedValue,
      largeVariances: largeVariances.length,
      totalVarianceCost,
    },
  })
}
