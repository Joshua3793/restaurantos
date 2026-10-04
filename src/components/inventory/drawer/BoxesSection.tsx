'use client'
import Link from 'next/link'
import type { Dimension } from '@/lib/item-model'
import { lastDeliveryDay } from '@/lib/drawer-copy'
import { SupplierOffersSection } from '../SupplierOffersSection'
import { SectionTitle } from './SectionTitle'
import { chainFromItem, type InventoryItem, type PriceHistoryRow } from './types'

/** Supplier boxes, one card each — prices, so LEAD+; adding, editing, removing
 *  a box or switching the main one re-prices the item, so MANAGER+. Shown even
 *  with no boxes: the empty state carries the item's own price (and, for a
 *  manager, the way to add the first box). A recipe-made item has no boxes —
 *  its cost comes from the recipe, so it links there. Every box write can move
 *  the item's version and price, so it re-fetches the item. */
export function BoxesSection({ item, seesMoney, canEdit, measureTick, onRefresh, priceHistory }: {
  item: InventoryItem
  seesMoney: boolean
  canEdit: boolean
  /** Bumped after a measure change (or its undo) — re-mounts the boxes. */
  measureTick: number
  onRefresh: () => Promise<void>
  /** The drawer's price-history read — a card's "last delivered" day comes
   *  from it, the same source the cost line uses. */
  priceHistory: PriceHistoryRow[]
}) {
  if (!seesMoney) return null
  if (item.recipe) {
    return (
      <div className="space-y-2">
        <SectionTitle>Supplier boxes</SectionTitle>
        <Link
          href={`/recipes?item=${item.recipe.id}`}
          className="block bg-paper border border-line rounded-[10px] px-3 py-2.5 text-[13px] text-ink-2 hover:border-ink-3 transition-colors"
        >
          Cost comes from the recipe <span className="font-medium text-ink">{item.recipe.name}</span> &rarr;
        </Link>
      </div>
    )
  }
  const c = chainFromItem(item)
  return (
    <div className="space-y-2">
      <SectionTitle>Supplier boxes</SectionTitle>
      <SupplierOffersSection
        // A measure change (or its undo) re-expresses every box — re-mount
        // so the list re-loads and no box form stays open in the old measure.
        key={`offers-${measureTick}`}
        variant="cards"
        itemId={item.id}
        itemName={item.itemName}
        baseUnit={item.baseUnit ?? null}
        dimension={(item.dimension ?? 'COUNT') as Dimension}
        itemChain={c.chain}
        itemPricing={c.pricing}
        itemLastUpdated={item.lastUpdated ?? null}
        eachMeasureQty={item.eachMeasureQty ?? null}
        eachMeasureUnit={item.eachMeasureUnit ?? null}
        onRepriced={onRefresh}
        canSetPrimary={canEdit}
        canEdit={canEdit}
        onChanged={onRefresh}
        lastDeliveryOf={name => lastDeliveryDay(priceHistory, name)}
      />
    </div>
  )
}
