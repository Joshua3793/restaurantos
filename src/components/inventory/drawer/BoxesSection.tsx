'use client'
import type { Dimension } from '@/lib/item-model'
import { SupplierOffersSection } from '../SupplierOffersSection'
import { chainFromItem, type InventoryItem } from './types'

/** Supplier boxes — prices, so LEAD+; adding, editing, removing a box or
 *  switching the main one re-prices the item, so MANAGER+. Shown even
 *  with no boxes so a manager can add the first one. A recipe-made item
 *  has no boxes (its price comes from the recipe). Every box write can
 *  move the item's version and price, so it re-fetches the item. */
export function BoxesSection({ item, seesMoney, canEdit, measureTick, onRefresh }: {
  item: InventoryItem
  seesMoney: boolean
  canEdit: boolean
  /** Bumped after a measure change (or its undo) — re-mounts the boxes. */
  measureTick: number
  onRefresh: () => Promise<void>
}) {
  if (!seesMoney || item.recipe) return null
  return (
    <SupplierOffersSection
      // A measure change (or its undo) re-expresses every box — re-mount
      // so the list re-loads and no box form stays open in the old measure.
      key={`offers-${measureTick}`}
      itemId={item.id}
      itemName={item.itemName}
      baseUnit={item.baseUnit ?? null}
      dimension={(item.dimension ?? 'COUNT') as Dimension}
      itemChain={chainFromItem(item).chain}
      itemPricing={chainFromItem(item).pricing}
      itemLastUpdated={item.lastUpdated ?? null}
      eachMeasureQty={item.eachMeasureQty ?? null}
      eachMeasureUnit={item.eachMeasureUnit ?? null}
      onRepriced={onRefresh}
      canSetPrimary={canEdit}
      canEdit={canEdit}
      onChanged={onRefresh}
    />
  )
}
