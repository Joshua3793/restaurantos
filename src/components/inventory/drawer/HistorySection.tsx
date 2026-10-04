'use client'
import { formatCurrency } from '@/lib/utils'
import { shortDay } from '@/lib/drawer-copy'
import { MergedItemsRow } from '../MergeItemSheet'
import { RemeasuredRow } from '../RemeasureSheet'
import { SectionTitle } from './SectionTitle'
import type { InventoryItem, PriceHistoryRow } from './types'

/** How many invoice lines "Recent invoice lines" lists. */
const RECENT_LINES = 5

const dayOf = (h: PriceHistoryRow) => {
  const d = h.dayKey ?? h.invoiceDate
  return d ? shortDay(d) : 'Undated'
}

/** History, in this order: the price paid on each recent delivery, items merged
 *  into this one and measure changes on it (each with its Undo), then the most
 *  recent invoice lines. Prices are LEAD+; merges and measure changes MANAGER+.
 *  Both price lists come from the one price-history read (the item's last 12
 *  approved invoice lines). */
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
  const isRecipe = !!item.recipe
  // The read is newest-APPROVED first; list by the invoice's own day, newest
  // first (undated last; ties keep the read's order).
  const rows = [...priceHistory].sort((a, b) => (b.dayKey ?? '').localeCompare(a.dayKey ?? ''))
  const showPrices = seesMoney && (priceHistory.length > 0 || !isRecipe)
  const showMerges = canMerge && !isRecipe
  const showMeasures = canEdit && !isRecipe
  if (!showPrices && !showMerges && !showMeasures) return null
  return (
    <div className="space-y-3">
      <SectionTitle>History</SectionTitle>

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
              {rows.map((h, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]">
                  <span className="min-w-0 truncate text-ink-2">
                    <span className="font-mono text-ink-4 tabular-nums">{dayOf(h)}</span> · {h.supplierName}
                  </span>
                  <span className="font-mono font-semibold text-ink tabular-nums shrink-0">{formatCurrency(h.unitPrice)}</span>
                </div>
              ))}
            </div>
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

      {/* The last few invoice lines: which invoice, how many, what it came to. */}
      {seesMoney && priceHistory.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11.5px] font-medium text-ink-3">Recent invoice lines</div>
          <div className="space-y-1.5">
            {rows.slice(0, RECENT_LINES).map((h, i) => (
              <div key={i} className="flex items-center justify-between gap-3 bg-paper border border-line rounded-[10px] px-3 py-2 text-[12px]">
                <div className="min-w-0">
                  <div className="font-medium text-ink truncate">{h.supplierName}</div>
                  <div className="text-[11px] text-ink-4 mt-0.5">
                    {dayOf(h)}{h.invoiceNumber ? ` · invoice ${h.invoiceNumber}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0 font-mono tabular-nums">
                  <div className="font-semibold text-ink">{h.lineTotal != null ? formatCurrency(h.lineTotal) : '—'}</div>
                  <div className="text-ink-4 text-[10.5px]">
                    {h.qtyPurchased != null ? `${(+h.qtyPurchased.toFixed(3)).toLocaleString()} bought` : 'quantity not read'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
