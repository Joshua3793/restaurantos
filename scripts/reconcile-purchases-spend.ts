/**
 * Reconcile app "purchases $" (invoice SPEND) vs theoretical-stock purchase value.
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/reconcile-purchases-spend.ts
 *
 * App "$38K" = money paid (Σ invoice grand totals: line totals + tax/fees + every line).
 * Stock "$28K" = value of received stock that feeds theoretical (matched + isStocked +
 *               convertible), valued at current ppb.
 * This shows every bucket between them.
 */
import { prisma } from '../src/lib/prisma'
import { buildPurchaseMap } from '../src/lib/count-expected'
import { asChainItem, pricePerBaseUnit, PRICING_SELECT } from '../src/lib/item-model'

const v = (n: number) => '$' + n.toFixed(0).padStart(8)

async function main() {
  const sessions = await prisma.invoiceSession.findMany({
    where: { status: 'APPROVED', parentSessionId: null },
    select: {
      total: true,
      scanItems: {
        select: {
          action: true, rawLineTotal: true, matchedItemId: true, splitToSessionId: true,
          matchedItem: { select: { isStocked: true, recipe: { select: { type: true } } } },
        },
      },
    },
  })

  let grand = 0, lineSum = 0
  let matchedStocked = 0, matchedNonStocked = 0, unmatched = 0, skipPending = 0, prepMatched = 0
  for (const s of sessions) {
    grand += Number(s.total || 0)
    for (const li of s.scanItems) {
      const amt = Number(li.rawLineTotal || 0)
      lineSum += amt
      const act = li.action
      if (act === 'SKIP' || act === 'PENDING' || !li.matchedItemId) { skipPending += amt; continue }
      if (!li.matchedItem) { unmatched += amt; continue }
      if (li.matchedItem.recipe?.type === 'PREP') { prepMatched += amt; continue }
      if (li.matchedItem.isStocked === false) { matchedNonStocked += amt; continue }
      matchedStocked += amt
    }
  }
  const extra = grand - lineSum  // tax, fees, deposits, rounding

  console.log(`=== APP "purchases" = invoice SPEND (money paid), all approved parent invoices ===`)
  console.log(`  grand total (Σ invoice totals)      : ${v(grand)}   <= the app's number`)
  console.log(`  Σ line totals (rawLineTotal)        : ${v(lineSum)}`)
  console.log(`  invoice extra (tax/fees/deposits)   : ${v(extra)}`)
  console.log(`\n=== Line totals, by where they land ===`)
  console.log(`  matched + STOCKED (feeds theoretical): ${v(matchedStocked)}`)
  console.log(`  matched + non-stocked               : ${v(matchedNonStocked)}`)
  console.log(`  matched PREP output (made in-house)  : ${v(prepMatched)}`)
  console.log(`  skipped / pending / unmatched        : ${v(skipPending + unmatched)}`)

  // Stock-side value: buildPurchaseMap (base qty) x current ppb
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true },
    select: { id: true, ...PRICING_SELECT },
  })
  const ppb = new Map(items.map(i => [i.id, pricePerBaseUnit(asChainItem(i))]))
  const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })
  let stockVal = 0
  for (const rc of rcs) {
    const m = await buildPurchaseMap(new Date(0), rc.id)
    for (const [id, qty] of m) stockVal += qty * (ppb.get(id) ?? 0)
  }

  console.log(`\n=== Stock side ===`)
  console.log(`  matched+stocked line totals (PAID)  : ${v(matchedStocked)}`)
  console.log(`  buildPurchaseMap value (CURRENT ppb): ${v(stockVal)}   <= my "$28K"`)
  console.log(`  valuation diff (price moves + unconvertible): ${v(stockVal - matchedStocked)}`)

  console.log(`\n=== Bridge: app $${grand.toFixed(0)} -> stock $${stockVal.toFixed(0)} ===`)
  console.log(`  ${v(grand)}  app purchases (money paid)`)
  console.log(`  ${v(-extra)}  tax / fees / deposits (never inventory)`)
  console.log(`  ${v(-(skipPending+unmatched))}  skipped/pending/unmatched lines`)
  console.log(`  ${v(-matchedNonStocked)}  non-stocked items (excluded from stock)`)
  console.log(`  ${v(-prepMatched)}  PREP outputs (made in-house, not a purchase-to-stock)`)
  console.log(`  ${v(stockVal - matchedStocked)}  valuation: paid price -> current ppb`)
  console.log(`  = ${v(stockVal)}  theoretical-stock purchase value`)

  await prisma.$disconnect()
}
main().catch(async e=>{console.error(e);await prisma.$disconnect();process.exit(1)})
