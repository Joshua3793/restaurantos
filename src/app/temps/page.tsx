'use client'
import { useCallback, useEffect, useState } from 'react'
import { Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { TempDesktop } from '@/components/temps/TempDesktop'
import { TempMobile } from '@/components/temps/TempMobile'
import {
  computeDayMetrics, exportTempCSV, ymd,
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
  const [histRange, setHistRange] = useState('7')

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
  const loadHistory = useCallback(async () => {
    setHistLoading(true)
    try {
      const days = Number(histRange)
      const qs = new URLSearchParams()
      if (rcId) qs.set('rcId', rcId)
      if (days > 0) {
        const c = new Date()
        c.setDate(c.getDate() - days + 1)
        qs.set('from', ymd(c))
      }
      const res = await fetch(`/api/temps/readings?${qs.toString()}`)
      const data = await res.json()
      setHistory(Array.isArray(data) ? data : [])
    } catch {
      /* noop */
    } finally {
      setHistLoading(false)
    }
  }, [rcId, histRange])

  // desktop: reload history whenever the tab/filters change
  useEffect(() => {
    if (view === 'history') loadHistory()
  }, [view, loadHistory])

  // mobile: load on demand when the history sheet opens
  const ensureHistory = useCallback(() => {
    loadHistory()
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

  // Export the full record (independent of the current History filter window).
  const onExport = async () => {
    try {
      const qs = new URLSearchParams()
      if (rcId) qs.set('rcId', rcId)
      const res = await fetch(`/api/temps/readings?${qs.toString()}`)
      const data: HistoryReading[] = await res.json()
      exportTempCSV(Array.isArray(data) ? data : [])
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
