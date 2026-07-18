// Prep run-sheet — shared presentational atoms.
// Ported from the prototype (shared.jsx: PTTag, PTNeed, PTDur, PTSegmented) and
// the inline STOCK OUT / BLOCKED pills in desktop.jsx's DRow. Flat Tailwind
// tokens replace the prototype's hex palette; mono via `font-mono`.
import { Lock } from 'lucide-react'
import { fmtDuration, fmtClock } from '@/lib/prep-runsheet'

// ─── StationTag ──────────────────────────────────────────────────────────
// Small neutral "STATION" chip (PTTag).
export function StationTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9px] font-medium tracking-[0.04em] uppercase bg-bg-2 text-ink-2 px-[6px] py-[2px] rounded-[4px] whitespace-nowrap">
      {children}
    </span>
  )
}

// ─── NeedChip ────────────────────────────────────────────────────────────
// "→ LUNCH 11:30" — which service a task must be ready for, and when (PTNeed).
export function NeedChip({ service }: { service: { name: string; timeMinutes: number } | null }) {
  if (!service) return null
  return (
    <span className="font-mono text-[10px] text-ink-2 whitespace-nowrap">
      → <b className="font-semibold uppercase">{service.name}</b> {fmtClock(service.timeMinutes)}
    </span>
  )
}

// ─── RunwayBar ───────────────────────────────────────────────────────────
// Hands-on (solid) + passive (striped) runway bar + "45m hands-on + 30m cool"
// caption (PTDur). Renders nothing when both durations are unknown.
export function RunwayBar({
  activeMin,
  passiveMin,
  passiveNote,
}: {
  activeMin: number | null
  passiveMin: number | null
  passiveNote?: string | null
}) {
  if (activeMin == null && passiveMin == null) return null
  const active = activeMin ?? 0
  const passive = passiveMin ?? 0
  const total = active + passive
  const barWidth = Math.min(110, 24 + total * 0.2)
  const activeWidth = total > 0 ? Math.max(6, (active / total) * barWidth) : 0
  return (
    <span className="inline-flex items-center gap-[7px] min-w-0">
      <span
        className="inline-flex h-[5px] rounded-full overflow-hidden shrink-0 bg-bg-2"
        style={{ width: barWidth }}
      >
        <span className="bg-ink-2" style={{ width: activeWidth }} />
        {passive > 0 && (
          <span className="flex-1 bg-[repeating-linear-gradient(135deg,#d4d4d8_0_3px,#f4f4f5_3px_6px)]" />
        )}
      </span>
      <span className="font-mono text-[10px] text-ink-3 whitespace-nowrap">
        {fmtDuration(active)} hands-on{passive > 0 ? ` + ${fmtDuration(passive)} ${passiveNote || 'rest'}` : ''}
      </span>
    </span>
  )
}

// ─── Segmented ───────────────────────────────────────────────────────────
export interface SegmentedOption<T extends string> {
  id: T
  label: React.ReactNode
  badge?: React.ReactNode
  badgeTone?: 'red' | 'neutral'
}

export function Segmented<T extends string>({
  value,
  options,
  onPick,
  className,
}: {
  value: T
  options: SegmentedOption<T>[]
  onPick: (id: T) => void
  className?: string
}) {
  return (
    <div className={`flex bg-bg-2 border border-line rounded-[11px] p-[3px] gap-0.5 ${className ?? ''}`}>
      {options.map(o => {
        const on = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onPick(o.id)}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-[7px] rounded-[8px] whitespace-nowrap text-[12.5px] tracking-[-0.01em] transition-colors ${
              on ? 'bg-paper text-ink font-semibold shadow-sm' : 'bg-transparent text-ink-3 font-medium'
            }`}
          >
            {o.label}
            {o.badge != null && (
              <span
                className={`font-mono text-[9px] font-bold px-[5px] rounded-full leading-[13px] ${
                  o.badgeTone === 'red' ? 'bg-red text-white' : 'bg-bg-2 text-ink-3'
                }`}
              >
                {o.badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── StockOutBadge ───────────────────────────────────────────────────────
// The small "STOCK OUT" pill shown inline next to a critical-priority row's
// name (DRow: `t.prio === 'critical'`).
export function StockOutBadge() {
  return (
    <span className="font-mono text-[8.5px] font-bold tracking-[0.04em] bg-red-soft text-red-text px-[6px] py-[2px] rounded-full whitespace-nowrap">
      STOCK OUT
    </span>
  )
}

// ─── BlockedBadge ────────────────────────────────────────────────────────
// The small lock + "BLOCKED · reason" pill (DRow: `t.blocked`).
export function BlockedBadge({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-[0.04em] bg-gold-soft text-gold-2 px-[7px] py-[2px] rounded-full whitespace-nowrap">
      <Lock size={9} strokeWidth={2.4} />
      BLOCKED · {reason.toUpperCase()}
    </span>
  )
}
