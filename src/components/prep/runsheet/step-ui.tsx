'use client'
// Prep To Do — the step-flow parts every job surface shares (job cards, the
// alarm banner, the drawer's cook mode).
//
// The visual language (design board: https://claude.ai/artifact/XoEFyrr2PTyWdBX32gRpPh):
//   square  = a hands-on step   · dashed capsule = a wait (longer wait, longer capsule)
//   green   = done / wait over  · ringed = where the job is now
// and the Next button's LOOK says what comes next before the cook reads it:
//   work  = solid ink, gold square   · wait  = white, dashed blue, capsule
//   held  = grey (resting)           · ready = solid green · log = ink, green dot
// Button text always wraps — a fixed-width phone button must never clip it.
import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { CookItem, NextAction } from '@/lib/prep-steps'

// ─── StepTrack ───────────────────────────────────────────────────────────
const capsuleWidth = (minutes: number, lg: boolean) =>
  Math.max(lg ? 18 : 14, Math.round((lg ? 18 : 14) + (lg ? 7 : 6) * Math.log2(Math.max(1, minutes) / 10)))

export function StepTrack({
  seq,
  pos,
  ready,
  size = 'sm',
  window,
}: {
  seq: CookItem[]
  pos: number
  /** The current wait's timer has run out — its capsule fills green. */
  ready: boolean
  size?: 'sm' | 'lg'
  /** Show only the items around `pos` (phone): 3 behind, `window` ahead. */
  window?: number
}) {
  const lg = size === 'lg'
  const lo = window != null ? Math.max(0, pos - 3) : 0
  const hi = window != null ? Math.min(seq.length, pos + window + 1) : seq.length
  const box = lg ? 'h-4' : 'h-3'
  return (
    <div className={`flex items-center flex-wrap ${lg ? 'gap-[5px]' : 'gap-1'}`} aria-label={`Step ${pos + 1} of ${seq.length}`} role="img">
      {lo > 0 && <span className="w-2.5 h-0.5 rounded-sm bg-green" />}
      {seq.slice(lo, hi).map((it, j) => {
        const i = lo + j
        const done = i < pos
        const now = i === pos
        if (it.kind === 'STEP') {
          const cls = done ? 'bg-green border-green'
            : now ? 'bg-ink border-ink ring-2 ring-gold ring-offset-2 ring-offset-paper'
            : 'bg-paper border-line-2'
          return <span key={it.key} className={`${box} ${lg ? 'w-4 rounded-[4px]' : 'w-3 rounded-[3px]'} border-[1.5px] shrink-0 ${cls}`} />
        }
        const cls = done ? 'bg-green-soft border-green border-solid'
          : now && ready ? 'bg-green border-green border-solid ring-2 ring-green ring-offset-2 ring-offset-paper'
          : now ? 'bg-blue-soft border-blue border-solid ring-2 ring-blue ring-offset-2 ring-offset-paper'
          : 'bg-paper border-blue border-dashed'
        return <span key={it.key} style={{ width: capsuleWidth(it.minutes, lg) }} className={`${box} rounded-full border-[1.5px] shrink-0 ${cls}`} />
      })}
      {hi < seq.length && <span className="w-2.5 h-0.5 rounded-sm bg-line-2" />}
    </div>
  )
}

// ─── NextButton ──────────────────────────────────────────────────────────
const KIND_CLS: Record<NextAction['kind'], string> = {
  work: 'bg-ink text-paper border-ink',
  wait: 'bg-paper text-blue-text border-blue border-dashed',
  held: 'bg-bg-2 text-ink-3 border-bg-2',
  ready: 'bg-green text-paper border-green',
  log: 'bg-ink text-paper border-ink',
}
const SUB_CLS: Record<NextAction['kind'], string> = {
  work: 'text-ink-4',
  wait: 'text-blue-text',
  held: 'text-ink-3',
  ready: 'text-green-soft',
  log: 'text-ink-4',
}

function Glyph({ kind }: { kind: NextAction['kind'] }) {
  if (kind === 'work') return <span className="w-[11px] h-[11px] rounded-[3px] bg-gold shrink-0" />
  if (kind === 'ready') return <span className="w-[11px] h-[11px] rounded-[3px] bg-paper shrink-0" />
  if (kind === 'log') return <span className="w-[11px] h-[11px] rounded-full bg-green shrink-0" />
  return (
    <span className={`w-[18px] h-[10px] rounded-full border-[1.5px] border-dashed shrink-0 ${kind === 'wait' ? 'border-blue' : 'border-ink-4'}`} />
  )
}

export function NextButton({
  action,
  size = 'row',
  label,
  sub,
  onClick,
  disabled,
}: {
  action: NextAction
  size?: 'row' | 'big'
  /** Override the action's label / sub line (the drawer says "Move on early"). */
  label?: string
  sub?: string
  onClick: () => void
  disabled?: boolean
}) {
  const big = size === 'big'
  const subText = sub ?? action.sub
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-2.5 border-[1.5px] font-semibold tracking-[-0.01em] text-left cursor-pointer max-w-full disabled:opacity-50 disabled:cursor-not-allowed ${
        big ? 'w-full min-h-[54px] rounded-[12px] px-4 py-2.5 text-[15px] justify-center' : 'min-h-[44px] rounded-[9px] pl-3 pr-3.5 py-2 text-[13px]'
      } ${KIND_CLS[action.kind]}`}
    >
      <Glyph kind={action.kind} />
      <span className="min-w-0 break-words">
        {label ?? action.label}
        {subText && (
          <span className={`block font-mono font-medium uppercase tracking-[0.02em] mt-px ${big ? 'text-[10px]' : 'text-[9.5px]'} ${SUB_CLS[action.kind]}`}>
            {subText}
          </span>
        )}
      </span>
    </button>
  )
}

// ─── JobMenu ─────────────────────────────────────────────────────────────
export interface JobMenuEntry {
  label: string
  sub?: string
  danger?: boolean
  onClick: () => void
}

export function JobMenu({ entries, size = 36 }: { entries: JobMenuEntry[]; size?: 36 | 44 }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('touchstart', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('touchstart', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  if (entries.length === 0) return null
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label="More: stop, alarms"
        aria-expanded={open}
        style={{ width: size, height: size }}
        className="rounded-[9px] border border-line bg-paper grid place-items-center text-ink-3 hover:border-ink-3 cursor-pointer"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 w-[250px] bg-paper border border-line-2 rounded-[12px] shadow-xl overflow-hidden">
          {entries.map(e => (
            <button
              key={e.label}
              type="button"
              onClick={() => { setOpen(false); e.onClick() }}
              className={`block w-full text-left px-3.5 py-[11px] border-b border-line last:border-b-0 hover:bg-bg cursor-pointer ${e.danger ? 'text-red-text' : 'text-ink'}`}
            >
              <span className="block text-[13px] font-semibold">{e.label}</span>
              {e.sub && <span className="block font-mono text-[10px] text-ink-3 mt-0.5">{e.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
