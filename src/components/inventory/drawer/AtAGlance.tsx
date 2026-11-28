'use client'
import { ClipboardCheck } from 'lucide-react'
import { boxPriceText, priceEach, shortDay } from '@/lib/drawer-copy'
import { resolveCountUom } from '@/lib/count-uom'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { displayStock, itemChainDims, type InventoryItem, type StockMovementsResponse } from './types'

/** Phone only (below `sm`): the three questions a cook asks of an item — do we
 *  have it, what does it cost, who sells it — answered before any section,
 *  with the quick count one tap away. Prices only for a viewer who sees money
 *  (the API nulls them below LEAD anyway). Editing lives on a computer. */
export function AtAGlance({
  item, ppb, baseUnit, seesMoney, canEdit, stockMovements, stockLoading, activeRc, onCount,
}: {
  item: InventoryItem
  /** The item's price per base unit — pricePerBaseUnit of its chain. */
  ppb: number
  baseUnit: string
  seesMoney: boolean
  canEdit: boolean
  stockMovements: StockMovementsResponse | null
  stockLoading: boolean
  activeRc: RevenueCenter | null
  onCount: () => void
}) {
  const onHand = +displayStock(item).toFixed(2)
  // Same unit displayStock converts into (StockSection's label), not the raw countUnit.
  const unit = resolveCountUom(itemChainDims(item)) || item.baseUnit || baseUnit
  const last = stockMovements?.lastCount
  const lastDay = last?.date ? (last.dayKey ?? last.date.slice(0, 10)) : (item.lastCountDate ?? null)
  const counted = lastDay ? `Counted ${shortDay(lastDay)}` : stockLoading ? 'Loading…' : 'Never counted'
  const hasPrice = seesMoney && ppb > 0

  const rows: [string, string, string?][] = [
    ['On hand', `${onHand.toLocaleString('en-CA')} ${unit}`, counted],
    ...(seesMoney ? [[
      'Price',
      hasPrice ? boxPriceText(item.pricing, item.packChain) : 'No price yet',
      hasPrice ? priceEach(ppb, baseUnit) : undefined,
    ] as [string, string, string?]] : []),
    ['Supplier', item.supplier?.name || '—'],
    ['Stored in', item.storageArea?.name || '—'],
  ]

  return (
    <section className="sm:hidden space-y-2" aria-label="At a glance">
      <div className="bg-paper border border-line rounded-[10px] divide-y divide-line">
        {rows.map(([label, value, sub]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
            <span className="font-mono text-[10.5px] text-ink-3 uppercase tracking-[0.04em] shrink-0">{label}</span>
            <span className="min-w-0 text-right">
              <span className="block text-[15px] font-semibold text-ink tabular-nums break-words">{value}</span>
              {sub && <span className="block text-[11.5px] text-ink-4 tabular-nums">{sub}</span>}
            </span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onCount}
        disabled={!activeRc}
        className="w-full min-h-[44px] flex items-center justify-center gap-2 px-3 bg-ink text-paper text-[14px] font-medium rounded-[10px] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ClipboardCheck size={16} className="text-gold" /> Count it{activeRc ? ` · ${activeRc.name}` : ''}
      </button>
      {!activeRc && (
        <div className="text-[11.5px] text-ink-4 text-center">Pick a revenue center at the top of the page to count.</div>
      )}
      {canEdit && (
        <div className="text-[11.5px] text-ink-4 text-center">Edit on a computer to change this item.</div>
      )}
    </section>
  )
}
