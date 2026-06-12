'use client'
import { useCallback, useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { TempDesktop } from '@/components/temps/TempDesktop'
import { TempMobile } from '@/components/temps/TempMobile'
import {
  computeDayMetrics, exportTempCSV, exportTempByEquipmentCSV, ymd,
  type TempUnit, type TempHandlers, type HistoryReading,
} from '@/components/temps/temp-utils'

export default function TempChartsPage() {
  const { activeRc } = useRc()
  const { user } = useUser()
  const rcId = activeRc?.id ?? null
  // New units are stamped with the active RC (the location you're managing).
  // Surface that in the add-unit form so the assignment is visible, never silent.
  const rcLabel = activeRc?.name ?? 'All centers (shared)'
  const recordedBy = user?.name || user?.email || null
  const TODAY = ymd(new Date())

  const [units, setUnits] = useState<TempUnit[]>([])
  const [, setLoading] = useState(true)
  const [view, setView] = useState<'today' | 'history'>('today')
  const [addOpen, setAddOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const [history, setHistory] = useState<HistoryReading[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [histUnit, setHistUnit] = useState('')
  const [histRange, setHistRange] = useState('7') // '7' | '14' | '30' | '0' (all) | 'custom'
  const [histFrom, setHistFrom] = useState('') // 'YYYY-MM-DD', used when histRange === 'custom'
  const [histTo, setHistTo] = useState('')
  const [histView, setHistView] = useState<'day' | 'equipment'>('day')

  // ── load today's units + readings ──
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/temps/units?rcId=${rcId ?? ''}&date=${TODAY}`)
      const data = await res.json()
      setUnits(Array.isArray(data) ? data : [])
    } catch {
      /* keep last good state */
    } finally {
      setLoading(false)
    }
  }, [rcId, TODAY])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  // ── history ──
  // Build the readings query for the current window. Presets ('7'|'14'|'30')
  // compute a `from` N days back; '0' = all time (no bounds); 'custom' uses the
  // from/to dates. Callers may pass an override so a control's onChange can
  // query with its new value without waiting for a state flush (mobile).
  type HistWindow = { range?: string; from?: string; to?: string }
  const buildHistoryQS = useCallback((o?: HistWindow) => {
    const range = o?.range ?? histRange
    const qs = new URLSearchParams()
    if (rcId) qs.set('rcId', rcId)
    if (range === 'custom') {
      const from = o?.from ?? histFrom
      const to = o?.to ?? histTo
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
    } else {
      const days = Number(range)
      if (days > 0) {
        const c = new Date()
        c.setDate(c.getDate() - days + 1)
        qs.set('from', ymd(c))
      }
    }
    return qs
  }, [rcId, histRange, histFrom, histTo])

  const loadHistory = useCallback(async (o?: HistWindow) => {
    setHistLoading(true)
    try {
      const res = await fetch(`/api/temps/readings?${buildHistoryQS(o).toString()}`)
      const data = await res.json()
      setHistory(Array.isArray(data) ? data : [])
    } catch {
      /* noop */
    } finally {
      setHistLoading(false)
    }
  }, [buildHistoryQS])

  // desktop: reload history whenever the tab/filters change (loadHistory's
  // identity changes when range/from/to change, so this re-fires).
  useEffect(() => {
    if (view === 'history') loadHistory()
  }, [view, loadHistory])

  // mobile: load on demand when the history sheet opens (optionally with an
  // explicit window so a select/date change queries its new value immediately).
  const ensureHistory = useCallback((o?: HistWindow) => {
    loadHistory(o)
  }, [loadHistory])

  const showToast = (m: string) => setToast(m)
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2800)
    return () => clearTimeout(t)
  }, [toast])

  // ── mutations ──
  const handlers: TempHandlers = {
    logReading: async (uid, temp, time) => {
      const u = units.find(x => x.id === uid)
      await fetch('/api/temps/readings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unitId: uid, temp, time, logDate: TODAY, recordedBy }),
      })
      await load()
      if (u) {
        const out = (u.safeMin != null && temp < u.safeMin) || (u.safeMax != null && temp > u.safeMax)
        showToast(out ? `Flagged ${temp}°C · ${u.name}` : `Logged ${temp}°C · ${u.name}`)
      }
    },
    removeReading: async (id) => {
      await fetch(`/api/temps/readings/${id}`, { method: 'DELETE' })
      await load()
    },
    addUnit: async (u) => {
      await fetch('/api/temps/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...u, revenueCenterId: rcId }),
      })
      await load()
      showToast(`Added ${u.name}`)
    },
    updateUnit: async (id, patch) => {
      await fetch(`/api/temps/units/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    },
    deleteUnit: async (id) => {
      await fetch(`/api/temps/units/${id}`, { method: 'DELETE' })
      await load()
    },
  }

  const metrics = computeDayMetrics(units)
  const histDays = new Set(history.map(r => r.logDate)).size

  // Export matches the currently-displayed History window (same query builder)
  // and sub-view: daily readings vs equipment-focused.
  const onExport = async () => {
    try {
      const res = await fetch(`/api/temps/readings?${buildHistoryQS().toString()}`)
      const data: HistoryReading[] = await res.json()
      const list = Array.isArray(data) ? data : []
      if (histView === 'equipment') exportTempByEquipmentCSV(list)
      else exportTempCSV(list)
    } catch {
      showToast('Export failed — try again')
    }
  }

  return (
    <div className="space-y-3 md:space-y-5">
      <TempDesktop
        units={units}
        metrics={metrics}
        handlers={handlers}
        today={TODAY}
        view={view}
        setView={setView}
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        rcLabel={rcLabel}
        history={history}
        histLoading={histLoading}
        histUnit={histUnit}
        setHistUnit={setHistUnit}
        histRange={histRange}
        setHistRange={setHistRange}
        histFrom={histFrom}
        setHistFrom={setHistFrom}
        histTo={histTo}
        setHistTo={setHistTo}
        histView={histView}
        setHistView={setHistView}
        onExport={onExport}
        histDays={histDays}
      />

      <TempMobile
        units={units}
        metrics={metrics}
        handlers={handlers}
        today={TODAY}
        rcLabel={rcLabel}
        history={history}
        histLoading={histLoading}
        ensureHistory={ensureHistory}
        onExport={onExport}
        histView={histView}
        setHistView={setHistView}
        histRange={histRange}
        setHistRange={setHistRange}
        histFrom={histFrom}
        setHistFrom={setHistFrom}
        histTo={histTo}
        setHistTo={setHistTo}
      />

      {toast && (
        <div className="fixed bottom-24 md:bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-ink text-white text-sm font-medium px-5 py-3 rounded-xl shadow-xl flex items-center gap-2 max-w-sm w-[calc(100%-2rem)] mx-4">
          <Check size={15} className="shrink-0 text-gold" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
