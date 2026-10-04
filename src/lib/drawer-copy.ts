// The item drawer's sentences — one place for the words, so the drawer reads the
// same everywhere and the wording is tested. Pure: no data loading, no React.
// cost-basis.ts imports Prisma at runtime — type-only import keeps it out of the bundle.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { formatCurrency, priceDisplayScale } from '@/lib/utils'
import { levelBaseUnits, type PackLink } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { offerListedPrice } from '@/lib/offer-price'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A calendar day as "28 Sep". Takes a day key ("2026-09-28") or an ISO
 *  timestamp (its first ten characters); anything else is returned as written. */
export function shortDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day)
  if (!m) return day
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`
}

/** Money per a unit, the one way the drawer writes it: "$29.82/kg". */
export function moneyPerUnit(amount: number, unit: string): string {
  return `${formatCurrency(amount)}/${unit}`
}

/** A $/base price the way the drawer says it: "$0.42/each", "$12.50/kg". */
export function priceEach(pricePerBase: number, baseUnit: string): string {
  const { factor, rateUnit } = priceDisplayScale(baseUnit)
  return moneyPerUnit(pricePerBase * factor, rateUnit)
}

const NO_PRICE = 'it has no price yet. Add a supplier box, or set its price in Edit.'

/** A drawer sentence and how loudly to say it: 'warn' is shown in red. */
export interface DrawerSentence { text: string; tone: 'warn' | 'plain' }

/** How many times off one price is from another, the bigger way up: 1000 or
 *  0.001 both read 1000. Null when either is not a real price. */
function timesOff(a: number, b: number): number | null {
  if (!(a > 0) || !(b > 0)) return null
  return Math.round(Math.max(a / b, b / a))
}

/** What recipes cost this item at — the 30-day average, or the last price and
 *  why. An average ignored for being far off the last price is a warning: it
 *  says how far off, and what to do. */
export function recipeCostSentence(cb: ItemCostBasis, baseUnit: string): DrawerSentence {
  const plain = (text: string): DrawerSentence => ({ text, tone: 'plain' })
  if (cb.fallbackReason === 'prep-linked') return plain('Cost comes from the recipe.')
  const price = priceEach(cb.pricePerBase, baseUnit)
  if (cb.basis === 'AVG_30D' && cb.avg) {
    const n = cb.avg.lines
    return plain(`Recipes cost this at ${price} (30-day average, ${n} ${n === 1 ? 'delivery' : 'deliveries'}).`)
  }
  if (!(cb.pricePerBase > 0)) return plain(`Recipes cost this at ${price} — ${NO_PRICE}`)
  if (cb.fallbackReason === 'implausible') {
    const n = cb.avg ? timesOff(cb.avg.pricePerBase, cb.pricePerBase) : null
    const howFar = n ? `${n.toLocaleString('en-CA')}× off` : 'far off'
    return {
      text: `Recipes cost this at ${price} — the 30-day average was ignored: it is ${howFar} the last price. Check this item's receipts.`,
      tone: 'warn',
    }
  }
  return plain(`Recipes cost this at ${price} (no deliveries in 30 days — using the last price).`)
}

/** What counts value this item at — the main box's price, its supplier and the
 *  day it last came; "(set by hand)" with no box; "(from the recipe)" for a
 *  recipe-made item. `lastDelivery` is a day key or ISO date (shown as
 *  "28 Sep"); null leaves it out. `boxes` is the item's box count — when it is
 *  not known, a supplier on the item stands for a box. */
export function countValueSentence(
  last: number,
  baseUnit: string,
  supplierName: string | null,
  lastDelivery: string | null,
  opts: { fromRecipe?: boolean; boxes?: number | null } = {},
): string {
  const price = priceEach(last, baseUnit)
  if (opts.fromRecipe) return `Counts value it at ${price} (from the recipe).`
  if (!(last > 0)) return `Counts value it at ${price} — ${NO_PRICE}`
  const hasBox = opts.boxes != null ? opts.boxes > 0 : !!supplierName
  if (!hasBox) return `Counts value it at ${price} (set by hand).`
  const who = supplierName ? `, ${supplierName}` : ''
  const when = lastDelivery ? `, ${shortDay(lastDelivery)}` : ''
  return `Counts value it at ${price} (main box price${who}${when}).`
}

/** One "Price paid" row's amount. The price-history read carries no pricing
 *  mode or rate unit, so the amount can't name its unit honestly — it names
 *  the invoice instead: "$18.65 (invoice 444158797)". */
export function pricePaidText(row: { unitPrice: number; invoiceNumber: string | null }): string {
  const money = formatCurrency(row.unitPrice)
  return row.invoiceNumber ? `${money} (invoice ${row.invoiceNumber})` : money
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

const unitWord = (u: string | null | undefined) => (u ? canonicalUom(u) : '')

/** A box's (or a box-less item's) own price as written on the invoice:
 *  "$59.63 per case" for a pack price, "$3.49/lb" for a rate. */
export function boxPriceText(pricing: unknown, chain: PackLink[] | null | undefined): string {
  // offerListedPrice reads the rate or the pack price off the pricing JSON.
  const amount = offerListedPrice({ pricing })
  const rate = pricing as { mode?: string; rateUnit?: string } | null
  if (rate?.mode === 'RATE') return moneyPerUnit(amount, unitWord(rate.rateUnit))
  const top = Array.isArray(chain) && chain.length ? chain[0].unit : 'case'
  return `${formatCurrency(amount)} per ${top}`
}

/** The price line of an item with no supplier box: its own price and what one
 *  of its top pack holds — "$59.63 per case · 1 case = 6,000 g". A pack that is
 *  just the base unit ("1 each = 1 each") leaves the second part off. */
export function packPriceLine(pricing: unknown, chain: PackLink[] | null | undefined, baseUnit: string): string {
  const price = boxPriceText(pricing, chain)
  if (!Array.isArray(chain) || chain.length === 0) return price
  const top = chain[0]
  const holds = levelBaseUnits(chain)[top.unit] ?? 0
  if (!(holds > 0) || (chain.length === 1 && top.unit === baseUnit && holds === 1)) return price
  return `${price} · 1 ${top.unit} = ${(+holds.toFixed(3)).toLocaleString('en-CA')} ${baseUnit}`
}

/** Supplier boxes in the order the drawer lists them: the main box first, then
 *  the cheapest per base unit; a box with no usable price goes last. */
export function sortBoxes<T extends { isPrimary: boolean; pricePerBaseUnit: number }>(boxes: T[]): T[] {
  const key = (b: T) => (b.pricePerBaseUnit > 0 ? b.pricePerBaseUnit : Infinity)
  return [...boxes].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return key(a) - key(b)
  })
}
