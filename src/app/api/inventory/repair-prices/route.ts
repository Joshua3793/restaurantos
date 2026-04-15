import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit } from '@/lib/utils'

/**
 * POST /api/inventory/repair-prices
 *
 * One-time repair: recalculates pricePerBaseUnit for every active inventory item
 * using the correct formula (purchasePrice / qty / packSize / getUnitConv(packUOM)).
 *
 * Run this once after deploying the approve-route fix to correct any prices that
 * were inflated by the missing unit-conversion factor (1000× for L/kg items).
 */
export async function POST() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      itemName: true,
      purchasePrice: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
      pricePerBaseUnit: true,
    },
  })

  let fixed = 0
  let skipped = 0
  const changes: Array<{ id: string; name: string; old: number; new: number }> = []

  for (const item of items) {
    const correct = calcPricePerBaseUnit(
      Number(item.purchasePrice),
      Number(item.qtyPerPurchaseUnit),
      Number(item.packSize),
      item.packUOM,
    )

    const current = Number(item.pricePerBaseUnit)

    // Only update if the difference is meaningful (> 0.01% relative error)
    const diff = Math.abs(correct - current)
    const relErr = current > 0 ? diff / current : diff

    if (relErr > 0.0001) {
      changes.push({ id: item.id, name: item.itemName, old: current, new: correct })
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { pricePerBaseUnit: correct },
      })
      fixed++
    } else {
      skipped++
    }
  }

  return NextResponse.json({
    total: items.length,
    fixed,
    skipped,
    changes,
  })
}
