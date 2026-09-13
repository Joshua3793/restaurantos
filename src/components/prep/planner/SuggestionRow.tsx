'use client'
// Smart Prep v2 — left-pane suggestion row (design PPSuggRow). The urgency step
// is computed live from stock; evidence is icons + the on-hand/par numbers.
import { AlertTriangle, Check, Plus, Flame, Clock } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import {
  PLAN_URG_META, effectiveUrgency, suggestedDraftQty,
  suggestedBatches, batchesToQty, batchCount, fmtBatch, whyLabel, cadenceReason, longLeadQty,
} from '@/lib/prep-plan'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

export function SuggestionRow({ item, locked, longLead = false, onOpen, onAdd, onRemove, onSetPrepEnabled }: {
  item: PrepItemRich
  locked: boolean
  /** In the "Start today for …" group: the seed is the most that will keep, not the par gap. */
  longLead?: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
  /** The chef's switch: off keeps the item out of prep while the recipe stays. Omit to hide the switch. */
  onSetPrepEnabled?: (item: PrepItemRich, enabled: boolean) => void
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const sugg = longLead ? longLeadQty(item) : suggestedDraftQty(item)
  const nb = longLead ? (sugg > 0 ? batchCount(item, sugg) : null) : suggestedBatches(item)
  // The rhythm raised the step (TMRW → CLOSE): a small clock says so.
  const rhythm = cadenceReason(item)
  const short = (item.ingredientShortCount ?? 0) > 0
  // A job in flight is pipeline stock, not a stock-out — the chip replaces the triangle.
  const pipeline = item.pipeline ?? null
  const stockOut = !pipeline && (item.parLevel ?? 0) > 0 && (item.onHand ?? 0) <= 0
  const enabled = item.prepEnabled !== false
  // Switching off an item that is on the draft or the kitchen's To Do would
  // strand it there — take it off the list first.
  const onList = item.isOnList || !!item.todayLog?.postedAt
  const switchLocked = locked || (enabled && onList)
  const switchTitle = locked ? 'Chef only'
    : enabled && onList ? 'On the list — take it off before switching it out of prep'
    : enabled ? 'Prepped on the line — switch off to keep it out of prep (the recipe stays)'
    : 'Not prepped — switch on to see it in the suggestions'
  return (
    // Name-first layout: no par-level bar and no reason text (unreadable at
    // 9px on narrow panes) — a red triangle by the name flags stock-out, the
    // left stripe carries urgency, and the subtitle keeps category + the
    // on-hand/par numbers, with the numbers never truncating.
    <div
      className={`grid ${onSetPrepEnabled ? 'grid-cols-[minmax(0,1fr)_auto_28px_30px]' : 'grid-cols-[minmax(0,1fr)_auto_28px]'} items-center gap-2 border rounded-[9px] py-2 pr-2 pl-2.5 border-l-[3px] ${item.isOnList || !enabled ? 'bg-bg border-line opacity-60' : 'bg-paper border-line'}`}
      style={{ borderLeftColor: item.isOnList || !enabled ? '#d4d4d8' : m.hex }}
    >
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 text-left">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-[12.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
          {stockOut && (
            <span title="Stock out — 0 on hand" className="inline-flex shrink-0">
              <AlertTriangle size={11} className="text-red" />
            </span>
          )}
          {pipeline && (
            <span title={whyLabel(item)} className="inline-flex items-center gap-1 shrink-0 font-mono text-[8.5px] font-bold uppercase tracking-[0.04em] bg-gold-soft text-gold-2 px-1.5 py-[1px] rounded-full">
              <Flame size={9} /> in flight
            </span>
          )}
          {rhythm && (
            <span title={rhythm} className="inline-flex shrink-0">
              <Clock size={11} className="text-blue-text" />
            </span>
          )}
          {short && (
            <span title={`${item.ingredientShortCount} of ${item.ingredientTotalCount} ingredients short`} className="inline-flex shrink-0">
              <AlertTriangle size={11} className="text-gold-2" />
            </span>
          )}
        </span>
        <span className="flex items-center gap-[7px] mt-0.5 min-w-0" title={whyLabel(item)}>
          <span className="font-mono text-[9px] text-ink-4 min-w-0 truncate">{item.category}{item.station ? ` · ${item.station}` : ''}</span>
          <span className="font-mono text-[9px] text-ink-3 whitespace-nowrap shrink-0">
            {fmtQ(item.onHand ?? 0, item.unit).split(' ')[0]}/{fmtQ(item.parLevel ?? 0, item.unit)}
          </span>
        </span>
      </button>
      <span className="text-right leading-[1.15] whitespace-nowrap">
        <span className={`block font-mono text-[11.5px] font-bold ${sugg > 0 ? 'text-ink' : 'text-green'}`}>
          {sugg <= 0 ? 'at par' : nb ? `${fmtBatch(nb)} batch` : fmtQ(sugg, item.unit)}
        </span>
        {sugg > 0 && nb != null && nb > 0 && (
          <span className="block font-mono text-[8.5px] text-ink-4">{fmtQ(batchesToQty(item, nb), item.unit)}</span>
        )}
        {longLead && sugg > 0 && (
          <span className="block font-mono text-[8.5px] text-blue-text">most that keeps</span>
        )}
      </span>
      {enabled ? (
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
      ) : (
        <span className="w-[26px] h-[26px]" aria-hidden />
      )}
      {onSetPrepEnabled && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={enabled ? 'Prepped on the line' : 'Not prepped'}
          disabled={switchLocked}
          onClick={() => onSetPrepEnabled(item, !enabled)}
          title={switchTitle}
          className={`relative w-[28px] h-[16px] rounded-full border transition-colors justify-self-end ${enabled ? 'bg-green border-green' : 'bg-bg-2 border-line-2'} ${switchLocked ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          <span className={`absolute top-[2px] w-[10px] h-[10px] rounded-full bg-white transition-all ${enabled ? 'left-[14px]' : 'left-[2px]'}`} />
        </button>
      )}
    </div>
  )
}
