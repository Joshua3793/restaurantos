/**
 * One-time script: recalculate pricePerBaseUnit, baseUnit, and conversionFactor
 * for every InventoryItem using the correct 6-argument formula.
 *
 * Run with: npx ts-node --compiler-options '{"module":"CommonJS"}' prisma/fix-prices.ts
 * Delete this file after running.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const UNIT_CONV: Record<string, number> = {
  g: 1, mg: 0.001, kg: 1000, lb: 453.592, oz: 28.3495,
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000,
  each: 1, ea: 1,
}

function getUnitConv(uom: string): number {
  return UNIT_CONV[uom?.toLowerCase()] ?? 1
}

function deriveBaseUnit(qtyUOM: string, packUOM: string): string {
  const weight = ['g', 'kg', 'lb', 'oz', 'mg']
  const volume = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  if (weight.includes(qtyUOM)) return 'g'
  if (volume.includes(qtyUOM)) return 'ml'
  if (weight.includes(packUOM)) return 'g'
  if (volume.includes(packUOM)) return 'ml'
  return 'each'
}

function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  const weight = ['g', 'kg', 'lb', 'oz', 'mg']
  const volume = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weight.includes(qtyUOM) || volume.includes(qtyUOM)

  let divisor: number
  if (isWeightQty) {
    divisor = qtyPerPurchaseUnit * getUnitConv(qtyUOM)
  } else if (qtyUOM === 'pack' && innerQty != null) {
    divisor = qtyPerPurchaseUnit * innerQty * packSize * getUnitConv(packUOM)
  } else {
    divisor = qtyPerPurchaseUnit * packSize * getUnitConv(packUOM)
  }
  return divisor > 0 ? purchasePrice / divisor : 0
}

function calcConversionFactor(
  countUOM: string,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  const weight = ['g', 'kg', 'lb', 'oz', 'mg']
  const volume = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weight.includes(qtyUOM) || volume.includes(qtyUOM)

  if (countUOM in UNIT_CONV) return UNIT_CONV[countUOM]

  const itemBaseUnits = packSize * getUnitConv(packUOM)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  if (countUOM === 'case' || countUOM === qtyUOM) {
    if (isWeightQty) return qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    return qtyPerPurchaseUnit * packBaseUnits
  }
  if (countUOM === 'pack') return packBaseUnits
  if (countUOM === 'each') return itemBaseUnits > 0 ? itemBaseUnits : 1
  return 1
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true,
      purchasePrice: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true,
      packSize: true, packUOM: true, countUOM: true,
      pricePerBaseUnit: true, baseUnit: true, conversionFactor: true,
    },
  })

  let updated = 0
  let skipped = 0

  for (const item of items) {
    const pp  = Number(item.purchasePrice)
    const qty = Number(item.qtyPerPurchaseUnit)
    const qu  = item.qtyUOM ?? 'each'
    const iq  = item.innerQty != null ? Number(item.innerQty) : null
    const ps  = Number(item.packSize ?? 1)
    const pu  = item.packUOM ?? 'each'
    const cu  = item.countUOM ?? 'each'

    const newPrice  = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu)
    const newBase   = deriveBaseUnit(qu, pu)
    const newConv   = calcConversionFactor(cu, qty, qu, iq, ps, pu)

    const oldPrice  = Number(item.pricePerBaseUnit)
    const priceOff  = oldPrice > 0 ? Math.abs(newPrice - oldPrice) / oldPrice : (newPrice > 0 ? 1 : 0)

    // Only update if price differs by more than 0.1% (floating-point tolerance)
    if (priceOff > 0.001 || item.baseUnit !== newBase) {
      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: { pricePerBaseUnit: newPrice, baseUnit: newBase, conversionFactor: newConv },
      })
      console.log(`  FIXED  ${item.itemName}: $${oldPrice.toFixed(6)} → $${newPrice.toFixed(6)} /${newBase}`)
      updated++
    } else {
      skipped++
    }
  }

  console.log(`\nDone. Fixed: ${updated} · Already correct: ${skipped}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
