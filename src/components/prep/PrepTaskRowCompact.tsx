'use client'
/**
 * PrepTaskRowCompact — mobile-only prep task card, optimised for a chef working
 * from a phone: full item name (never truncated), clear "make X", one priority
 * signal, and large Start/Done + Recipe tap targets on their own row.
 * Same data + handlers as the desktop PrepTaskRow. Rendered under md:hidden.
 */
import { Loader2 } from 'lucide-react'
import { IcPlay, IcCheck, IcUndo, IcSync, IcAlert, IcClock, IcSkip } from '@/components/prep/icons'
import { PrepItemRich, PrepStatus } from '@/components/prep/types'
import { PREP_STATE_META } from '@/lib/prep-utils'

interface Props {
  item: PrepItemRich
  kind?: 'critical' | 'needed' | 'later'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  onOrderStock?: (item: PrepItemRich) => void
}

function fmt(n: number): string {
  const v = Number(n) || 0
  let s: string
  if (v >= 100) s = Math.round(v).toLocaleString()
  else if (v >= 10) s = (Math.round(v * 10) / 10).toString()
  else s = (Math.round(v * 100) / 100).toString()
  return s.replace(/\.0+$/, '')
}

export default function PrepTaskRowCompact({ item, kind, onOpen, onOpenRecipe, onStatusChange }: Props) {
  const status: PrepStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const state = PREP_STATE_META[status].key as 'not-started' | 'in-progress' | 'done' | 'skipped'
  const isCrit = item.priority === '911'
  const needed = kind === 'needed'
  const onHand = Number(item.onHand) || 0
  const par = Number(item.parLevel) || 0
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  // edge + wash + tile glyph by state, then priority
  let edge: string | null = null
  let wash = 'bg-paper'
  let border = 'border-line'
  let tileCls = 'bg-bg-2 text-ink-3'
  let glyph = <IcClock size={18} />
  if (state === 'in-progress') {
    edge = '#2563eb'; wash = 'bg-blue-soft/50'; border = 'border-[#93c5fd]'; tileCls = 'bg-blue text-white'
    glyph = <Loader2 size={18} className="animate-spin" />
  } else if (state === 'done') {
    edge = '#16a34a'; wash = 'bg-paper'; border = 'border-line'; tileCls = 'bg-green text-white'
    glyph = <IcCheck size={19} />
  } else if (state === 'skipped') {
    edge = '#a1a1aa'; wash = 'bg-bg-2/50'; border = 'border-line'; tileCls = 'bg-bg-2 text-ink-4'
    glyph = <IcSkip size={17} />
  } else if (isCrit) {
    edge = '#dc2626'; wash = 'bg-red-soft/40'; border = 'border-[#fca5a5]'; tileCls = 'bg-red-soft text-red'
    glyph = <IcAlert size={18} />
  } else if (needed) {
    edge = '#d97706'; wash = 'bg-gold-soft/40'; border = 'border-[#fcd34d]'; tileCls = 'bg-gold-soft text-gold-2'
    glyph = <IcClock size={18} />
  }

  const isDoneState = state === 'done' || state === 'skipped'
  const qty = `${fmt(Number(item.suggestedQty))} ${item.unit}`

  // meta detail by state
  const detail =
    state === 'in-progress' ? 'prepping now'
    : state === 'done' ? `${fmt(Number(item.todayLog?.actualPrepQty ?? item.suggestedQty))} ${item.unit} made`
    : state === 'skipped' ? 'skipped for today'
    : `${fmt(onHand)} / ${fmt(par)} ${item.unit} on hand`

  return (
    <div
      onClick={() => onOpen(item)}
      className={`${wash} border ${border} rounded-2xl px-3.5 py-3 mb-2.5 cursor-pointer active:scale-[0.99] transition-transform`}
      style={edge ? { borderLeft: `4px solid ${edge}` } : undefined}
    >
      {/* Row 1 — tile + full name (never truncated) */}
      <div className="flex items-start gap-3">
        <span className={`w-10 h-10 rounded-[12px] grid place-items-center shrink-0 ${tileCls}`}>{glyph}</span>
        <div className="flex-1 min-w-0 pt-0.5">
          <h3 className={`text-[15.5px] font-semibold tracking-[-0.01em] leading-[1.25] ${state === 'skipped' ? 'line-through text-ink-3' : 'text-ink'}`}>
            {item.name}
          </h3>
          {/* Row 2 — priority + make + stock */}
          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
            {isCrit && <span className="font-mono text-[9px] font-bold px-2 py-0.5 rounded-full bg-red text-white uppercase tracking-[0.04em]">Critical</span>}
            {!isCrit && needed && <span className="font-mono text-[9px] font-bold px-2 py-0.5 rounded-full bg-gold text-ink uppercase tracking-[0.04em]">Low stock</span>}
            {item.isBlocked && <span className="font-mono text-[9px] font-bold px-2 py-0.5 rounded-full bg-gold-soft text-gold-2 uppercase tracking-[0.04em]">Stock out</span>}
            <span className="font-mono text-[11px] text-ink-3 leading-tight">
              {!isDoneState && <b className="text-ink font-semibold">Make {qty}</b>}
              {!isDoneState && <span className="text-ink-4"> · </span>}
              {detail}
            </span>
          </div>
        </div>
      </div>

      {/* Row 3 — actions (large tap targets, own row so the name has full width) */}
      <div className="mt-3 flex items-center gap-2" onClick={stop}>
        {state === 'not-started' && (
          <button
            onClick={() => onStatusChange(item, 'IN_PROGRESS')}
            className="flex-1 h-11 rounded-xl bg-ink text-paper text-[14px] font-semibold inline-flex items-center justify-center gap-2 active:bg-ink-2"
          >
            <IcPlay size={15} className="text-gold" /> {item.isBlocked ? 'Start anyway' : 'Start prep'}
          </button>
        )}
        {state === 'in-progress' && (
          <button
            onClick={() => onStatusChange(item, 'DONE', item.suggestedQty)}
            className="flex-1 h-11 rounded-xl bg-green text-white text-[14px] font-semibold inline-flex items-center justify-center gap-2"
          >
            <IcCheck size={16} /> Mark done
          </button>
        )}
        {isDoneState && (
          <button
            onClick={() => onStatusChange(item, 'NOT_STARTED')}
            className="flex-1 h-11 rounded-xl bg-paper border border-line text-ink-2 text-[14px] font-semibold inline-flex items-center justify-center gap-2"
          >
            <IcUndo size={15} /> {state === 'skipped' ? 'Restore' : 'Reopen'}
          </button>
        )}

        {item.linkedRecipeId && (
          <button
            onClick={() => onOpenRecipe(item)}
            className="h-11 px-4 rounded-xl bg-paper border border-line text-ink-2 text-[13.5px] font-medium inline-flex items-center gap-2 shrink-0 active:bg-bg-2"
          >
            <span className="w-6 h-6 rounded-[7px] bg-ink text-gold grid place-items-center shrink-0"><IcSync size={13} /></span>
            Recipe
          </button>
        )}
      </div>
    </div>
  )
}
