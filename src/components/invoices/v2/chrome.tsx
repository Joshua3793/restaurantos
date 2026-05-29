'use client'
// Drawer "chrome" — the brand surfaces that frame the review pane:
// cost-impact strip (Principle 01), the totals-tie alert banner, the review
// progress header, and the section dividers.

import { AlertTriangle } from 'lucide-react'
import { Segmented } from './atoms'

// ─── ImpactStrip ───────────────────────────────────────────────────────────────
// "Cost is chrome" — the dark strip directly under the header summarising what
// approving will write. Only metrics we can compute pre-approve are shown.

export interface ImpactMetric {
  label: string
  value: string
  tone?: 'warn' | 'bad' | 'ok'
}

export function ImpactStrip({
  metrics,
  helper,
}: {
  metrics: ImpactMetric[]
  helper?: React.ReactNode
}) {
  const toneCls = (t?: ImpactMetric['tone']) =>
    t === 'warn' ? 'text-[#fcd34d]' : t === 'bad' ? 'text-[#fca5a5]' : t === 'ok' ? 'text-green' : 'text-bg'

  return (
    <div className="flex items-center gap-[18px] bg-ink text-bg px-[22px] py-[11px] overflow-x-auto">
      {metrics.map((m, i) => (
        <div key={m.label} className="flex items-center gap-[18px] shrink-0">
          {i > 0 && <span className="w-px h-3.5 bg-ink-2" />}
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-ink-4">{m.label}</span>
            <span className={`font-mono text-[13.5px] font-semibold tabular-nums ${toneCls(m.tone)}`}>{m.value}</span>
          </div>
        </div>
      ))}
      <span className="flex-1" />
      {helper && <span className="font-mono text-[10.5px] text-ink-3 shrink-0">{helper}</span>}
    </div>
  )
}

// ─── AlertBanner ───────────────────────────────────────────────────────────────
// Gold-soft full-width bar. Only rendered for invoice-wide issues (e.g. the
// sum-of-lines / subtotal mismatch).

export function AlertBanner({
  children,
  onIgnore,
  onShowFix,
  showFixLabel = 'Show suggested fix',
}: {
  children: React.ReactNode
  onIgnore?: () => void
  onShowFix?: () => void
  showFixLabel?: string
}) {
  return (
    <div className="flex items-center gap-3 bg-gold-soft border-b border-[#fcd34d]/60 px-[22px] py-[11px] text-[13px] text-gold-2">
      <AlertTriangle size={16} className="text-gold-2 shrink-0" strokeWidth={2.2} />
      <span className="flex-1 min-w-0">{children}</span>
      <div className="flex gap-1.5 shrink-0">
        {onIgnore && (
          <button
            type="button"
            onClick={onIgnore}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2/10 text-gold-2 hover:bg-gold-2/20 transition-colors"
          >
            Ignore for now
          </button>
        )}
        {onShowFix && (
          <button
            type="button"
            onClick={onShowFix}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2 text-paper hover:bg-gold-2 transition-colors"
          >
            {showFixLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── ReviewProgress ──────────────────────────────────────────────────────────
// "X of N resolved" + gold progress bar + All / Issues / Matched segmented filter.

export type ReviewSegment = 'all' | 'issues' | 'matched'

export function ReviewProgress({
  resolved,
  total,
  segment,
  onSegment,
  counts,
}: {
  resolved: number
  total: number
  segment: ReviewSegment
  onSegment: (s: ReviewSegment) => void
  counts: { all: number; issues: number; matched: number }
}) {
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 100
  return (
    <div className="flex items-center gap-3 px-[22px] py-3.5 bg-paper border-b border-line">
      <span className="font-mono text-[11px] font-semibold text-ink-2 shrink-0 tabular-nums">
        {total > 0 ? `${resolved} of ${total} resolved` : 'All matched'}
      </span>
      <div className="flex-1 h-1 rounded-full bg-bg-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <Segmented<ReviewSegment>
        value={segment}
        onChange={onSegment}
        options={[
          { value: 'all',     label: `All ${counts.all}` },
          { value: 'issues',  label: `Issues ${counts.issues}` },
          { value: 'matched', label: `Matched ${counts.matched}` },
        ]}
      />
    </div>
  )
}

// ─── SectionDivider ──────────────────────────────────────────────────────────

export function SectionDivider({
  tone,
  label,
  count,
}: {
  tone: 'red' | 'green' | 'neutral'
  label: string
  count?: string
}) {
  const dotCls = tone === 'red' ? 'bg-red' : tone === 'green' ? 'bg-green' : 'bg-ink-4'
  return (
    <div className="flex items-center gap-2.5 pt-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      <span>{label}</span>
      {count && <span className="text-ink-4 font-medium normal-case tracking-normal">· {count}</span>}
      <span className="flex-1 h-px bg-line" />
    </div>
  )
}
