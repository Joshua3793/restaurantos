'use client'
/**
 * PrepTaskRowCompact — dense, mobile-only prep row. Optimised so a chef sees MANY
 * items at once; tapping a row opens the detail drawer (recipe cook-along, start,
 * mark done, log, skip). No inline action buttons — interaction reveals actions.
 * Same data + handlers as the desktop PrepTaskRow. Rendered under md:hidden.
 */
import { Loader2 } from 'lucide-react'
import { IcCheck, IcAlert, IcClock, IcSkip, IcChevron } from '@/components/prep/icons'
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

export default function PrepTaskRowCompact({ item, kind, onOpen }: Props) {
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
        <div className="font-mono text-[10.5px] text-ink-3 leading-tight truncate mt-0.5">{meta}</div>
      </div>

      {item.isBlocked && !isDoneState && (
        <span className="font-mono text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-gold-soft text-gold-2 uppercase tracking-[0.03em] shrink-0">Stock out</span>
      )}
      <IcChevron size={15} className="text-ink-4 shrink-0" />
    </button>
  )
}
