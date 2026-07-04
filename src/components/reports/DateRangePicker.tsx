'use client'
import { useMemo } from 'react'
import { CalendarRange } from 'lucide-react'
import { startOfWeek, startOfMonth, startOfQuarter, endOfDay, lastWeekRange } from '@/lib/dates'
import { setScopeParams } from '@/lib/scope-params'

export interface DateRange {
  from: Date
  to: Date
  label: string
}

type PresetKey = 'thisWeek' | 'lastWeek' | 'thisMonth' | 'last30' | 'thisQuarter' | 'custom'

const PRESETS: { key: Exclude<PresetKey, 'custom'>; label: string }[] = [
  { key: 'thisWeek',    label: 'This week' },
  { key: 'lastWeek',    label: 'Last week' },
  { key: 'thisMonth',   label: 'This month' },
  { key: 'last30',      label: 'Last 30 days' },
  { key: 'thisQuarter', label: 'This quarter' },
]

/** Compute {from,to,label} for a preset, relative to `now`. */
export function rangeForPreset(key: Exclude<PresetKey, 'custom'>, now = new Date()): DateRange {
  switch (key) {
    case 'thisWeek':    return { from: startOfWeek(now),    to: endOfDay(now), label: 'This week' }
    case 'lastWeek':    { const r = lastWeekRange(now); return { ...r, label: 'Last week' } }
    case 'thisMonth':   return { from: startOfMonth(now),   to: endOfDay(now), label: 'This month' }
    case 'last30':      { const f = new Date(now); f.setDate(f.getDate() - 30); f.setHours(0, 0, 0, 0); return { from: f, to: endOfDay(now), label: 'Last 30 days' } }
    case 'thisQuarter': return { from: startOfQuarter(now), to: endOfDay(now), label: 'This quarter' }
  }
}

/** Date → 'YYYY-MM-DD' in local time, for <input type="date"> value. */
function toInputValue(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build report-analytics query params from a range + the active scope:
 * `from`/`to` as calendar days (the API parses them at UTC boundaries) plus
 * the scope lens (`rcId`/`isDefault` for an RC, `locationId` for a Location,
 * nothing for "All"). Shared by the analytics report tabs.
 */
export function analyticsParams(
  range: DateRange,
  scope: {
    activeKind: 'all' | 'location' | 'rc'
    activeRcId: string | null
    activeRc: { isDefault?: boolean } | null
    activeLocationId: string | null
  },
): URLSearchParams {
  const params = new URLSearchParams({ from: toInputValue(range.from), to: toInputValue(range.to) })
  setScopeParams(params, scope)
  return params
}

/** 'YYYY-MM-DD' (local) → Date at local midnight. */
function fromInputValue(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function DateRangePicker({ value, onChange }: {
  value: DateRange
  onChange: (r: DateRange) => void
}) {
  const fromStr = toInputValue(value.from)
  const toStr   = toInputValue(value.to)
  const invalid = value.from > value.to

  // Highlight is DERIVED from `value` (not held in local state) so a range restored
  // from shared storage or set by another page shows the correct chip. A value that
  // matches a preset's current [from,to] (day-level) highlights it; else → custom.
  const preset: PresetKey = useMemo(() => {
    for (const p of PRESETS) {
      const r = rangeForPreset(p.key)
      if (toInputValue(r.from) === fromStr && toInputValue(r.to) === toStr) return p.key
    }
    return 'custom'
  }, [fromStr, toStr])

  const applyPreset = (key: Exclude<PresetKey, 'custom'>) => {
    onChange(rangeForPreset(key))
  }

  const applyCustom = (next: { from?: string; to?: string }) => {
    const from = next.from ? fromInputValue(next.from) : value.from
    const to   = next.to   ? endOfDay(fromInputValue(next.to)) : value.to
    onChange({ from, to, label: 'Custom' })
  }

  const rangeText = useMemo(() => {
    const fmt = (d: Date) => d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })
    return `${fmt(value.from)} → ${fmt(value.to)}`
  }, [value.from, value.to])

  return (
    <div className="bg-paper border border-line rounded-[12px] px-[18px] py-3 mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarRange size={14} className="text-gold shrink-0" />
        {PRESETS.map(p => (
          <button
            key={p.key}
            onClick={() => applyPreset(p.key)}
            className={`font-mono text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
              preset === p.key
                ? 'bg-ink text-paper border-ink'
                : 'bg-bg-2 text-ink-2 border-line hover:border-gold'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="date"
          value={fromStr}
          max={toStr}
          onChange={e => applyCustom({ from: e.target.value })}
          className={`font-mono text-[11px] bg-bg-2 border rounded px-2 py-1 text-ink ${invalid ? 'border-red' : 'border-line'}`}
        />
        <span className="text-ink-3 text-[11px]">→</span>
        <input
          type="date"
          value={toStr}
          min={fromStr}
          onChange={e => applyCustom({ to: e.target.value })}
          className={`font-mono text-[11px] bg-bg-2 border rounded px-2 py-1 text-ink ${invalid ? 'border-red' : 'border-line'}`}
        />
        {invalid && <span className="font-mono text-[10.5px] text-red-text">From is after To</span>}
        {!invalid && preset === 'custom' && (
          <span className="font-mono text-[10.5px] text-ink-3 hidden lg:inline">{rangeText}</span>
        )}
      </div>
    </div>
  )
}
