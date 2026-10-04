'use client'
import { formatCurrency } from '@/lib/utils'
import { MergedItemsRow } from '../MergeItemSheet'
import { RemeasuredRow } from '../RemeasureSheet'
import { formatDay, type InventoryItem, type PriceHistoryRow } from './types'

/** Merges into this item, measure changes on it (each with its Undo) and the
 *  price history. Renders bare siblings (a fragment) inside the shell's view body. */
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
  return (
    <>
      {/* Merges into this item, each with its Undo (the Merge button is in the header). */}
      {canMerge && !item.recipe && (
        <MergedItemsRow itemId={item.id} refreshKey={mergeTick} onChanged={onMergesChanged} />
      )}

      {/* Measure changes on this item, each with its Undo. */}
      {canEdit && !item.recipe && (
        <RemeasuredRow itemId={item.id} refreshKey={measureTick} onChanged={onRemeasureChanged} />
      )}

      {/* Price History */}
      {seesMoney && priceHistory.length > 0 && (
        <div className="mt-2">
          <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em] mb-2">Price history</div>
          <div className="space-y-1.5">
            {priceHistory.map((h, i) => (
              <div key={i} className="flex items-center justify-between bg-paper border border-line rounded-[10px] px-3 py-2 text-[12px]">
                <div className="min-w-0">
                  <div className="font-medium text-ink truncate">{h.supplierName}</div>
                  <div className="font-mono text-[10.5px] text-ink-4 mt-0.5">
                    {formatDay(h.dayKey, h.invoiceDate) || 'Undated'}
                    {h.invoiceNumber ? ` · #${h.invoiceNumber}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0 ml-3 font-mono tabular-nums">
                  <div className="font-semibold text-ink">{formatCurrency(h.unitPrice)}</div>
                  <div className="text-ink-4 text-[10.5px]">
                    {h.lineTotal != null ? `${formatCurrency(h.lineTotal)} total` : '—'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
