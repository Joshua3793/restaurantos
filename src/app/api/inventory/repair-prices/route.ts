import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit } from '@/lib/utils'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'

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
      qtyUOM: true,
      innerQty: true,
      pricePerBaseUnit: true,
      priceType: true,
    },
  })

  // Prep-output items carry recipe-DERIVED prices (written by syncPrepToInventory:
  // pricePerBaseUnit = totalCost / baseYieldQty), NOT purchase-formula prices.
  // Recomputing them here with calcPricePerBaseUnit would clobber the recipe cost
  // (and is off by the yieldUnit conversion factor). Skip them; they're refreshed
  // via propagation below from their changed ingredients.
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { inventoryItemId: true },
  })
  const prepOutputIds = new Set(prepRecipes.map(r => r.inventoryItemId!))

  let fixed = 0
  let skipped = 0
  const changedIds: string[] = []
  const changes: Array<{ id: string; name: string; old: number; new: number }> = []

  for (const item of items) {
    if (prepOutputIds.has(item.id)) { skipped++; continue }
    const correct = calcPricePerBaseUnit(
      Number(item.purchasePrice),
      Number(item.qtyPerPurchaseUnit),
      item.qtyUOM ?? 'each',
      item.innerQty != null ? Number(item.innerQty) : null,
      Number(item.packSize),
      item.packUOM,
      (item.priceType ?? 'CASE') as 'CASE' | 'UOM',
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
      changedIds.push(item.id)
      fixed++
    } else {
      skipped++
    }
  }

  // Re-derive every PREP recipe whose cost depends on a repaired item (directly
  // or transitively) so the recipe spine stays consistent with the fixed prices.
  const prepResynced = await propagatePrepCostChanges(changedIds)

  return NextResponse.json({
    total: items.length,
    fixed,
    skipped,
    prepResynced: prepResynced.length,
    changes,
  })
}
