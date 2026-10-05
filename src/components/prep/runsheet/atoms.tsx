// Prep run-sheet — shared presentational atoms.
// Ported from the prototype (shared.jsx: PTTag, PTNeed, PTDur, PTSegmented) and
// the inline STOCK OUT / BLOCKED pills in desktop.jsx's DRow. Flat Tailwind
// tokens replace the prototype's hex palette; mono via `font-mono`.
import { AlertTriangle, MessageSquareText } from 'lucide-react'
import { fmtMins, fmtClock } from '@/lib/prep-runsheet'
import { effectiveUrgency, whyLabel, fmtDeadline, postedDeadlineMoved } from '@/lib/prep-plan'

// ─── StationTag ──────────────────────────────────────────────────────────
// Small neutral "STATION" chip (PTTag).
export function StationTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[9px] font-medium tracking-[0.04em] uppercase bg-bg-2 text-ink-2 px-[6px] py-[2px] rounded-[4px] whitespace-nowrap">
      {children}
    </span>
  )
}

// ─── StageChip ───────────────────────────────────────────────────────────
// "MIX · 1/5" — where a staged job is in its chain. Blue-grey when the stage
// is unattended (the job is resting), ink+gold when hands-on.
export function StageChip({ label, passive }: { label: string; passive?: boolean }) {
  return (
    <span className={`font-mono text-[9px] font-semibold tracking-[0.04em] uppercase px-[6px] py-[2px] rounded-[4px] whitespace-nowrap ${
      passive ? 'bg-blue-soft text-blue-text' : 'bg-ink text-gold'
    }`}>
      {label}
    </span>
  )
}

