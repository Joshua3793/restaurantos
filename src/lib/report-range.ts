'use client'
import { useState, useEffect, useCallback } from 'react'
import { rangeForPreset, type DateRange } from '@/components/reports/DateRangePicker'

// One shared date range across every /reports page (Overview, COGS, Purchasing,
// Sales, Inventory, Prep). Each page used to seed its OWN useState(rangeForPreset(...))
// with different defaults, so selecting June on Purchasing left Overview on "this week"
// — the same purchases/revenue looked different per tab. Persisting the range here makes
// all tabs honor the same window; picking a range on one carries to the rest.
const KEY = 'reports.dateRange'

function load(fallback: DateRange): DateRange {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return fallback
    const o = JSON.parse(raw)
    const from = new Date(o.from), to = new Date(o.to)
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) return fallback
    return { from, to, label: typeof o.label === 'string' ? o.label : fallback.label }
  } catch { return fallback }
}

/**
 * The shared, localStorage-persisted reports date range. Drop-in replacement for
 * `useState(() => rangeForPreset(...))`. Reads the stored range after mount (SSR-safe:
 * first paint uses the fallback so server/client HTML match, then hydrates from storage).
 */
export function useReportRange(fallbackPreset: 'thisWeek' | 'last30' = 'last30'): [DateRange, (r: DateRange) => void] {
  const [range, setRangeState] = useState<DateRange>(() => rangeForPreset(fallbackPreset))

  // Hydrate from storage after mount — avoids a server/client hydration mismatch.
  useEffect(() => {
    const stored = load(range)
    if (stored.from.getTime() !== range.from.getTime() || stored.to.getTime() !== range.to.getTime()) {
      setRangeState(stored)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setRange = useCallback((r: DateRange) => {
    setRangeState(r)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ from: r.from.toISOString(), to: r.to.toISOString(), label: r.label }))
      } catch { /* private mode / quota — range still works in-memory */ }
    }
  }, [])

  return [range, setRange]
}
