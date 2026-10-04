'use client'
import { useState } from 'react'
import { pricePaidText, shortDay } from '@/lib/drawer-copy'
import { MergedItemsRow } from '../MergeItemSheet'
import { RemeasuredRow } from '../RemeasureSheet'
import { CollapsibleSection } from './CollapsibleSection'
import type { InventoryItem, PriceHistoryRow } from './types'

/** How many "Price paid" rows show before "Show more". */
const PRICE_ROWS = 12

const dayOf = (h: PriceHistoryRow) => {
  const d = h.dayKey ?? h.invoiceDate
  return d ? shortDay(d) : 'Undated'
}

/** History, in this order: the price paid on each recent delivery (one list,
 *  newest first, with the invoice it was on), then items merged into this one
 *  and measure changes on it (each with its Undo). Prices are LEAD+; merges
 *  and measure changes MANAGER+. */
export function HistorySection({
  item, canMerge, canEdit, seesMoney, mergeTick, measureTick,
  onMergesChanged, onRemeasureChanged, priceHistory,
}: {
  item: InventoryItem
  canMerge: boolean
  canEdit: boolean
  seesMoney: boolean
  mergeTick: number
  measureTick: number
  onMergesChanged: () => void
  onRemeasureChanged: () => void
  priceHistory: PriceHistoryRow[]
}) {
  const [showAll, setShowAll] = useState(false)
  const isRecipe = !!item.recipe
  // The read is newest-APPROVED first; list by the invoice's own day, newest
  // first (undated last; ties keep the read's order).
  const rows = [...priceHistory].sort((a, b) => (b.dayKey ?? '').localeCompare(a.dayKey ?? ''))
  const shown = showAll ? rows : rows.slice(0, PRICE_ROWS)
  const showPrices = seesMoney && (priceHistory.length > 0 || !isRecipe)
  const showMerges = canMerge && !isRecipe
  const showMeasures = canEdit && !isRecipe
  if (!showPrices && !showMerges && !showMeasures) return null
  return (
    <CollapsibleSection name="history" title="History" defaultOpen={false} gap="space-y-3">
      {/* The price paid on each recent delivery. */}
      {showPrices && (
        priceHistory.length === 0 ? (
          <div className="text-[12px] text-ink-4">
            No deliveries yet — prices show here once an invoice with this item is approved.
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[11.5px] font-medium text-ink-3">Price paid</div>
            <div className="bg-paper border border-line rounded-[10px] divide-y divide-line">
              {shown.map((h, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]">
                  <span className="min-w-0 truncate text-ink-2">
                    <span className="font-mono text-ink-4 tabular-nums">{dayOf(h)}</span> · {h.supplierName}
                  </span>
                  <span className="font-mono font-semibold text-ink tabular-nums shrink-0">{pricePaidText(h)}</span>
                </div>
              ))}
            </div>
            {rows.length > PRICE_ROWS && (
              <button
                type="button" onClick={() => setShowAll(v => !v)}
                className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink-2"
              >
                {showAll ? 'Show less' : `Show more (${rows.length - PRICE_ROWS})`}
              </button>
            )}
          </div>
        )
      )}

      {/* Items merged into this one, each with its Undo (the Merge button is in the header). */}
      {showMerges && (
        <MergedItemsRow itemId={item.id} refreshKey={mergeTick} onChanged={onMergesChanged} />
      )}

      {/* Measure changes on this item, each with its Undo. */}
      {showMeasures && (
        <RemeasuredRow itemId={item.id} refreshKey={measureTick} onChanged={onRemeasureChanged} />
      )}
    </CollapsibleSection>
  )
}
