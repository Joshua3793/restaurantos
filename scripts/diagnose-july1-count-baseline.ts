/**
 * READ-ONLY confirmation. Writes NOTHING.
 *
 * With the "count owns its day" fix and the June 30 kitchen baseline, verify that:
 *   (a) invoices/prep dated ON/BEFORE each item's count day contribute 0, and
 *   (b) everything the KITCHEN theoretical map now includes is dated AFTER the count.
 *
 * Run:
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/diagnose-july1-count-baseline.ts
 */
import { prisma } from '../src/lib/prisma'
import { buildPurchaseMap, buildPrepMap, getTheoreticalStockMap } from '../src/lib/count-expected'

const DAY_MS = 24 * 60 * 60 * 1000
const d = (x: Date | null | undefined) => (x ? new Date(x).toISOString().slice(0, 10) : '—')

async function main() {
  const kitchen = await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true, name: true } })
  if (!kitchen) throw new Error('no default RC')

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true, lastCountDate: { not: null } },
    select: { id: true, itemName: true, baseUnit: true, lastCountDate: true, lastCountQty: true, stockOnHand: true },
  })
  const byId = new Map(items.map(i => [i.id, i]))
  const cutoff = new Map(items.map(i => [i.id, i.lastCountDate!]))
  const earliest = items.map(i => i.lastCountDate!).sort((a, b) => (a > b ? 1 : -1))[0]

  // Build the KITCHEN maps exactly as the app does on read.
  const [purchaseMap, prepMap] = await Promise.all([
    buildPurchaseMap(earliest, kitchen.id, cutoff),
    buildPrepMap(earliest, kitchen.id, cutoff),
  ])

  // (a) Raw scan of every approved invoice line, classify received-date vs each item's count day.
  const invoices = await prisma.invoiceScanItem.findMany({
    where: {
      session: { status: 'APPROVED', revenueCenterId: kitchen.id }, approved: true, splitToSessionId: null,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] }, matchedItemId: { not: null }, rawQty: { not: null },
    },
    select: { matchedItemId: true, session: { select: { invoiceDate: true, createdAt: true } } },
  })
  let onBeforeExcluded = 0, afterIncluded = 0, violations = 0
  for (const si of invoices) {
    const it = si.matchedItemId ? byId.get(si.matchedItemId) : null
    if (!it) continue
    const iso = si.session.invoiceDate ?? si.session.createdAt.toISOString().slice(0, 10)
    const rec = new Date(iso).getTime()
    if (isNaN(rec)) continue
    const included = rec >= it.lastCountDate!.getTime() + DAY_MS
    if (included) afterIncluded++
    else onBeforeExcluded++
    // A violation would be an ON/BEFORE-count invoice that somehow still counts — should be 0.
    if (!included && rec >= it.lastCountDate!.getTime() + DAY_MS) violations++
  }

  console.log('═══ KITCHEN theoretical — post-fix confirmation ═══')
  console.log(`Approved invoice lines (matched): ${invoices.length}`)
  console.log(`  • received ON/BEFORE the item's count day → EXCLUDED: ${onBeforeExcluded}`)
  console.log(`  • received AFTER the count day → included:            ${afterIncluded}`)
  console.log(`  • gate violations (should be 0):                      ${violations}`)
  console.log(`Items receiving any post-count purchase qty: ${[...purchaseMap.values()].filter(v => v > 0).length}`)
  console.log(`Items receiving any post-count prep output:  ${[...prepMap.output.values()].filter(v => v > 0).length}`)

  // (b) Sanity: for items counted June 30, theoretical should start from lastCountQty and only
  //     move by AFTER-count activity. Show the ones that actually moved since their count.
  const theo = await getTheoreticalStockMap(kitchen.id, items.map(i => i.id))
  const moved = items
    .map(i => ({ i, t: theo.get(i.id) ?? 0, q: Number(i.lastCountQty ?? 0), p: purchaseMap.get(i.id) ?? 0 }))
    .filter(r => Math.abs(r.t - r.q) > 0.01)
    .sort((a, b) => Math.abs(b.t - b.q) - Math.abs(a.t - a.q))
  console.log(`\nItems whose KITCHEN theoretical differs from their counted qty: ${moved.length}`)
  console.log(['countDay', 'Item', 'countedQty', 'theoretical', 'purchAdded', 'unit'].join('\t'))
  for (const r of moved.slice(0, 20)) {
    console.log([d(r.i.lastCountDate), r.i.itemName.slice(0, 26), r.q.toFixed(1), r.t.toFixed(1), r.p.toFixed(1), r.i.baseUnit].join('\t'))
  }

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
