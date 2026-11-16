'use client'
// Smart Prep — one row of the prep list, five kinds (see rowKind in
// src/lib/prep-smart.ts). The reason is always written on the row, never only in
// a tooltip; a wrong par is flagged with a fix, never acted on.
//
// No `block` / `row` class names here: the prep page's `.pb` stylesheet paints
// those as cards (src/app/prep/prep-board.css).
import { useState } from 'react'
import { Check, Plus } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import {
  effectiveUrgency, suggestedBatches, batchesToQty, batchCount, fmtBatch,
  plainReason, whyLabel, longLeadQty, suggestedDraftQty, draftQty, batchYield, mustStartToday,
  ladderTimes, fmtDeadlineWords, type PlanDayContext,
} from '@/lib/prep-plan'
import { fmtClock } from '@/lib/prep-runsheet'
import { fmtAmount, fmtAmountOf } from '@/lib/prep-amount'
import { parFlag, PAR_MAX_BATCHES, type RowKind } from '@/lib/prep-smart'
import { ParEditor } from './ParEditor'

const STEP_WORD = { PASS: 'Critical', MID: 'Mid-service', CLOSE: 'Before close', TMRW: 'Tomorrow' } as const

const half = (n: number) => (n === 0.5 ? '½' : n % 1 === 0.5 ? `${Math.floor(n)}½` : String(+n.toFixed(2)))
/** "1 batch", "1½ batch", "2 batches" */
export const batchWords = (n: number) => `${half(n)} ${n > 1 ? 'batches' : 'batch'}`

/** What this row would make: batches when the recipe gives a usable yield. */
function amountOf(item: PrepItemRich, qty: number): { big: string; small: string | null } {
  if (!(qty > 0)) return { big: '—', small: null }
  const nb = batchYield(item) != null ? batchCount(item, qty) : null
  return nb != null && nb > 0
    ? { big: batchWords(nb), small: fmtAmount(qty, item.unit) }
    : { big: fmtAmount(qty, item.unit), small: null }
}

/** The flag sentence for a wrong or missing par. */
function flagReason(item: PrepItemRich): string {
  const f = parFlag(item)
  if (f === 'NONE') return `${fmtAmount(item.onHand ?? 0, item.unit)} on hand · never suggested until it has a par`
  const y = batchYield(item)
  const par = item.parLevel ?? 0
  if (y && par / y > PAR_MAX_BATCHES) {
    return `Par is ${fmtAmount(par, item.unit)} — that would be ${Math.round(par / y)} batches. One batch makes ${fmtAmount(y, item.unit)}.`
  }
  return `Par is ${fmtAmount(par, item.unit)} — less than one spoon`
}

/** The whole name + reason area opens the item — a 44 px target, not just the words. */
function RowLeft({ item, onOpen, children }: { item: PrepItemRich; onOpen: (item: PrepItemRich) => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={() => onOpen(item)} title={whyLabel(item)}
      className="min-w-0 min-h-[44px] flex flex-col justify-center text-left">
      {children}
    </button>
  )
}

function Flag({ tone, children }: { tone: 'bad' | 'neutral' | 'info' | 'warn'; children: React.ReactNode }) {
  const cls = {
    bad: 'bg-red-soft text-red-text',
    neutral: 'bg-bg-2 text-ink-2',
    info: 'bg-blue-soft text-blue-text',
    warn: 'bg-gold-soft text-gold-2',
  }[tone]
  return <span className={`inline-flex items-center shrink-0 whitespace-nowrap rounded-full px-2 py-[2px] text-[11.5px] font-semibold ${cls}`}>{children}</span>
}

