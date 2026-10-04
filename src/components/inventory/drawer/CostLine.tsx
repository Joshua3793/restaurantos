'use client'
// cost-basis.ts imports Prisma at runtime — type-only import so it isn't bundled client-side.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { countValueSentence, priceEach, recipeCostSentence, type DrawerSentence } from '@/lib/drawer-copy'
import { CollapsibleSection } from './CollapsibleSection'
import type { InventoryItem } from './types'

/** A sentence with its price in bold — the first place `price` appears. A
 *  warning is red throughout, its price included. */
function Sentence({ text, price, tone = 'plain' }: { text: string; price: string; tone?: DrawerSentence['tone'] }) {
  const warn = tone === 'warn'
  const at = text.indexOf(price)
  if (at < 0) return <p className={warn ? 'text-red-text' : undefined}>{text}</p>
  return (
    <p className={warn ? 'text-red-text' : undefined}>
      {text.slice(0, at)}
      <strong className={`font-semibold tabular-nums ${warn ? 'text-red-text' : 'text-ink'}`}>{price}</strong>
      {text.slice(at + price.length)}
    </p>
  )
}

/** The cost line — two sentences: what recipes cost this item at (the 30-day
 *  average, or the last price and why — in red when the average was ignored)
 *  and what counts value it at (the main box's price, its supplier and when).
 *  Nothing at all below LEAD. A recipe-made item's "Cost comes from the
 *  recipe" is said once: by the boxes section when it shows, else here. */
export function CostLine({ item, baseUnit, last, lastDelivery, seesMoney, boxesShown }: {
  item: InventoryItem
  baseUnit: string
  /** The item's last price per base unit — pricePerBaseUnit of its chain. */
  last: number
  /** Day key of the main supplier's newest delivery, if known. */
  lastDelivery: string | null
  seesMoney: boolean
  /** The supplier-boxes section is on screen (it links a recipe-made item to its recipe). */
  boxesShown: boolean
}) {
  if (!seesMoney) return null
  // A recipe-made item is never averaged (the route sends no costBasis): its
  // cost is the recipe's. An item the route sent no basis for says only the count.
  const cb: ItemCostBasis | null = item.recipe
    ? { basis: 'LAST', pricePerBase: last, fallbackReason: 'prep-linked' }
    : item.costBasis ?? null
  const recipeLine = cb && !(item.recipe && boxesShown) ? recipeCostSentence(cb, baseUnit) : null
  const countLine = countValueSentence(
    last, baseUnit, item.supplier?.name ?? null, lastDelivery,
    { fromRecipe: !!item.recipe, boxes: item.offerCount ?? null },
  )
  return (
    // No heading on sm+ (the cost line never had one); a foldable title on a phone.
    <CollapsibleSection name="cost" title="What it costs" heading={null}>
      <div className="bg-paper border border-line rounded-[10px] p-3 space-y-1 text-[13px] leading-snug text-ink-2">
        {recipeLine && cb && (
          <Sentence text={recipeLine.text} tone={recipeLine.tone} price={priceEach(cb.pricePerBase, baseUnit)} />
        )}
        <Sentence text={countLine} price={priceEach(last, baseUnit)} />
      </div>
    </CollapsibleSection>
  )
}
