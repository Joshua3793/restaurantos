'use client'
import { formatCurrency, formatPricePerBase } from '@/lib/utils'
import { basePerUnit, type ChainItem } from '@/lib/item-model'
// cost-basis.ts imports Prisma at runtime — type-only import so it isn't bundled client-side.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { canonicalUom } from '@/lib/uom'
import type { InventoryItem, ItemChainForm } from './types'

// Shows the 30-day weighted-average cost recipes are actually priced on, next to the
// item's last (stored) price — so a chef can see why a recipe's cost moved without
// this item's own price block having changed. `last` is the item's pricePerBaseUnit.
export function CostBasisRow({ cb, baseUnit, last }: { cb: ItemCostBasis; baseUnit: string; last: number }) {
  const label = <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.04em]">30-day average</div>
  if (cb.fallbackReason === 'implausible' && cb.avg) {
    const ratio = Math.round(Math.max(cb.avg.pricePerBase / last, last / cb.avg.pricePerBase))
    return <div>{label}<div className="text-[13px] text-red-text mt-1">Average ignored — {ratio}× off the last price; check this item&rsquo;s receipts</div></div>
  }
  if (cb.basis !== 'AVG_30D' || !cb.avg) {
    return <div>{label}<div className="text-[13px] text-ink-3 mt-1">No purchases in 30 days — recipes use the last price.</div></div>
  }
  const delta = last > 0 ? Math.round((cb.avg.pricePerBase / last - 1) * 100) : null
  return (
    <div>{label}
      <div className="font-medium text-ink mt-1">{formatPricePerBase(cb.avg.pricePerBase, baseUnit)}
        <span className="text-ink-3 font-normal"> · {cb.avg.lines} invoice{cb.avg.lines === 1 ? '' : 's'} · {formatCurrency(cb.avg.paid)} for {cb.avg.received.toLocaleString()} {baseUnit}{delta !== null ? ` · ${delta > 0 ? '+' : ''}${delta} % vs last price` : ''}</span>
      </div>
    </div>
  )
}

/** The PRICE block — the item's last (stored) price, LEAD+. A grid cell. */
export function PriceBlock({ item, c, ci, ppb, seesMoney }: {
  item: InventoryItem
  c: ItemChainForm
  ci: ChainItem
  ppb: number
  seesMoney: boolean
}) {
  if (!seesMoney) return null
  return (
    <div className={`rounded-[10px] p-3 col-span-2 border ${item.recipe ? 'bg-blue-soft border-blue-soft' : 'bg-gold-soft border-[#fcd34d]'}`}>
      {item.recipe && (
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] bg-blue-soft text-blue-text px-1.5 py-0.5 rounded-full">Recipe</span>
          <span className="text-[11px] text-blue-text font-medium">{item.recipe.name}</span>
        </div>
      )}
      <div className={`font-mono text-[10px] font-semibold uppercase tracking-[0.04em] ${item.recipe ? 'text-blue' : 'text-gold-2'}`}>
        Price
      </div>
      <div className={`font-mono text-[17px] font-semibold tabular-nums mt-1 tracking-[-0.01em] ${item.recipe ? 'text-blue-text' : 'text-gold-2'}`}>
        {formatPricePerBase(ppb, ci.baseUnit)}
      </div>
      <div className={`font-mono text-[11px] mt-1.5 tracking-[0] ${item.recipe ? 'text-blue' : 'text-[#92722f]'}`}>
        {c.pricing.mode === 'RATE'
          ? <>{formatCurrency(c.pricing.rate)} / {canonicalUom(c.pricing.rateUnit)}</>
          : <>{formatCurrency(c.pricing.purchasePrice)} per {c.chain[0]?.unit ?? 'pack'} &nbsp;|&nbsp; 1 {c.countUnit} = {basePerUnit(ci, c.countUnit).toLocaleString()} {ci.baseUnit}</>
        }
      </div>
    </div>
  )
}

/** What recipes actually cost this item at — the 30-day weighted average,
 *  shown next to (not instead of) the price block above. PREP items have
 *  no costBasis: their cost comes from the recipe, never an average. A grid cell. */
export function CostBasisBlock({ item, baseUnit, last, seesMoney }: {
  item: InventoryItem
  baseUnit: string
  last: number
  seesMoney: boolean
}) {
  if (!seesMoney || item.recipe || !item.costBasis) return null
  return (
    <div className="bg-paper border border-line rounded-[10px] p-3 col-span-2">
      <CostBasisRow cb={item.costBasis} baseUnit={baseUnit} last={last} />
    </div>
  )
}
