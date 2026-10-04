// The item drawer's sentences — one place for the words, so the drawer reads the
// same everywhere and the wording is tested. Pure: no data loading, no React.
// cost-basis.ts imports Prisma at runtime — type-only import keeps it out of the bundle.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { formatCurrency, priceDisplayScale } from '@/lib/utils'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A calendar day as "28 Sep". Takes a day key ("2026-09-28") or an ISO
 *  timestamp (its first ten characters); anything else is returned as written. */
export function shortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!m) return day
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

/** A $/base price the way the drawer says it: "$0.42 / each", "$12.50 / kg". */
export function priceEach(pricePerBase: number, baseUnit: string): string {
  const { factor, rateUnit } = priceDisplayScale(baseUnit)
  return `${formatCurrency(pricePerBase * factor)} / ${rateUnit}`
}

const NO_PRICE = 'it has no price yet. Add a supplier box, or set its price in Edit.'

/** What recipes cost this item at — the 30-day average, or the last price and why. */
export function recipeCostSentence(cb: ItemCostBasis, baseUnit: string): string {
  if (cb.fallbackReason === 'prep-linked') return 'Cost comes from the recipe.'
  if (cb.basis === 'AVG_30D' && cb.avg) {
    const n = cb.avg.lines
    return `Recipes cost this at ${priceEach(cb.pricePerBase, baseUnit)} (30-day average, ${n} ${n === 1 ? 'delivery' : 'deliveries'}).`
  }
  const price = priceEach(cb.pricePerBase, baseUnit)
  if (!(cb.pricePerBase > 0)) return `Recipes cost this at ${price} — ${NO_PRICE}`
  if (cb.fallbackReason === 'implausible') {
    return `Recipes cost this at ${price} (the recent deliveries looked wrong, so the last price is used).`
  }
  return `Recipes cost this at ${price} (no deliveries in 30 days — using the last price).`
}

/** What counts value this item at — the last price, who it was paid to and when.
 *  `lastDelivery` is a day key or ISO date (shown as "28 Sep"); null leaves it out.
 *  A recipe-made item names its recipe instead of a supplier. */
export function countValueSentence(
  last: number,
  baseUnit: string,
  supplierName: string | null,
  lastDelivery: string | null,
  opts: { recipeName?: string | null } = {},
): string {
  const price = priceEach(last, baseUnit)
  if (opts.recipeName) return `Counts value it at ${price} (the cost of the recipe ${opts.recipeName}).`
  if (!(last > 0)) return `Counts value it at ${price} — ${NO_PRICE}`
  if (!supplierName) return `Counts value it at ${price} (last price set by hand).`
  const when = lastDelivery ? `, ${shortDay(lastDelivery)}` : ''
  return `Counts value it at ${price} (last paid, ${supplierName}${when}).`
}

/** The header's exception badges, in a fixed order. An ordinary item has none. */
export function badgeList(item: { isActive: boolean; isStocked: boolean; recipe: unknown }): string[] {
  const out: string[] = []
  if (!item.isActive) out.push('Inactive')
  if (item.isStocked === false) out.push('Not stocked')
  if (item.recipe) out.push('Recipe-made')
  return out
}

const trim = (n: number) => String(+n.toFixed(3))

/** The item's bridges as sentences: "1 each = 85 g · used by 3 recipes",
 *  "1 ml weighs 1.03 g". No bridge → []. `usedBy` counts the recipes that cost
 *  this item by weight through its each-measure. */
export function bridgeSentence(
  b: { eachQty?: number | null; eachUnit?: string | null; densityGPerMl?: number | null },
  usedBy: number,
): string[] {
  const out: string[] = []
  const each = Number(b.eachQty)
  if (b.eachQty != null && each > 0) {
    const used = usedBy > 0 ? ` · used by ${usedBy} ${usedBy === 1 ? 'recipe' : 'recipes'}` : ''
    out.push(`1 each = ${trim(each)} ${b.eachUnit || 'g'}${used}`)
  }
  const d = Number(b.densityGPerMl)
  if (b.densityGPerMl != null && d > 0) out.push(`1 ml weighs ${trim(d)} g`)
  return out
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The newest day key among a supplier's delivered lines (price-history rows),
 *  or null. Supplier names are matched loosely ("SYSCO Canada" ≈ "Sysco") since
 *  an invoice prints its own wording of the supplier's name. */
export function lastDeliveryDay(
  rows: { dayKey: string | null; supplierName: string | null }[],
  supplierName: string | null,
): string | null {
  if (!supplierName) return null
  const want = squash(supplierName)
  if (!want) return null
  let best: string | null = null
  for (const r of rows) {
    if (!r.dayKey || !r.supplierName) continue
    const got = squash(r.supplierName)
    if (!got || !(got === want || got.includes(want) || want.includes(got))) continue
    if (best === null || r.dayKey > best) best = r.dayKey
  }
  return best
}
