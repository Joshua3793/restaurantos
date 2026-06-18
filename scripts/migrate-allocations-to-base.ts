// ONE-TIME migration: StockAllocation.quantity and StockTransfer.quantity were
// written in countUOM by the buggy pull (POST /api/stock-allocations) before the
// fix. The canonical unit for all stock is baseUnit (matches stockOnHand and
// count-finalize, which already writes base). This converts every existing
// allocation/transfer quantity from countUOM → baseUnit.
//
// NOT idempotent — run exactly once, before/with the deploy of the unit fix.
// After the fix, new allocations/transfers are already written in baseUnit.
// Rows where countUOM === baseUnit need no conversion (factor 1) and are no-ops.
//
// Dry by default. Run:
//   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/migrate-allocations-to-base.ts
//   APPLY=1 ts-node ... scripts/migrate-allocations-to-base.ts
import { prisma } from '../src/lib/prisma'
import { convertCountQtyToBase } from '../src/lib/count-uom'

const APPLY = process.env.APPLY === '1'

function dimsOf(it: { baseUnit: string; countUOM: string | null; purchaseUnit: string; qtyPerPurchaseUnit: unknown; qtyUOM: string | null; innerQty: unknown; packSize: unknown; packUOM: string | null }) {
  const countUOM = it.countUOM || it.baseUnit
  return {
    countUOM,
    dims: {
      baseUnit:           it.baseUnit,
      purchaseUnit:       it.purchaseUnit,
      qtyPerPurchaseUnit: Number(it.qtyPerPurchaseUnit),
      qtyUOM:             it.qtyUOM ?? 'each',
      innerQty:           it.innerQty != null ? Number(it.innerQty) : null,
      packSize:           Number(it.packSize ?? 1),
      packUOM:            it.packUOM ?? 'each',
      countUOM,
    },
  }
}

const ITEM_SELECT = {
  id: true, itemName: true, baseUnit: true, countUOM: true, purchaseUnit: true,
  qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true, packSize: true, packUOM: true,
} as const

async function main() {
  const allocs = await prisma.stockAllocation.findMany({ include: { inventoryItem: { select: ITEM_SELECT } } })
  const transfers = await prisma.stockTransfer.findMany({ include: { inventoryItem: { select: ITEM_SELECT } } })

  const allocWrites: Array<{ id: string; q: number }> = []
  console.log(`Allocations: ${allocs.length}`)
  for (const a of allocs) {
    const { countUOM, dims } = dimsOf(a.inventoryItem)
    const old = Number(a.quantity)
    const neu = convertCountQtyToBase(old, countUOM, dims)
    if (neu !== old) { allocWrites.push({ id: a.id, q: neu }); console.log(`  ${a.inventoryItem.itemName}: ${old} ${countUOM} → ${neu} ${a.inventoryItem.baseUnit}`) }
  }

  const transferWrites: Array<{ id: string; q: number }> = []
  console.log(`Transfers: ${transfers.length}`)
  for (const t of transfers) {
    const { countUOM, dims } = dimsOf(t.inventoryItem)
    const old = Number(t.quantity)
    const neu = convertCountQtyToBase(old, countUOM, dims)
    if (neu !== old) { transferWrites.push({ id: t.id, q: neu }); console.log(`  ${t.inventoryItem.itemName}: ${old} ${countUOM} → ${neu} ${t.inventoryItem.baseUnit}`) }
  }

  if (!APPLY) { console.log('\nDry run. APPLY=1 to write.'); return }
  for (const w of allocWrites)    await prisma.stockAllocation.update({ where: { id: w.id }, data: { quantity: w.q } })
  for (const w of transferWrites) await prisma.stockTransfer.update({ where: { id: w.id }, data: { quantity: w.q } })
  console.log(`\nApplied ${allocWrites.length} allocation + ${transferWrites.length} transfer conversions.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
