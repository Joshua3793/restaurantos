'use client'
// Smart Prep v2 — left-pane suggestion row (design PPSuggRow). Priority is
// computed live from stock; the row explains WHY via whyLabel.
import { AlertTriangle, Check, Plus } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { PLAN_PRIO_META, effectivePriority, suggestedDraftQty, whyLabel } from '@/lib/prep-plan'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function SuggestionRow({ item, locked, onOpen, onAdd, onRemove }: {
  item: PrepItemRich
  locked: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
}) {
  const p = effectivePriority(item)
  const m = PLAN_PRIO_META[p]
  const sugg = suggestedDraftQty(item)
  const fill = Math.min(100, ((item.onHand ?? 0) / (item.parLevel || 1)) * 100)
  const short = (item.ingredientShortCount ?? 0) > 0
  return (
    <div
      className={`grid grid-cols-[1fr_64px_72px_28px] items-center gap-2 border rounded-[9px] py-2 pr-2 pl-2.5 border-l-[3px] ${item.isOnList ? 'bg-bg border-line opacity-60' : 'bg-paper border-line'}`}
      style={{ borderLeftColor: item.isOnList ? '#d4d4d8' : p === '911' ? '#dc2626' : p === 'NEEDED_TODAY' ? '#d97706' : '#16a34a' }}
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
        <span className="block font-mono text-[9px] text-ink-4 mt-0.5 truncate">
          {item.category}{item.station ? ` · ${item.station}` : ''} · {whyLabel(item)}
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
      <span className={`font-mono text-[11.5px] font-bold text-right ${sugg > 0 ? 'text-ink' : 'text-green'}`}>
        {sugg > 0 ? fmtQ(sugg, item.unit) : 'at par'}
      </span>
      <button
        type="button"
        disabled={locked}
        onClick={() => (item.isOnList ? onRemove(item) : onAdd(item))}
        title={locked ? 'Chef only' : item.isOnList ? 'On the list — click to take it off' : 'Add to the draft list'}
        className={`w-[26px] h-[26px] rounded-[7px] grid place-items-center border ${locked ? 'bg-bg-2 border-line cursor-not-allowed' : item.isOnList ? 'bg-green-soft border-green' : 'bg-ink border-ink'}`}
      >
        {item.isOnList
          ? <Check size={14} className={locked ? 'text-ink-4' : 'text-green-text'} />
          : <Plus size={14} className={locked ? 'text-ink-4' : 'text-gold'} />}
      </button>
    </div>
  )
}
