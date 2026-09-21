'use client'
import type { ReactNode } from 'react'
import type { SplitPerson, TipRoleDef } from '@/lib/tips/types'
import { effectiveHours } from '@/lib/tips/engine'

export type TipTabId = 'split' | 'days' | 'cash' | 'checks' | 'import' | 'settings'

export const TIP_TABS: Array<{ id: TipTabId; label: string }> = [
  { id: 'split', label: 'Split' },
  { id: 'days', label: 'Daily pools' },
  { id: 'cash', label: 'Cash & envelopes' },
  { id: 'checks', label: 'Checks' },
  { id: 'import', label: 'Import data' },
  { id: 'settings', label: 'Tip settings' },
]

export const money = (n: number) =>
  '$' + n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const money0 = (n: number) => '$' + Math.round(n).toLocaleString('en-CA')
export const hoursLabel = (n: number) => (Math.round(n * 100) / 100).toFixed(2) + ' h'
export const signedHours = (n: number) =>
  (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n * 100) / 100).toFixed(2)
export const initials = (name: string) => name.slice(0, 2).toUpperCase()

/** Role-weight pill colouring — mirrors `.wsel.w15/.w12/.w11/.w10` in the mock. */
export function weightClass(multiplier: number): string {
  if (multiplier >= 1.5) return 'bg-gold-soft text-gold-2'
  if (multiplier >= 1.2) return 'bg-blue-soft text-blue-text'
  if (multiplier >= 1.1) return 'bg-bg-2 text-ink-2'
  return 'bg-bg-2 text-ink-3'
}

/**
 * The 14-cell day strip. Filled = worked, gold = rewarded day, red = capped,
 * blue = hours typed in by hand. A week-2 divider sits before the 8th cell, as
 * in the mock.
 */
export function DayStrip({ person, dayLabels }: { person: SplitPerson; dayLabels: string[] }) {
  return (
    <span className="grid" style={{ gridTemplateColumns: `repeat(${dayLabels.length}, 1fr)` }}>
      {dayLabels.map((label, d) => {
        const raw = person.hours[d] ?? 0
        const h = effectiveHours(person, d)
        const rewarded = h > 0 && (person.boosts[d] ?? 1) > 1
        // Capped against THIS person's contracted shift, not a house-wide value.
        const capped = h > 0 && person.dailyHourCap != null && raw > person.dailyHourCap
        const edited = person.edited?.[d] === true
        const clocked = person.clocked?.[d]
        const title = `${label}${h > 0
          ? ` · ${h}h${rewarded ? ` · reward ×${person.boosts[d]}` : ''}${capped ? ` (capped from ${raw}h)` : ''}`
          : ' · off'}${edited ? ` · edited by hand${clocked != null ? ` (clock file: ${clocked}h)` : ''}` : ''}`

        // Three independent signals share one 9×14 block:
        //   gold = rewarded day, red = hours clipped by this person's shift cap,
        //   blue = the hours are a manual override, not the clock file.
        // A day that is more than one splits the block horizontally — one band
        // per signal — rather than letting one condition hide another, which is
        // what a single-colour precedence chain would do. Rendered as stacked
        // children so every colour stays a design token (a CSS gradient would
        // need raw hex).
        const box = 'w-[9px] h-[14px] rounded-[2px] border overflow-hidden'
        const bands = [rewarded && 'bg-gold', capped && 'bg-red', edited && h > 0 && 'bg-blue'].filter(Boolean) as string[]
        if (bands.length > 1) {
          return (
            <span key={d} className={cellWrap(d)}>
              <i title={title} className={`${box} ${capped ? 'border-red' : 'border-blue'} flex flex-col`}>
                {bands.map(b => <span key={b} className={`flex-1 ${b}`} />)}
              </i>
            </span>
          )
        }
        const tone = h <= 0
          // Edited DOWN to nothing is the edit most worth seeing: the day looks
          // like a day off unless it is marked.
          ? edited ? 'bg-blue-soft border-blue' : 'bg-bg-2 border-line'
          : capped ? 'bg-red border-red'
          : rewarded ? 'bg-gold border-gold-2'
          : edited ? 'bg-blue border-blue'
          : 'bg-ink border-ink'
        return (
          <span key={d} className={cellWrap(d)}>
            <i title={title} className={`${box} ${tone}`} />
          </span>
        )
      })}
    </span>
  )
}

/** Day-strip cell wrapper. The 8th cell carries the week-2 divider. */
function cellWrap(d: number): string {
  return `flex flex-col items-center gap-[3px] ${
    d === 7
      ? 'relative before:absolute before:-left-[2px] before:top-[2px] before:bottom-0 before:w-px before:bg-line-2'
      : ''
  }`
}

/** Shared legend for the day strip — keep the wording identical everywhere. */
export function DayStripLegend() {
  return (
    <span className="inline-flex items-center gap-3 font-mono text-[10.5px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-ink border-ink" />WORKED
      </span>
      <span className="inline-flex items-center gap-1.5 text-gold-2">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-gold border-gold-2" />REWARDED
      </span>
      <span className="inline-flex items-center gap-1.5 text-red-text">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-red border-red" />CAPPED
      </span>
      <span className="inline-flex items-center gap-1.5 text-blue-text">
        <i className="w-[9px] h-[14px] rounded-[2px] border bg-blue border-blue" />EDITED BY HAND
      </span>
      <span className="inline-flex items-center gap-1.5">
        <i className="w-[9px] h-[14px] rounded-[2px] border border-red overflow-hidden flex flex-col">
          <span className="flex-1 bg-gold" />
          <span className="flex-1 bg-red" />
        </i>MORE THAN ONE
      </span>
    </span>
  )
}

/** Role picker rendered as a coloured pill, used in the split and the roster. */
export function RoleSelect({
  value, roles, onChange, className = '',
}: {
  value: string | null
  roles: TipRoleDef[]
  onChange: (roleId: string) => void
  className?: string
}) {
  const active = roles.find(r => r.id === value)
  return (
    <select
      value={value ?? ''}
      onClick={e => e.stopPropagation()}
      onChange={e => onChange(e.target.value)}
      className={`font-mono text-[11px] rounded-full px-2 py-1 font-semibold cursor-pointer outline-none appearance-none border border-transparent ${weightClass(active?.multiplier ?? 1)} ${className}`}
    >
      {!active && <option value="">— no role</option>}
      {roles.map(r => (
        <option key={r.id} value={r.id}>
          {r.name} ×{String(r.multiplier)}
        </option>
      ))}
    </select>
  )
}

/** The grey explainer card under a tab's content. */
export function MethodNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start bg-paper border border-line rounded-md px-3.5 py-3 mt-4 text-[12px] text-ink-3 leading-[1.55] [&_b]:text-ink-2 [&_b]:font-medium">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-px text-ink-4">
        <circle cx="12" cy="12" r="10" /><path d="M12 8h.01M12 11v5" />
      </svg>
      <span>{children}</span>
    </div>
  )
}
