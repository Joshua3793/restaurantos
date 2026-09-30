'use client'
// Smart Prep v2 — left-pane suggestion row (design PPSuggRow). The urgency step
// is computed live from stock; the evidence is a stock bar and the on-hand/par
// numbers, written out ("1.9 of 25 kg"), with the plain reason as the tooltip.
import { AlertTriangle, Check, Plus, Flame, Clock } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import {
  PLAN_URG_META, effectiveUrgency, suggestedDraftQty,
  suggestedBatches, batchesToQty, batchCount, fmtBatch, whyLabel, cadenceReason, longLeadQty,
} from '@/lib/prep-plan'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`

/** What the row suggests making — in the "Start today for …" group, the most that will keep. */
export const suggestionQty = (item: PrepItemRich, longLead = false): number =>
  longLead ? longLeadQty(item) : suggestedDraftQty(item)

export function SuggestionRow({ item, locked, longLead = false, onOpen, onAdd, onRemove }: {
  item: PrepItemRich
  locked: boolean
  /** In the "Start today for …" group: the seed is the most that will keep, not the par gap. */
  longLead?: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const sugg = suggestionQty(item, longLead)
  const nb = longLead ? (sugg > 0 ? batchCount(item, sugg) : null) : suggestedBatches(item)
  // The rhythm raised the step (TMRW → CLOSE): a small clock says so.
  const rhythm = cadenceReason(item)
  const short = (item.ingredientShortCount ?? 0) > 0
  // A job in flight is pipeline stock, not a stock-out — the chip replaces the triangle.
  const pipeline = item.pipeline ?? null
  const par = item.parLevel ?? 0
  const onHand = item.onHand ?? 0
  const stockOut = !pipeline && par > 0 && onHand <= 0
  // Switched off the prep list (see the drawer's "Prepped on the line"): dimmed,
  // openable, but never addable from here.
  const enabled = item.prepEnabled !== false
  const onList = item.isOnList
  const pct = par > 0 ? Math.max(0, Math.min(100, (onHand / par) * 100)) : 100
  return (
    // Name-first, and the name wraps rather than truncating. Items already on
    // the list keep full strength and say "On list" (fading them read as
    // disabled); only a switched-off item is dimmed.
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border rounded-[9px] py-2 pr-2 pl-2.5 border-l-[3px] ${!enabled ? 'bg-bg border-line opacity-60' : onList ? 'bg-bg border-line' : 'bg-paper border-line'}`}
      style={{ borderLeftColor: !enabled ? '#d4d4d8' : m.hex }}
    >
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 text-left" title={whyLabel(item)}>
        <span className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <span className="text-[13px] font-semibold tracking-[-0.01em] text-ink break-words min-w-0">{item.name}</span>
          {stockOut && (
            <span title="Out of stock" className="inline-flex shrink-0">
              <AlertTriangle size={11} className="text-red" />
            </span>
          )}
          {pipeline && (
            <span className="inline-flex items-center gap-1 shrink-0 font-mono text-[8.5px] font-bold uppercase tracking-[0.04em] bg-gold-soft text-gold-2 px-1.5 py-[1px] rounded-full">
              <Flame size={9} /> in progress
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
        {/* stock: a bar in the step's colour, then the numbers in words */}
        <span className="flex items-center gap-2 mt-1 min-w-0">
          {par > 0 && (
            <span className="h-[4px] w-[72px] shrink-0 rounded-full bg-bg-2 overflow-hidden" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${Math.max(3, pct)}%`, background: m.hex }} />
            </span>
          )}
          <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">
            {fmtQ(onHand, item.unit).split(' ')[0]} of {fmtQ(par, item.unit)}
          </span>
        </span>
      </button>

      <span className="flex items-center gap-2.5">
        {!onList && (
          <span className="text-right leading-[1.15] whitespace-nowrap">
            <span className={`block font-mono text-[11.5px] font-bold ${sugg > 0 ? 'text-ink' : 'text-green'}`}>
              {sugg <= 0 ? 'at par' : nb ? `${fmtBatch(nb)} batch` : fmtQ(sugg, item.unit)}
            </span>
            {sugg > 0 && nb != null && nb > 0 && (
              <span className="block font-mono text-[9.5px] text-ink-4">{fmtQ(batchesToQty(item, nb), item.unit)}</span>
            )}
            {longLead && sugg > 0 && (
              <span className="block font-mono text-[9px] text-blue-text">most that keeps</span>
            )}
          </span>
        )}
        {!enabled ? (
          <span className="w-7 h-7" aria-hidden />
        ) : onList ? (
          <button
            type="button"
            disabled={locked}
            onClick={() => onRemove(item)}
            title={locked ? 'Pick a revenue center you can edit' : 'On the list — tap to take it off'}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded-full font-mono text-[10px] font-semibold whitespace-nowrap ${locked ? 'bg-bg-2 text-ink-4 cursor-not-allowed' : 'bg-green-soft text-green-text hover:bg-green-soft/70'}`}
          >
            <Check size={12} strokeWidth={2.6} /> On list
          </button>
        ) : (
          <button
            type="button"
            disabled={locked}
            onClick={() => onAdd(item)}
            title={locked ? 'Pick a revenue center you can edit' : 'Add to the prep list'}
            aria-label={`Add ${item.name} to the prep list`}
            // Soft gold, like the To Do's Start — a column of black squares was
            // the loudest thing on the pane.
            className={`w-7 h-7 rounded-[8px] grid place-items-center border shrink-0 ${locked ? 'bg-bg-2 border-line cursor-not-allowed' : 'bg-gold-soft border-gold/40 hover:bg-gold/25'}`}
          >
            <Plus size={14} strokeWidth={2.4} className={locked ? 'text-ink-4' : 'text-gold-2'} />
          </button>
        )}
      </span>
    </div>
  )
}