// ─── DeadlineChip ────────────────────────────────────────────────────────
// "by 11:00" — the step's deadline for the day (the same number the planner's
// DraftRow showed the chef). When the live step no longer matches what was
// posted (`todayLog.dueTime`, stamped at post), the posted deadline stays
// visible so the row does not silently move under the cook.
// `onlyIfMoved`: the row sits under a section header that already carries the
// deadline, so the chip shows only when the chef's posted deadline really moved.
export function DeadlineChip({ item, onlyIfMoved = false }: { item: import('@/components/prep/types').PrepItemRich; onlyIfMoved?: boolean }) {
  const dl = item.deadlineMinutes
  if (dl == null) return null
  const live = fmtDeadline(dl, fmtClock)
  const posted = item.todayLog?.dueTime ?? null
  const moved = postedDeadlineMoved(live, posted)
  if (onlyIfMoved && !moved) return null
  return (
    <span className="font-mono text-[10px] text-ink-3 whitespace-nowrap">
      by <b className="font-semibold text-ink-2">{live}</b>
      {moved && <span className="text-gold-2"> · posted by {posted}</span>}
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
        {fmtMins(active)} hands-on{passive > 0 ? ` + ${fmtMins(passive)} ${passiveNote || 'rest'}` : ''}
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

// ─── BlockedBadge ────────────────────────────────────────────────────────
// Advisory low-stock pill (DRow: `t.blocked`). It flags the risk (e.g. "LOW
// STOCK: VINEGAR APPLE CIDER") but is NOT a blocker — these items can still be
// started — so it drops the "BLOCKED" wording and the lock icon in favour of a
// warning triangle.
export function BlockedBadge({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[8.5px] font-bold tracking-[0.04em] bg-gold-soft text-gold-2 px-[7px] py-[2px] rounded-full whitespace-nowrap">
      <AlertTriangle size={9} strokeWidth={2.4} />
      {reason.toUpperCase()}
    </span>
  )
}

// ─── ReasonBadge ─────────────────────────────────────────────────────────
// Smart Prep v2: the posted row's stock evidence, tinted by its urgency step
// (replaces the old binary STOCK OUT pill — the reason says WHY, not just that).
//
// NOT used on the run-sheet rows any more. The reason is a full sentence
// ("3 kg of 8 kg par — won't last service") and, pinned nowrap beside the item
// name, it ate the row and ellipsised the ONE thing a cook must always read —
// the name — on iPad and narrow desktop. The rows carry `UrgencyDot` instead
// and the sentence lives in the item drawer. Kept exported for surfaces with
// room for it (and its own tests).
export function ReasonBadge({ item }: { item: import('@/components/prep/types').PrepItemRich }) {
  const u = effectiveUrgency(item)
  const cls =
    u === 'PASS' ? 'bg-red-soft text-red-text'
    : u === 'MID' ? 'bg-gold-soft text-gold-2'
    : 'bg-bg-2 text-ink-3'
  return (
    <span className={`font-mono text-[8.5px] font-bold tracking-[0.04em] px-[7px] py-[2px] rounded-full whitespace-nowrap ${cls}`}>
      {whyLabel(item).toUpperCase()}
    </span>
  )
}

// ─── UrgencyDot ──────────────────────────────────────────────────────────
// The zero-width stand-in for ReasonBadge on a run-sheet row: same urgency
// tint, ~6px wide, with the full reason (plus any low-stock note) as the
// native tooltip. The sentence itself is in the drawer.
export function UrgencyDot({ item }: { item: import('@/components/prep/types').PrepItemRich }) {
  const u = effectiveUrgency(item)
  // TMRW ('at par — building ahead') is the quiet default: no dot, no noise.
  if (u === 'TMRW') return null
  const cls = u === 'PASS' ? 'bg-red' : u === 'MID' ? 'bg-gold' : 'bg-blue'
  const title = item.blockedReason ? `${whyLabel(item)} · ${item.blockedReason}` : whyLabel(item)
  return (
    <span
      title={title}
      aria-label={title}
      className={`w-[6px] h-[6px] rounded-full shrink-0 ${cls}`}
    />
  )
}

// ─── ChefNote ────────────────────────────────────────────────────────────
// The note the chef left on the item in Smart Prep (`todayLog.note`), carried
// onto the To Do row so the cook reads it without opening anything. Same voice
// as the drawer's "Why it's on the list" box: a mono label over plain text, with
// a gold rule on the left — the one accent that says "a person wrote this for
// you". The text wraps in full; it is never truncated. `surface` matches the row
// it sits on (paper ladder row, gold Working On row, ink hero card). Renders
// nothing for an empty or whitespace-only note.
const NOTE_SURFACE = {
  // The box is the rule's own gold, faded — the rule and label stay the
  // strongest mark, the text sits on a lighter wash of the same colour.
  paper: { box: 'bg-gold/[0.10]', label: 'text-gold-2', text: 'text-ink-2' },
  gold: { box: 'bg-gold/[0.14]', label: 'text-gold-2', text: 'text-ink-2' },
  dark: { box: 'bg-gold/[0.16]', label: 'text-gold', text: 'text-[#f4f4f5]' },
} as const

export function ChefNote({
  note,
  compact = false,
  surface = 'paper',
  className = '',
}: {
  note: string | null | undefined
  compact?: boolean
  surface?: keyof typeof NOTE_SURFACE
  className?: string
}) {
  const text = note?.trim()
  if (!text) return null
  const t = NOTE_SURFACE[surface]
  return (
    <div
      className={`w-fit max-w-full md:max-w-[560px] border-l-2 border-gold rounded-r-[7px] ${t.box} ${
        compact ? 'pl-2.5 pr-3 py-[5px]' : 'pl-3 pr-3.5 py-[7px]'
      } ${className}`}
    >
      <div className={`flex items-center gap-1 font-mono text-[9px] font-semibold uppercase tracking-[0.06em] ${t.label}`}>
        <MessageSquareText size={10} strokeWidth={2.4} aria-hidden />
        Chef&apos;s note
      </div>
      <div
        className={`mt-0.5 font-medium leading-snug break-words whitespace-pre-wrap ${t.text} ${
          compact ? 'text-[12.5px]' : 'text-[13px]'
        }`}
      >
        {text}
      </div>
    </div>
  )
}

// ─── RestBar ─────────────────────────────────────────────────────────────
// A resting job's timer as a hairline: blue while resting, green once ready,
// red past the grace. Says "how far along" without another line of words.
export function RestBar({ elapsed, minutes, state }: { elapsed: number; minutes: number; state: 'resting' | 'ready' | 'overdue' }) {
  const pct = minutes > 0 ? Math.min(100, Math.max(3, (elapsed / minutes) * 100)) : 100
  const fill = state === 'overdue' ? 'bg-red' : state === 'ready' ? 'bg-green' : 'bg-blue'
  return (
    <div className="h-[3px] w-full max-w-[260px] rounded-full bg-line overflow-hidden mt-2" aria-hidden>
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
