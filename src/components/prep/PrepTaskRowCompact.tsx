'use client'
/**
 * PrepTaskRowCompact — dense, mobile-only prep row. Optimised so a chef sees MANY
 * items at once; tapping a row opens the detail drawer (recipe cook-along, start,
 * mark done, log, skip). No inline action buttons — interaction reveals actions.
 * Rendered under md:hidden; the desktop renderer is PrepBoard (board/PrepRow).
 */
import { Loader2 } from 'lucide-react'
import { IcCheck, IcAlert, IcClock, IcSkip, IcPlay, IcUndo, IcRecipe } from '@/components/prep/icons'
import { PrepItemRich, PrepStatus } from '@/components/prep/types'
import { PREP_STATE_META } from '@/lib/prep-utils'

interface Props {
  item: PrepItemRich
  kind?: 'critical' | 'needed' | 'later'
  onOpen: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
  onStatusChange: (item: PrepItemRich, status: PrepStatus, actualQty?: number) => void
  /** One-tap "Mark done" on an in-progress row: pops the yield prompt directly (no full drawer). */
  onQuickDone: (item: PrepItemRich) => void
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

export default function PrepTaskRowCompact({ item, kind, onOpen, onOpenRecipe, onStatusChange, onQuickDone }: Props) {
  const status: PrepStatus = item.todayLog?.status ?? 'NOT_STARTED'
  const state = PREP_STATE_META[status].key as 'not-started' | 'in-progress' | 'done' | 'skipped'
  const isCrit = item.priority === '911'
  const needed = kind === 'needed'
  const onHand = Number(item.onHand) || 0
  const par = Number(item.parLevel) || 0
  const qty = `${fmt(Number(item.suggestedQty))} ${item.unit}`

  // edge + tile glyph by state, then priority
  let edge: string | null = null
  let tileCls = 'bg-bg-2 text-ink-3'
  let glyph = <IcClock size={16} />
  if (state === 'in-progress') {
    edge = '#2563eb'; tileCls = 'bg-blue text-white'; glyph = <Loader2 size={15} className="animate-spin" />
  } else if (state === 'done') {
    edge = '#16a34a'; tileCls = 'bg-green text-white'; glyph = <IcCheck size={16} />
  } else if (state === 'skipped') {
    edge = '#a1a1aa'; tileCls = 'bg-bg-2 text-ink-4'; glyph = <IcSkip size={15} />
  } else if (isCrit) {
    edge = '#dc2626'; tileCls = 'bg-red-soft text-red'; glyph = <IcAlert size={16} />
  } else if (needed) {
    edge = '#d97706'; tileCls = 'bg-gold-soft text-gold-2'; glyph = <IcClock size={16} />
  }

  const isDoneState = state === 'done' || state === 'skipped'
  const meta =
    state === 'in-progress' ? `Prepping · make ${qty}`
    : state === 'done' ? `Done · ${fmt(Number(item.todayLog?.actualPrepQty ?? item.suggestedQty))} ${item.unit} made`
    : state === 'skipped' ? 'Skipped for today'
    : `Make ${qty} · ${fmt(onHand)}/${fmt(par)} on hand`

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full text-left flex items-center gap-2.5 bg-paper border border-line rounded-xl pl-2.5 pr-2.5 py-2 mb-1.5 active:bg-bg-2 transition-colors"
      style={edge ? { borderLeftWidth: 4, borderLeftColor: edge } : undefined}
    >
      <span className={`w-8 h-8 rounded-[9px] grid place-items-center shrink-0 ${tileCls}`}>{glyph}</span>

      <div className="flex-1 min-w-0">
        <div className={`text-[14px] font-semibold tracking-[-0.01em] leading-tight truncate ${state === 'skipped' ? 'line-through text-ink-3' : 'text-ink'}`}>
          {item.name}
        </div>
        <div className="font-mono text-[10.5px] leading-tight truncate mt-0.5">
          {item.isBlocked && !isDoneState && <span className="text-gold-2 font-bold uppercase tracking-[0.03em]">Stock out · </span>}
          <span className="text-ink-3">{meta}</span>
        </div>
      </div>

      {item.linkedRecipeId && (
        <span
          role="button"
          tabIndex={0}
          title="View recipe"
          onClick={(e) => { e.stopPropagation(); onOpenRecipe(item) }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenRecipe(item) } }}
          className="w-9 h-9 rounded-[10px] grid place-items-center shrink-0 bg-paper border border-line text-ink-2 active:scale-95"
        >
          <IcRecipe size={16} />
        </span>
      )}
      {(() => {
        // In-progress completion pops the yield prompt directly (PrepDoneSheet) so the
        // chef confirms the actual qty made without the full drawer detour, while still
        // never silently logging the suggested qty. Start / Reopen stay one-tap.
        const inProgress = state === 'in-progress'
        const cls = inProgress ? 'bg-green text-white' : isDoneState ? 'bg-paper border border-line text-ink-3' : 'bg-ink text-gold'
        const Icon = inProgress ? IcCheck : isDoneState ? IcUndo : IcPlay
        const label = inProgress ? 'Mark done' : isDoneState ? 'Reopen' : item.isBlocked ? 'Start anyway' : 'Start prep'
        const act = () => { if (inProgress) onQuickDone(item); else onStatusChange(item, isDoneState ? 'NOT_STARTED' : 'IN_PROGRESS') }
        return (
          <span
            role="button"
            tabIndex={0}
            title={label}
            onClick={(e) => { e.stopPropagation(); act() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); act() } }}
            className={`w-9 h-9 rounded-[10px] grid place-items-center shrink-0 active:scale-95 ${cls}`}
          >
            <Icon size={16} />
          </span>
        )
      })()}
    </button>
  )
}
