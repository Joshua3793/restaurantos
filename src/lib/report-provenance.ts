/**
 * Single source of truth for "where does this number come from?" — the derivation
 * of every Reports KPI. Consumed by:
 *   • the inline ⓘ tooltips on each report page (InfoDot), and
 *   • the "Definitions" sheet in the Excel export (/api/reports/export).
 *
 * Keep each entry to one or two sentences: formula · window · scope · caveat.
 * All money figures derive $/base-unit from each item's pack chain at read time
 * (the "spine"), never a stored price.
 */
export const PROVENANCE = {
  // ── Overview ──────────────────────────────────────────────────────────────
  heroFoodCost:
    'Approved invoice spend ÷ estimated food sales over the selected range — a purchase-to-sales ratio, NOT plate cost. Purchases are lumpy, so short windows can exceed 100%. Scoped to the selected RC/Location.',
  revenue:
    'Sum of every sales entry’s total revenue over the selected range, scoped to the RC/Location. Manual and Toast entries for the same day/RC are de-duplicated (Toast wins).',
  purchases:
    'Sum of approved invoice line totals, windowed on each invoice’s purchase date and scoped to the RC/Location. This is the numerator of the food-cost ratio.',
  wastage:
    'Sum of logged wastage cost impact over the selected range, scoped to the RC/Location.',
  onHand:
    'Theoretical inventory value: (last count + purchases − sales − wastage − prep) since the last count, each item priced from its pack chain. Point-in-time — not a live physical count.',
  targetPct:
    'The selected RC’s target cost %. A Location averages the defined targets of its child RCs; otherwise it falls back to the default RC’s target, or 27%.',
  topValueDrivers:
    'Top 10 items by on-hand value = effective stock × price/base-unit (derived from the pack chain). Effective stock follows the selected scope (RC allocation, Location child-RCs, or global pool).',
  recipeDrift:
    'MENU recipes whose cost ÷ menu price exceeds the target by >3 points. Recipe cost is derived live from ingredient pack chains. Scoped to the selected RC/Location (menus are per-RC).',

  // ── COGS ──────────────────────────────────────────────────────────────────
  cogsBeginning:
    'Inventory value from the latest finalized FULL count on/before the range start (by count date), taken from that count’s frozen snapshot valuation. Scoped to the RC/Location.',
  cogsPurchases:
    'Sum of approved invoice line totals with a purchase date inside the range, scoped to the RC/Location.',
  cogsEnding:
    'Inventory value from the latest finalized FULL count on/before the range end (by count date), from that count’s snapshot valuation. Scoped to the RC/Location.',
  cogs:
    'Beginning inventory + purchases − ending inventory. Requires FULL counts bracketing the period; between counts it falls back to purchases only.',
  cogsPct:
    'COGS ÷ food sales over the range (food sales = revenue × food-sales %). Scoped to the RC/Location.',

  // ── Sales ─────────────────────────────────────────────────────────────────
  salesTotalRevenue:
    'Sum of sales-entry revenue over the range, scoped to the RC/Location, de-duplicated across manual/Toast (Toast wins).',
  salesFoodSales:
    'Estimated food portion of revenue = Σ revenue × each entry’s food-sales %.',
  salesServiceDays:
    'Count of sales entries logged in the range (service days), not covers or checks.',
  salesTopItems:
    'Menu items ranked by quantity sold. Cost % = per-portion recipe cost ÷ menu price, cost derived live from ingredient pack chains (nested-PREP safe).',
  salesFoodCostAlerts:
    'Menu items whose cost % exceeds 35% — review pricing or recipe cost.',

  // ── Purchasing ────────────────────────────────────────────────────────────
  purchTotalSpend:
    'Sum of approved invoice line totals, windowed on invoice purchase date and scoped to the RC/Location.',
  purchBySupplier:
    'Spend folded by supplier identity (OCR name variants of one supplier merge into its canonical name).',
  purchTopItems:
    'Items ranked by total purchase spend in the range. Quantity sums raw invoice quantities and may mix pack units.',
  purchMultiSupplier:
    'Items offered by 2+ suppliers, with potential saving vs the cheapest offer. GLOBAL — supplier offers carry no revenue center, so this ignores the RC/Location lens.',

  // ── Inventory ─────────────────────────────────────────────────────────────
  invValue:
    'On-hand value = effective stock × price/base-unit (from the pack chain), summed over stocked items. Effective stock follows the selected scope. Point-in-time.',
  invActiveItems:
    'Count of active, stocked inventory items.',
  invNotCounted30:
    'Active items never counted or not counted in 30+ days (current state — not windowed by the range).',
  invPriceChanges:
    'Price-change alerts created inside the range. GLOBAL — price alerts are item-level and carry no revenue center.',
  invValueTrend:
    'Total counted value of the last 6 finalized FULL counts (scoped to the RC/Location), newest last.',

  // ── Prep ──────────────────────────────────────────────────────────────────
  prepTotalLogged:
    'Count of prep logs recorded in the range, scoped to the RC/Location.',
  prepCompleted:
    'Prep logs marked done or partial in the range.',
  prepBlocked:
    'Prep logs marked blocked in the range.',
  prepCompletionRate:
    '(Done + partial) ÷ total logs in the range.',
  prepMostPrepped:
    'Items by total quantity produced, summed in each item’s own prep unit (no cross-unit conversion).',

  // ── Menu engineering ──────────────────────────────────────────────────────
  menuQuadrants:
    'Dishes split into Stars/Plowhorses/Puzzles/Dogs at the median popularity (qty sold) and median contribution margin (menu price − per-portion cost). Cost derived live from pack chains. Scoped to the RC/Location and range.',

  // ── Theoretical usage ─────────────────────────────────────────────────────
  tuPortionsSold:
    'Total portions sold in the range (from sale line items), scoped to the RC/Location.',
  tuTheoreticalCost:
    'What recipes SHOULD have consumed: Σ portions × recipe ingredient quantities, each priced from its pack chain. Usage stops at PREP items (no double-counting of raws).',
  tuUnaccountedLoss:
    'Cost of the gap between actual inventory change (opening − closing counts) and theoretical usage. Requires FULL counts bracketing the range.',
} as const

export type ProvenanceKey = keyof typeof PROVENANCE
