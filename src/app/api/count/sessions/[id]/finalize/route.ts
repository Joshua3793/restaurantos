import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// POST /api/count/sessions/:id/finalize
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await prisma.countSession.findUnique({
    where: { id: params.id },
    include: { lines: { include: { inventoryItem: true } } },
  })
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
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

    if (line.skipped || line.countedQty !== null) {
      const qty   = Number(line.skipped ? line.expectedQty : line.countedQty)
      const price = Number(line.priceAtCount)
      const value = qty * price
      totalCountedValue += value

      snapshotData.push({
        sessionId: session.id, inventoryItemId: item.id,
        snapshotDate: now, qtyOnHand: qty, unit: line.selectedUom,
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
            data: { stockOnHand: qty, lastCountDate: now, lastCountQty: qty },
          })
        )
      }
    } else {
      // Uncounted — snapshot with expected qty but don't update stock
      const qty   = Number(line.expectedQty)
      const price = Number(line.priceAtCount)
      totalCountedValue += qty * price
      snapshotData.push({
        sessionId: session.id, inventoryItemId: item.id,
        snapshotDate: now, qtyOnHand: qty, unit: line.selectedUom,
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