export function PrepRow({
  item, kind, ctx, nowMin, locked, canFixPar, compact = false, onOpen, onAdd, onRemove, onFixPar,
}: {
  item: PrepItemRich
  kind: RowKind
  ctx: PlanDayContext | null
  nowMin: number
  locked: boolean
  canFixPar: boolean
  /** phone: 44 px targets, tighter padding */
  compact?: boolean
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
  onFixPar: (item: PrepItemRich, parLevel: number) => Promise<boolean>
}) {
  const [fixing, setFixing] = useState(false)
  const enabled = item.prepEnabled !== false
  const pad = compact ? 'px-3.5' : 'px-4'
  const addSize = compact ? 'w-11 h-11' : 'w-11 h-11'
  const name = <span className="min-w-0 text-[14px] font-semibold tracking-[-0.012em] text-ink break-words">{item.name}</span>

  // ── at par: one quiet line, + still adds it ──
  if (kind === 'ATPAR') {
    return (
      <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 ${pad} py-1.5 border-t border-line ${enabled ? '' : 'opacity-60'}`}>
        <button type="button" onClick={() => onOpen(item)} title={whyLabel(item)}
          className="min-w-0 min-h-[44px] text-left text-[13.5px] font-medium text-ink-2 break-words">{item.name}</button>
        <span className="flex flex-col items-end font-mono text-[12.5px] font-medium text-ink-2 whitespace-nowrap leading-tight">
          {(item.parLevel ?? 0) > 0 ? fmtAmountOf(item.onHand ?? 0, item.parLevel ?? 0, item.unit) : fmtAmount(item.onHand ?? 0, item.unit)}
          <span className="text-[11px] font-semibold text-green-text">at par</span>
        </span>
        {enabled ? (
          <button type="button" disabled={locked} onClick={() => onAdd(item)} aria-label={`Add ${item.name}`}
            title={locked ? 'Pick a revenue center you can edit' : 'Add anyway'}
            className={`${compact ? 'w-11 h-11' : 'w-10 h-10'} rounded-[9px] grid place-items-center border border-line bg-paper shrink-0 ${locked ? 'cursor-not-allowed opacity-50' : 'hover:border-ink-3'}`}>
            <Plus size={16} strokeWidth={2.2} className="text-ink-3" />
          </button>
        ) : <span className="w-10" aria-hidden />}
      </div>
    )
  }

  // ── cooking: gold row, read only ──
  if (kind === 'COOKING') {
    return (
      <div className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 ${pad} py-2.5 border-t border-line bg-gold-soft`}>
        <RowLeft item={item} onOpen={onOpen}>
          <span className="flex flex-wrap items-center gap-1.5">{name}</span>
          <span className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">{plainReason(item).replace(/^In progress/, 'Cooking now')}</span>
        </RowLeft>
        <span className="inline-flex items-center h-9 px-3 rounded-full bg-paper text-gold-2 text-[12.5px] font-semibold whitespace-nowrap">Cooking</span>
      </div>
    )
  }

  // ── flagged par ──
  if (kind === 'FLAG') {
    const f = parFlag(item)
    return (
      <div className={`relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 ${pad} py-2.5 border-t border-line ${f === 'WRONG' ? 'bg-[#fffafa]' : ''}`}>
        <RowLeft item={item} onOpen={onOpen}>
          <span className="flex flex-wrap items-center gap-1.5">
            {name}
            <Flag tone={f === 'WRONG' ? 'bad' : 'neutral'}>{f === 'WRONG' ? 'Par looks wrong' : 'No par set'}</Flag>
          </span>
          <span className="text-[12.5px] text-ink-2 mt-0.5 leading-snug">{flagReason(item)}</span>
        </RowLeft>
        {canFixPar && enabled && item.linkedRecipeId ? (
          <span className="relative">
            <button type="button" disabled={locked} onClick={() => setFixing(v => !v)}
              className={`inline-flex items-center ${compact ? 'h-11' : 'h-9'} px-3 rounded-[9px] border border-line-2 bg-paper text-[13px] font-semibold text-ink-2 whitespace-nowrap ${locked ? 'cursor-not-allowed opacity-50' : 'hover:border-ink-3'}`}>
              {f === 'WRONG' ? 'Fix par' : 'Set par'}
            </button>
            {fixing && <ParEditor item={item} onSave={p => onFixPar(item, p)} onClose={() => setFixing(false)} />}
          </span>
        ) : <span />}
      </div>
    )
  }

  // ── to make / on your list ──
  const longLead = kind === 'MAKE' && mustStartToday(item, ctx, nowMin)
  const qty = kind === 'LISTED' ? draftQty(item) : longLead ? longLeadQty(item) : suggestedDraftQty(item)
  const nb = kind === 'MAKE' && !longLead ? suggestedBatches(item) : null
  const amt = nb != null && nb > 0 ? { big: batchWords(nb), small: fmtAmount(batchesToQty(item, nb), item.unit) } : amountOf(item, qty)
  const step = STEP_WORD[effectiveUrgency(item)]
  const reason = longLead && ctx
    ? `Needed ${fmtDeadlineWords(ladderTimes(item, ctx).deadline ?? 0, fmtClock)} · ${fmtAmountOf(item.onHand ?? 0, item.parLevel ?? 0, item.unit)}`
    : kind === 'MAKE' ? `${plainReason(item)} · ${step}` : plainReason(item)
  const out = !item.pipeline && (item.parLevel ?? 0) > 0 && (item.onHand ?? 0) <= 0
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 ${pad} py-2.5 border-t border-line`}>
      <RowLeft item={item} onOpen={onOpen}>
        <span className="flex flex-wrap items-center gap-1.5">
          {name}
          {longLead && <Flag tone="info">Start today</Flag>}
        </span>
        <span className={`text-[12.5px] mt-0.5 leading-snug ${out ? 'text-red-text font-medium' : 'text-ink-2'}`}>{reason}</span>
      </RowLeft>
      <span className="flex flex-col items-end max-w-[120px] text-right font-mono text-[13px] font-semibold text-ink leading-tight">
        <span className="whitespace-nowrap">{amt.big}</span>
        {amt.small && <span className="text-[11px] font-normal text-ink-3 mt-0.5 whitespace-nowrap">{amt.small}</span>}
        {longLead && <span className="text-[11px] font-normal text-blue-text mt-0.5">most that keeps</span>}
      </span>
      {kind === 'LISTED' ? (
        <button type="button" disabled={locked} onClick={() => onRemove(item)}
          title={locked ? 'Pick a revenue center you can edit' : 'On your list — tap to take it off'}
          className={`inline-flex items-center gap-1 ${compact ? 'h-11' : 'h-9'} px-3 rounded-full text-[12.5px] font-semibold whitespace-nowrap ${locked ? 'bg-bg-2 text-ink-3 cursor-not-allowed' : 'bg-green-soft text-green-text'}`}>
          <Check size={13} strokeWidth={2.6} /> On your list
        </button>
      ) : (
        <button type="button" disabled={locked || !enabled} onClick={() => onAdd(item)} aria-label={`Add ${item.name}`}
          title={locked ? 'Pick a revenue center you can edit' : 'Add to your list'}
          className={`${addSize} rounded-[10px] grid place-items-center border shrink-0 ${locked || !enabled ? 'bg-bg-2 border-line cursor-not-allowed' : 'bg-gold-soft border-[#fcd34d] hover:bg-[#fde68a]'}`}>
          <Plus size={18} strokeWidth={2.4} className={locked || !enabled ? 'text-ink-3' : 'text-gold-2'} />
        </button>
      )}
    </div>
  )
}
