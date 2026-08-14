'use client'
// Smart Prep v2 — left-pane suggestion row (design PPSuggRow). The urgency step
// is computed live from stock; the Reason line is read-only evidence.
import { AlertTriangle, Check, Plus } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import {
  PLAN_URG_META, effectiveUrgency, suggestedDraftQty,
  suggestedBatches, batchesToQty, fmtBatch,
} from '@/lib/prep-plan'
import { Reason } from './atoms'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function SuggestionRow({ item, locked, onOpen, onAdd, onRemove }: {
  item: PrepItemRich
  locked: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const sugg = suggestedDraftQty(item)
  const nb = suggestedBatches(item)
  const fill = Math.min(100, ((item.onHand ?? 0) / (item.parLevel || 1)) * 100)
  const short = (item.ingredientShortCount ?? 0) > 0
  return (
    <div
      className={`grid grid-cols-[1fr_64px_76px_28px] items-center gap-2 border rounded-[9px] py-2 pr-2 pl-2.5 border-l-[3px] ${item.isOnList ? 'bg-bg border-line opacity-60' : 'bg-paper border-line'}`}
      style={{ borderLeftColor: item.isOnList ? '#d4d4d8' : m.hex }}
    >
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 text-left">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
          {short && (
            <span title={`${item.ingredientShortCount} of ${item.ingredientTotalCount} ingredients short`} className="inline-flex shrink-0">
              <AlertTriangle size={11} className="text-gold-2" />
            </span>
          )}
        </span>
        <span className="flex items-center gap-[7px] mt-0.5 min-w-0">
          {/* min-w-0+truncate, not shrink-0 — a long category otherwise paints
              over the neighbouring progress column when the pane is narrow */}
          <span className="font-mono text-[9px] text-ink-4 min-w-0 truncate">{item.category}{item.station ? ` · ${item.station}` : ''}</span>
          <Reason item={item} sm />
        </span>
      </button>
      <div className="min-w-0">
        <div className="flex h-1 rounded-full overflow-hidden bg-bg-2 mb-[3px]">
          <span className={m.barClass} style={{ width: `${fill}%` }} />
        </div>
        <span className="font-mono text-[9px] text-ink-3 whitespace-nowrap">
          {fmtQ(item.onHand ?? 0, item.unit).split(' ')[0]}/{fmtQ(item.parLevel ?? 0, item.unit)}
        </span>
      </div>
      <span className="text-right leading-[1.15]">
        <span className={`block font-mono text-[11.5px] font-bold ${sugg > 0 ? 'text-ink' : 'text-green'}`}>
          {sugg <= 0 ? 'at par' : nb ? `${fmtBatch(nb)} batch` : fmtQ(sugg, item.unit)}
        </span>
        {sugg > 0 && nb != null && nb > 0 && (
          <span className="block font-mono text-[8.5px] text-ink-4">{fmtQ(batchesToQty(item, nb), item.unit)}</span>
        )}
      </span>
      <button
        type="button"
        disabled={locked}
        onClick={() => (item.isOnList ? onRemove(item) : onAdd(item))}
        title={locked ? 'Chef only' : item.isOnList ? 'On the list — click to take it off' : 'Add to the prep list'}
        className={`w-[26px] h-[26px] rounded-[7px] grid place-items-center border ${locked ? 'bg-bg-2 border-line cursor-not-allowed' : item.isOnList ? 'bg-green-soft border-green' : 'bg-ink border-ink'}`}
      >
        {item.isOnList
          ? <Check size={14} className={locked ? 'text-ink-4' : 'text-green-text'} />
          : <Plus size={14} className={locked ? 'text-ink-4' : 'text-gold'} />}
      </button>
    </div>
  )
}
