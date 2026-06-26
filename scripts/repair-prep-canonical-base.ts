/**
 * Repair PREP InventoryItems whose baseUnit was written as the recipe's yieldUnit
 * verbatim (e.g. "lb", "kg", "l") instead of the canonical SI base (g / ml / each).
 *
 * The fixed syncPrepToInventory now writes a canonical base + a one-link "batch"
 * chain. This script re-syncs every PREP recipe through that path, and — for items
 * whose baseUnit actually CHANGES — converts the stored on-hand quantity
 * (InventoryItem.stockOnHand and InventorySnapshot rows, which are denominated in
 * the old base unit) into the new canonical base so valuation/theoretical stock
 * stay correct.
 *
 *   stockOnHand_new = stockOnHand_old * getUnitConv(oldBase)      (newBase conv == 1)
 *
 * Run dry (default) to preview; pass --apply to write.
 */
import { prisma } from '../src/lib/prisma'
import { getUnitConv } from '../src/lib/utils'
import { dimensionOf, DIMENSION_BASE } from '../src/lib/item-model'
import { syncPrepToInventory } from '../src/lib/recipeCosts'

const APPLY = process.argv.includes('--apply')

async function main() {
  const recs = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { id: true, name: true, yieldUnit: true, baseYieldQty: true, inventoryItemId: true },
  })

  let changed = 0
  for (const r of recs) {
    const itemId = r.inventoryItemId!
    const before = await prisma.inventoryItem.findUnique({
      where: { id: itemId },
      select: { baseUnit: true, stockOnHand: true, packChain: true },
    })
    if (!before) continue

    const oldBase = before.baseUnit
    const canonBase = DIMENSION_BASE[dimensionOf(r.yieldUnit)]
    const baseChanges = oldBase.toLowerCase() !== canonBase

    if (!baseChanges) continue
    changed++

    const factor = getUnitConv(oldBase) || 1
    const oldStock = Number(before.stockOnHand) || 0
    const newStock = oldStock * factor

    console.log(`\n${r.name}`)
    console.log(`  base: ${oldBase} -> ${canonBase}   (conv factor ${factor})`)
    console.log(`  chain: ${JSON.stringify(before.packChain)}`)
    console.log(`  stockOnHand: ${oldStock} ${oldBase} -> ${newStock} ${canonBase}`)

    const snaps = await prisma.inventorySnapshot.findMany({
      where: { inventoryItemId: itemId },
      select: { id: true, qtyOnHand: true, unit: true, totalValue: true },
    })
    for (const s of snaps) {
      const oq = Number(s.qtyOnHand) || 0
      const nq = oq * (getUnitConv(s.unit) || 1)
      const tv = Number(s.totalValue) || 0
      const nppb = nq > 0 ? tv / nq : 0
      console.log(`    snapshot ${s.id}: ${oq} ${s.unit} -> ${nq} ${canonBase}  (totalValue ${tv} preserved, ppb -> ${nppb})`)
    }

    if (APPLY) {
      await syncPrepToInventory(r.id)          // sets canonical base + batch chain + ppb
      await prisma.inventoryItem.update({       // convert stored on-hand into new base
        where: { id: itemId },
        data: { stockOnHand: newStock },
      })
      for (const s of snaps) {
        const oq = Number(s.qtyOnHand) || 0
        const nq = oq * (getUnitConv(s.unit) || 1)
        const tv = Number(s.totalValue) || 0
        await prisma.inventorySnapshot.update({
          where: { id: s.id },
          data: { qtyOnHand: nq, unit: canonBase, pricePerBaseUnit: nq > 0 ? tv / nq : 0 },
        })
      }
    }
  }

  console.log(`\n${changed} item(s) ${APPLY ? 'REPAIRED' : 'would be repaired (dry run — pass --apply to write)'}.`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
