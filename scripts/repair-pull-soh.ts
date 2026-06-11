// Repair stockOnHand under-decrements caused by the unit-mismatch bug in
// POST /api/stock-allocations. Before the fix, a pull of N countUOM units
// (e.g. 2.28 kg) decremented stockOnHand by N *baseUnits* (2.28 g) instead of
// the converted amount (2280 g). Every pull on a countUOM≠baseUnit item thus
// left stockOnHand too high by (qtyBase − qty).
//
// This corrects each item by the total under-decrement across its stockTransfer
// log. stockOnHand is clamped at 0 (never negative). Pulls where countUOM ==
// baseUnit were unaffected and net to a 0 correction.
//
// Dry by default. Run:
//   ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/repair-pull-soh.ts
//   APPLY=1 ts-node ... scripts/repair-pull-soh.ts   # to write
import { prisma } from '../src/lib/prisma'
import { convertCountQtyToBase } from '../src/lib/count-uom'

const APPLY = process.env.APPLY === '1'

async function main() {
  const transfers = await prisma.stockTransfer.findMany({
    include: {
      inventoryItem: {
        select: {
          id: true, itemName: true, baseUnit: true, countUOM: true, stockOnHand: true,
          purchaseUnit: true, qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true,
          packSize: true, packUOM: true,
        },
      },
    },
  })

  // Sum the under-decrement per item.
  const corrByItem = new Map<string, { name: string; soh: number; correction: number }>()
  for (const t of transfers) {
    const it = t.inventoryItem
    const countUOM = it.countUOM || it.baseUnit
    if (countUOM === it.baseUnit) continue // no conversion → was correct
    const dims = {
      baseUnit:           it.baseUnit,
      purchaseUnit:       it.purchaseUnit,
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit),
      qtyUOM:             it.qtyUOM ?? 'each',
      innerQty:           it.innerQty != null ? Number(it.innerQty) : null,
      packSize:           Number(it.packSize ?? 1),
      packUOM:            it.packUOM ?? 'each',
      countUOM,
    }
    const qty     = Number(t.quantity)
    const qtyBase = convertCountQtyToBase(qty, countUOM, dims)
    const under   = qtyBase - qty // grams that should have been removed but weren't
    const entry = corrByItem.get(it.id) ?? { name: it.itemName, soh: Number(it.stockOnHand), correction: 0 }
    entry.correction += under
    corrByItem.set(it.id, entry)
  }

  console.log(`Items needing stockOnHand correction: ${corrByItem.size}`)
  const writes: Array<{ id: string; newSoh: number }> = []
  for (const [id, e] of corrByItem) {
    const newSoh = Math.max(0, e.soh - e.correction)
    writes.push({ id, newSoh })
    const clamped = e.soh - e.correction < 0 ? '  (clamped at 0)' : ''
    console.log(`  ${e.name}: soh ${e.soh} − ${e.correction.toFixed(2)} = ${newSoh.toFixed(2)} (base units)${clamped}`)
  }

  if (!APPLY) { console.log('\nDry run. APPLY=1 to write.'); return }
  for (const w of writes) {
    await prisma.inventoryItem.update({ where: { id: w.id }, data: { stockOnHand: w.newSoh } })
  }
  console.log(`\nApplied ${writes.length} stockOnHand corrections.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
