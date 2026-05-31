'use client'
/**
 * PrepTaskRowCompact — mobile-only compact card for the To-Do list.
 * Same data + handlers as the desktop PrepTaskRow; just a tight, scannable layout
 * so many tasks fit on a phone screen. Rendered under md:hidden; PrepTaskRow stays on desktop.
 */
import { Loader2 } from 'lucide-react'
import { IcPlay, IcCheck, IcUndo, IcSync, IcChevron, IcAlert, IcClock, IcSkip } from '@/components/prep/icons'
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

  // edge + wash + tile by state, then by priority
  let edge: string | null = null
  let wash = 'bg-paper'
  let border = 'border-line'
  let tileCls = 'bg-bg-2 text-ink-3'
  let glyph = <IcClock size={16} />
  if (state === 'in-progress') {
    edge = '#2563eb'; wash = 'bg-blue-soft/50'; border = 'border-[#93c5fd]'; tileCls = 'bg-blue text-white'
    glyph = <Loader2 size={16} className="animate-spin" />
  } else if (state === 'done') {
    edge = '#16a34a'; wash = 'bg-paper'; border = 'border-line'; tileCls = 'bg-green text-white'
    glyph = <IcCheck size={16} />
  } else if (state === 'skipped') {
    edge = '#a1a1aa'; wash = 'bg-bg-2/60'; border = 'border-line'; tileCls = 'bg-bg-2 text-ink-4'
    glyph = <IcSkip size={15} />
  } else if (isCrit) {
    edge = '#dc2626'; wash = 'bg-red-soft/40'; border = 'border-[#fca5a5]'; tileCls = 'bg-red-soft text-red'
    glyph = <IcAlert size={16} />
  } else if (needed) {
    edge = '#d97706'; wash = 'bg-gold-soft/40'; border = 'border-[#fcd34d]'; tileCls = 'bg-gold-soft text-gold-2'
    glyph = <IcClock size={16} />
  }

  const done = state === 'done' || state === 'skipped'

  return (
    <div
      onClick={() => onOpen(item)}
      className={`${wash} border ${border} rounded-xl px-3 py-2.5 mb-2 cursor-pointer`}
      style={edge ? { borderLeft: `4px solid ${edge}` } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className={`w-9 h-9 rounded-[10px] grid place-items-center shrink-0 ${tileCls}`}>{glyph}</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`text-[14.5px] font-semibold tracking-[-0.01em] truncate ${state === 'skipped' ? 'line-through text-ink-3' : 'text-ink'}`}>
              {item.name}
            </span>
            <span className="font-mono text-[11px] font-normal text-ink-3 shrink-0">{fmt(Number(item.suggestedQty))} {item.unit}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            {isCrit && <span className="font-mono text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-red text-white uppercase tracking-[0.04em]">Critical</span>}
            {item.isBlocked && <span className="font-mono text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-gold-soft text-gold-2 uppercase tracking-[0.04em]">Blocked</span>}
            {!isCrit && needed && !item.isBlocked && <span className="font-mono text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-gold text-ink uppercase tracking-[0.04em]">Low stock</span>}
            <span className="font-mono text-[10.5px] text-ink-3 whitespace-nowrap">
              {item.station || item.category}
              {state === 'in-progress' ? ' · prepping' : state === 'done' ? ' · done' : ` · ${fmt(onHand)}/${fmt(par)}`}
            </span>
          </div>
        </div>

        {item.linkedRecipeId && (
          <button
            onClick={(e) => { stop(e); onOpenRecipe(item) }}
            title="View recipe"
            className="shrink-0 w-9 h-9 grid place-items-center rounded-[9px] bg-paper border border-line text-ink-2"
          >
            <span className="w-6 h-6 rounded-[7px] bg-ink text-gold grid place-items-center"><IcSync size={13} /></span>
          </button>
        )}

        <div onClick={stop} className="shrink-0">
          {state === 'not-started' && (
            <button
              onClick={() => onStatusChange(item, 'IN_PROGRESS')}
              className="h-9 px-3 rounded-[9px] bg-ink text-paper text-[12.5px] font-semibold inline-flex items-center gap-1.5"
            >
              <IcPlay size={13} className="text-gold" /> {item.isBlocked ? 'Anyway' : 'Start'}
            </button>
          )}
          {state === 'in-progress' && (
            <button
              onClick={() => onStatusChange(item, 'DONE', item.suggestedQty)}
              className="h-9 px-3 rounded-[9px] bg-green text-white text-[12.5px] font-semibold inline-flex items-center gap-1.5"
            >
              <IcCheck size={13} /> Done
            </button>
          )}
          {done && (
            <button
              onClick={() => onStatusChange(item, 'NOT_STARTED')}
              className="h-9 w-9 grid place-items-center rounded-[9px] bg-paper border border-line text-ink-3"
              title={state === 'skipped' ? 'Restore' : 'Reopen'}
            >
              <IcUndo size={15} />
            </button>
          )}
        </div>
        {!item.linkedRecipeId && <IcChevron size={14} className="text-ink-4 shrink-0" />}
      </div>
    </div>
  )
}
