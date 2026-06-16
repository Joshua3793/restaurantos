/**
 * One-time repair for the approve-route totalQty bug: recompute pricePerBaseUnit from
 * the pack structure for CASE-priced items whose stored ppb diverged (the totalQty path
 * wrote perCasePrice / totalQty). Skips PREP-output items (recipe-derived ppb) and
 * propagates corrected prices to dependent PREP recipes. Idempotent.
 */
import { prisma } from '../src/lib/prisma'
import { calcPricePerBaseUnit } from '../src/lib/utils'
import { propagatePrepCostChanges } from '../src/lib/recipeCosts'

async function main() {
  const prep = await prisma.recipe.findMany({ where: { type: 'PREP', inventoryItemId: { not: null } }, select: { inventoryItemId: true } })
  const prepOutputIds = new Set(prep.map(r => r.inventoryItemId!))

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: { id: true, itemName: true, pricePerBaseUnit: true, purchasePrice: true,
      qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true, packSize: true, packUOM: true, priceType: true },
  })

  const changed: string[] = []
  for (const it of items) {
    if ((it.priceType ?? 'CASE') !== 'CASE') continue
    if (prepOutputIds.has(it.id)) continue
    const correct = calcPricePerBaseUnit(Number(it.purchasePrice), Number(it.qtyPerPurchaseUnit),
      it.qtyUOM ?? 'each', it.innerQty != null ? Number(it.innerQty) : null,
      Number(it.packSize), it.packUOM, 'CASE')
    const stored = Number(it.pricePerBaseUnit)
    if (correct > 0 && Math.abs(stored - correct) / correct > 0.02) {
      await prisma.inventoryItem.update({ where: { id: it.id }, data: { pricePerBaseUnit: correct } })
      changed.push(it.id)
      console.log(`  fixed ${it.itemName}: ${stored.toPrecision(5)} → ${correct.toPrecision(5)} /${it.packUOM === 'g' ? 'g' : it.packUOM}`)
    }
  }
  console.log(`Repaired ${changed.length} CASE item(s).`)

  if (changed.length > 0) {
    const moved = await propagatePrepCostChanges(changed)
    console.log(`Propagated to ${moved.length} dependent PREP item(s).`)
  }
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
