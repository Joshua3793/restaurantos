'use client'
import { useRef } from 'react'
import { Check, MoreHorizontal } from 'lucide-react'
import type { LineView } from '@/lib/checklists/runs'
import { pacificHHMM } from '@/lib/checklists/rules'

// One job on the cook's list. TICK rows tick on tap (optimistic, in the page);
// NUMBER/TEMP rows open the log sheet; "⋯" or a long-press opens the sheet on
// a TICK row so it can be flagged. Rows in a signed-off run are not tappable.

/** A line as the screen draws it. */
export type RowLine = LineView

/** "Leo Martin" / "leo@x.com" → "Leo" / "leo". */
export function firstName(s: string | null | undefined): string {
  if (!s) return ''
  return s.split('@')[0].trim().split(/\s+/)[0] ?? ''
}

/** The unit a reading is shown in. TEMP lines without a unit read in °C. */
export function unitOf(line: Pick<LineView, 'answer' | 'unit'>): string {
  return line.unit?.trim() || (line.answer === 'TEMP' ? '°C' : '')
}

export function fmtReading(value: number, unit: string): string {
  return unit ? `${value} ${unit}` : String(value)
}

/** "0–4 °C", "60 °C or more", "4 °C or less", or '' with no range. */
export function rangeText(min: number | null, max: number | null, unit: string): string {
  const u = unit ? ` ${unit}` : ''
  if (min != null && max != null) return `${min}–${max}${u}`
  if (min != null) return `${min}${u} or more`
  if (max != null) return `${max}${u} or less`
  return ''
}

const hhmm = (iso: string | null) => (iso ? pacificHHMM(new Date(iso)) : '')

const FLAG_WORD: Record<NonNullable<LineView['flagReason']>, string> = {
  BROKEN: 'Broken',
  RAN_OUT: 'Ran out',
  OUT_OF_RANGE: 'Out of range',
  OTHER: 'Other',
}

/** The mono line under the title: who · time · value, the flag, or the job's meta. */
export function subLine(line: LineView): string {
  const unit = unitOf(line)
  const who = firstName(line.doneByName)
  const time = hhmm(line.doneAt)
  if (line.status === 'DONE') {
    return [line.value != null ? fmtReading(line.value, unit) : '', who, time].filter(Boolean).join(' · ')
  }
  if (line.status === 'FLAGGED') {
    const parts = [
      'Flagged',
      line.flagReason ? FLAG_WORD[line.flagReason] : '',
      line.value != null ? fmtReading(line.value, unit) : '',
      line.flagNote ? `“${line.flagNote}”` : '',
      who,
      time,
    ]
    if (line.resolvedAt) parts.push(`fixed by ${firstName(line.resolvedByName) || 'a lead'}`)
    return parts.filter(Boolean).join(' · ')
  }
  const range = line.answer !== 'TICK' ? rangeText(line.safeMin, line.safeMax, unit) : ''
  return [range ? `Safe ${range}` : '', line.howTo?.split('\n')[0] ?? ''].filter(Boolean).join(' · ')
}

const LONG_PRESS_MS = 500

export function LineRow({
  line,
  shared,
  locked,
  busy,
  onTap,
  onMore,
}: {
  line: RowLine
  /** A whole-kitchen line merged into this card: shows the KITCHEN pill. */
  shared: boolean
  /** The line's run is signed off: nothing is tappable. */
  locked: boolean
  /** A save for this line is still in flight: dimmed, taps ignored. */
  busy: boolean
  onTap: (line: RowLine) => void
  onMore: (line: RowLine) => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longFired = useRef(false)
  const isTick = line.answer === 'TICK'
  const done = line.status === 'DONE'
  const flagged = line.status === 'FLAGGED'
  const urgent = line.isBlocker && line.status === 'TODO'
  const sub = subLine(line)

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const startPress = () => {
    longFired.current = false
    if (!isTick || locked || busy) return
    clearTimer()
    timer.current = setTimeout(() => {
      longFired.current = true
      onMore(line)
    }, LONG_PRESS_MS)
  }
  const click = () => {
    clearTimer()
    if (longFired.current) { longFired.current = false; return }
    if (!locked && !busy) onTap(line)
  }

  const box = done
    ? 'bg-green border-[1.5px] border-green text-white'
    : flagged
      ? 'bg-red-soft border-[1.5px] border-red text-red-text'
      : urgent
        ? 'bg-paper border-2 border-red'
        : 'bg-paper border-[1.5px] border-line-2'
  const title = done
    ? 'text-ink-3 line-through font-medium'
    : urgent
      ? 'text-red-text font-semibold'
      : 'text-ink font-medium'
  const subTone = done ? 'text-green-text' : flagged ? 'text-red-text' : 'text-ink-3'

  return (
    <div className={`flex items-center border-t border-bg-2 transition-opacity ${busy ? 'opacity-50' : ''}`} aria-busy={busy || undefined}>
      <button
        type="button"
        onClick={click}
        onPointerDown={startPress}
        onPointerUp={clearTimer}
        onPointerLeave={clearTimer}
        onPointerCancel={clearTimer}
        onContextMenu={e => { if (isTick && !locked) e.preventDefault() }}
        disabled={locked}
        aria-pressed={isTick ? done : undefined}
        className="flex-1 min-w-0 flex items-center gap-3 pl-4 pr-2 py-2.5 min-h-[58px] text-left select-none [-webkit-touch-callout:none] disabled:cursor-default"
      >
        <span className={`flex-none w-[26px] h-[26px] rounded-[7px] grid place-items-center box-border font-mono text-[14px] font-semibold ${box}`}>
          {done && <Check size={16} strokeWidth={3} aria-hidden />}
          {flagged && '!'}
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-[3px]">
          <span className={`text-[15px] leading-[1.3] tracking-[-0.01em] ${title}`}>{line.title}</span>
          {sub && <span className={`font-mono text-[10.5px] leading-[1.4] truncate ${subTone}`}>{sub}</span>}
        </span>
        {shared && <Pill>KITCHEN</Pill>}
        {flagged && <Pill tone="red">FLAGGED</Pill>}
        {!isTick && line.status === 'TODO' && !locked && (
          <span className="font-mono text-[11px] font-medium px-[11px] py-[7px] rounded-full border border-line-2 text-ink whitespace-nowrap">
            Log {unitOf(line) || 'it'}
          </span>
        )}
      </button>
      {isTick && !locked && (
        <button
          type="button"
          onClick={() => { if (!busy) onMore(line) }}
          aria-label={`More for ${line.title}`}
          className="flex-none w-11 min-h-[58px] grid place-items-center text-ink-3 mr-1"
        >
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  )
}

export function Pill({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'grey' | 'red' | 'blue' | 'green' }) {
  const cls = tone === 'red'
    ? 'bg-red-soft text-red-text'
    : tone === 'blue'
      ? 'bg-blue-soft text-blue-text'
      : tone === 'green'
        ? 'bg-green-soft text-green-text'
        : 'bg-bg-2 text-ink-2'
  return (
    <span className={`flex-none font-mono text-[10px] font-medium px-2 py-[3px] rounded-full whitespace-nowrap ${cls}`}>
      {children}
    </span>
  )
}
