/**
 * READ-ONLY accounting audit.
 *
 * Reconciles theoretical on-hand against the identity:
 *     theoretical  ==  lastCount + purchases + prepOut - consumption - wastage - prepCons   (floored at 0)
 *
 * For each revenue center it builds a per-item ledger using the APP'S OWN
 * functions from count-expected.ts (no reimplementation), then flags items
 * whose theoretical diverges from (lastCount + purchases) — which, with no
 * sales/wastage entered, is what the user expects them to be equal to.
 *
 * Run:
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-theoretical-vs-count.ts
 *
 * Writes NOTHING.
 */
import { prisma } from '../src/lib/prisma'
import {
  buildConsumptionMap,
  buildPurchaseMap,
  buildWastageMap,
  buildPrepMap,
} from '../src/lib/count-expected'

function f(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString('en-US')
}

async function main() {
  const rcs = await prisma.revenueCenter.findMany({
    select: { id: true, name: true, isDefault: true, isActive: true },
    orderBy: { isDefault: 'desc' },
  })

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true },
    select: {
      id: true,
      itemName: true,
      baseUnit: true,
      stockOnHand: true,
      lastCountDate: true,
      lastCountQty: true,
    },
  })
  const itemById = new Map(items.map(i => [i.id, i]))
  const ids = items.map(i => i.id)

  // ── Global facts ────────────────────────────────────────────────
  const counted = items.filter(i => i.lastCountDate)
  const neverCounted = items.filter(i => !i.lastCountDate)
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('GLOBAL FACTS')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log(`Active stocked items: ${items.length}`)
  console.log(`  • with a lastCountDate (counted): ${counted.length}`)
  console.log(`  • NEVER counted (lastCountDate = null): ${neverCounted.length}`)
  console.log(`Revenue centers: ${rcs.map(r => `${r.name}${r.isDefault ? ' [default]' : ''}`).join(', ')}`)

  // How many approved purchase lines exist at all, and how many predate / lack a count?
  const approvedScan = await prisma.invoiceScanItem.findMany({
    where: {
      session: { status: 'APPROVED' },
      approved: true,
      splitToSessionId: null,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
      matchedItemId: { not: null },
      rawQty: { not: null },
    },
    select: {
      matchedItemId: true,
      revenueCenterId: true,
      session: { select: { createdAt: true, revenueCenterId: true } },
    },
  })
  console.log(`\nApproved purchase lines (matched, counted-once): ${approvedScan.length}`)

  // Purchase lines whose item was never counted → those purchases are INVISIBLE to theoretical.
  let purchasesForNeverCounted = 0
  let purchasesBeforeCount = 0
  for (const si of approvedScan) {
    const it = si.matchedItemId ? itemById.get(si.matchedItemId) : undefined
    if (!it) continue
    if (!it.lastCountDate) purchasesForNeverCounted++
    else if (si.session.createdAt < it.lastCountDate) purchasesBeforeCount++
  }
  console.log(`  • on items that were NEVER counted (ignored by theoretical): ${purchasesForNeverCounted}`)
  console.log(`  • dated BEFORE the item's own count (correctly excluded): ${purchasesBeforeCount}`)

  // ── Per-RC ledger ───────────────────────────────────────────────
  type Row = {
    rc: string
    item: string
    unit: string
    baseStock: number
    purchases: number
    prepOut: number
    consumption: number
    wastage: number
    prepCons: number
    rawIdentity: number   // before floor
    theoretical: number   // after floor
    countPlusPurch: number
    diff: number          // theoretical - (count + purchases)
    floored: boolean
  }
  const allRows: Row[] = []

  const earliest = counted
    .map(i => i.lastCountDate!)
    .sort((a, b) => (a > b ? 1 : -1))[0]
  // Mirror getTheoreticalStockMap: epoch window whenever any item is uncounted.
  const hasUncounted = neverCounted.length > 0

  for (const rc of rcs) {
    const cutoff = new Map<string, Date>()
    for (const i of counted) cutoff.set(i.id, i.lastCountDate!)

    const since = hasUncounted ? new Date(0) : (earliest ?? new Date(0))
    const [consumptionMap, purchaseMap, wastageMap, prepMap] = await Promise.all([
      buildConsumptionMap(since, rc.id, cutoff),
      buildPurchaseMap(since, rc.id, cutoff),
      buildWastageMap(since, ids, rc.id, cutoff),
      buildPrepMap(since, rc.id, cutoff),
    ])

    const allocs = rc.isDefault
      ? new Map<string, number>()
      : new Map(
          (
            await prisma.stockAllocation.findMany({
              where: { revenueCenterId: rc.id, inventoryItemId: { in: ids } },
              select: { inventoryItemId: true, quantity: true },
            })
          ).map(a => [a.inventoryItemId, Number(a.quantity)]),
        )

    for (const item of items) {
      const baseStock = rc.isDefault
        ? Number(item.stockOnHand)
        : allocs.has(item.id)
          ? allocs.get(item.id)!
          : 0
      const purchases = purchaseMap.get(item.id) ?? 0
      const prepOut = prepMap.output.get(item.id) ?? 0
      const consumption = consumptionMap.get(item.id) ?? 0
      const wastage = wastageMap.get(item.id) ?? 0
      const prepCons = prepMap.consumption.get(item.id) ?? 0
      const rawIdentity = baseStock + purchases + prepOut - consumption - wastage - prepCons
      const theoretical = Math.max(0, rawIdentity)
      const countPlusPurch = baseStock + purchases
      // Skip rows that are entirely empty (no stock, no movement) to keep output focused.
      if (baseStock === 0 && purchases === 0 && prepOut === 0 && consumption === 0 && wastage === 0 && prepCons === 0)
        continue
      allRows.push({
        rc: rc.name,
        item: item.itemName,
        unit: item.baseUnit,
        baseStock,
        purchases,
        prepOut,
        consumption,
        wastage,
        prepCons,
        rawIdentity,
        theoretical,
        countPlusPurch,
        diff: theoretical - countPlusPurch,
        floored: rawIdentity < 0,
      })
    }
  }

  // ── Discrepancy summary ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('DISCREPANCY: theoretical  vs  (lastCount + purchases)')
  console.log('  (with no sales/wastage, these SHOULD be equal unless prep moved stock)')
  console.log('═══════════════════════════════════════════════════════════════')

  const EPS = 0.01
  const flagged = allRows.filter(r => Math.abs(r.diff) > EPS)
  const floored = allRows.filter(r => r.floored)
  const prepMoved = flagged.filter(r => Math.abs(r.prepOut - r.prepCons) > EPS && r.consumption < EPS && r.wastage < EPS)
  const salesOrWaste = flagged.filter(r => r.consumption > EPS || r.wastage > EPS)

  console.log(`\nRows with stock/movement: ${allRows.length}`)
  console.log(`Rows where theoretical != count + purchases: ${flagged.length}`)
  console.log(`  • explained by prep moving stock (prepOut/prepCons): ${prepMoved.length}`)
  console.log(`  • involve consumption/wastage (sales or waste DID get entered?): ${salesOrWaste.length}`)
  console.log(`  • theoretical was FLOORED at 0 (negative raw → masked deficit): ${floored.length}`)

  const sortFn = (a: Row, b: Row) => Math.abs(b.diff) - Math.abs(a.diff)

  function table(title: string, rows: Row[], n = 40) {
    if (rows.length === 0) return
    console.log(`\n── ${title} (top ${Math.min(n, rows.length)}) ──`)
    console.log(
      ['RC', 'Item', 'count', 'purch', 'prepOut', 'consum', 'waste', 'prepCons', 'theo', 'count+purch', 'diff', 'unit']
        .join('\t'),
    )
    for (const r of rows.slice(0, n)) {
      console.log(
        [
          r.rc.slice(0, 10),
          r.item.slice(0, 26),
          f(r.baseStock),
          f(r.purchases),
          f(r.prepOut),
          f(r.consumption),
          f(r.wastage),
          f(r.prepCons),
          f(r.theoretical),
          f(r.countPlusPurch),
          f(r.diff),
          r.unit,
        ].join('\t'),
      )
    }
  }

  table('FLOORED (negative raw theoretical masked to 0)', floored.sort(sortFn))
  table('CONSUMPTION/WASTAGE present', salesOrWaste.sort(sortFn))
  table('Largest |diff| overall', [...flagged].sort(sortFn))

  // ── Purchases invisible because item never counted ──────────────
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('NEVER-COUNTED items that carry purchases (post-fix: now credited)')
  console.log('  (baseline = stockOnHand + these receipts are added from epoch)')
  console.log('═══════════════════════════════════════════════════════════════')
  const purchByItem = new Map<string, number>()
  for (const si of approvedScan) {
    if (!si.matchedItemId) continue
    const it = itemById.get(si.matchedItemId)
    if (!it || it.lastCountDate) continue
    purchByItem.set(si.matchedItemId, (purchByItem.get(si.matchedItemId) ?? 0) + 1)
  }
  if (purchByItem.size === 0) {
    console.log('None. Every item with purchases has been counted.')
  } else {
    console.log(['Item', 'stockOnHand', 'baseUnit', '#purchaseLines'].join('\t'))
    for (const [id, cnt] of [...purchByItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50)) {
      const it = itemById.get(id)!
      console.log([it.itemName.slice(0, 30), f(Number(it.stockOnHand)), it.baseUnit, cnt].join('\t'))
    }
  }

  // ── Double-count sanity: the 10 never-counted items WITH an opening balance ──
  console.log('\n═══════════════════════════════════════════════════════════════')
  console.log('SANITY: never-counted items WITH a non-zero opening balance')
  console.log('  new theoretical = openingBalance + purchases (+prep). Verify the')
  console.log('  purchases are genuinely NEW receipts, not already in the opening qty.')
  console.log('═══════════════════════════════════════════════════════════════')
  const openingItems = new Set(
    items.filter(i => !i.lastCountDate && Number(i.stockOnHand) !== 0).map(i => i.id),
  )
  const openingRows = allRows.filter(r => {
    const it = items.find(i => i.itemName === r.item)
    return it && openingItems.has(it.id)
  })
  if (openingRows.length === 0) {
    console.log('No movement rows for these items.')
  } else {
    console.log(['RC', 'Item', 'opening', 'purchases', 'prepCons', 'theoretical', 'unit'].join('\t'))
    for (const r of openingRows.sort((a, b) => b.baseStock - a.baseStock)) {
      console.log(
        [r.rc.slice(0, 10), r.item.slice(0, 26), f(r.baseStock), f(r.purchases), f(r.prepCons), f(r.theoretical), r.unit].join('\t'),
      )
    }
  }

  await prisma.$disconnect()
}

main().catch(async e => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
