'use client'
// cost-basis.ts imports Prisma at runtime — type-only import so it isn't bundled client-side.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { countValueSentence, priceEach, recipeCostSentence } from '@/lib/drawer-copy'
import type { InventoryItem } from './types'

/** A sentence with its price in bold — the first place `price` appears. */
function Sentence({ text, price }: { text: string; price: string }) {
  const at = text.indexOf(price)
  if (at < 0) return <p>{text}</p>
  return (
    <p>
      {text.slice(0, at)}
      <strong className="font-semibold text-ink tabular-nums">{price}</strong>
      {text.slice(at + price.length)}
    </p>
  )
}

/** The cost line — two sentences: what recipes cost this item at (the 30-day
 *  average, or the last price and why) and what counts value it at (the last
 *  price, who it was paid to and when). Nothing at all below LEAD. */
export function CostLine({ item, baseUnit, last, lastDelivery, seesMoney }: {
  item: InventoryItem
  baseUnit: string
  /** The item's last price per base unit — pricePerBaseUnit of its chain. */
  last: number
  /** Day key of the main supplier's newest delivery, if known. */
  lastDelivery: string | null
  seesMoney: boolean
}) {
  if (!seesMoney) return null
  // A recipe-made item is never averaged (the route sends no costBasis): its
  // cost is the recipe's. An item the route sent no basis for says only the count.
  const cb: ItemCostBasis | null = item.recipe
    ? { basis: 'LAST', pricePerBase: last, fallbackReason: 'prep-linked' }
    : item.costBasis ?? null
  const recipeLine = cb ? recipeCostSentence(cb, baseUnit) : null
  const countLine = countValueSentence(
    last, baseUnit, item.supplier?.name ?? null, lastDelivery,
    { recipeName: item.recipe?.name ?? null },
  )
  return (
    <div className="bg-paper border border-line rounded-[10px] p-3 space-y-1 text-[13px] leading-snug text-ink-2">
      {recipeLine && cb && <Sentence text={recipeLine} price={priceEach(cb.pricePerBase, baseUnit)} />}
      <Sentence text={countLine} price={priceEach(last, baseUnit)} />
    </div>
  )
}
