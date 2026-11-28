'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, CloudOff } from 'lucide-react'
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { useUser } from '@/contexts/UserContext'
import { TempDesktop } from '@/components/temps/TempDesktop'
import { TempMobile } from '@/components/temps/TempMobile'
import { useAppRefresh } from '@/lib/app-refresh'
import {
  computeDayMetrics, exportTempCSV, exportTempByEquipmentCSV, ymd,
  type TempUnit, type TempHandlers, type HistoryReading,
} from '@/components/temps/temp-utils'
import {
  loadTempQueue, enqueueReading, dropQueuedReading, flushTempQueue, postReading, newClientId,
  type QueuedReading,
} from '@/components/temps/temp-queue'

/** Prefix for a reading that is still in the on-phone queue (never a server id). */
const QUEUED_PREFIX = 'q_'

/** '2026-11-24T05:14:00Z' → 'Mon 9:14 pm' (phone's own clock). */
function takenLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'earlier'
  const wd = d.toLocaleString('en-US', { weekday: 'short' })
  const t = d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return `${wd} ${t}`
}

/** One reading the server refused as too old: say so, and let a cook throw it away (two taps). */
function TooOldRow({ reading, unitName, onDiscard }: { reading: QueuedReading; unitName: string; onDiscard: () => void }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-2 text-ink-2 px-3.5 py-2.5 text-[13px]">
      <span className="flex-1 min-w-0">
        <b className="font-semibold">{unitName} {reading.temp}°C</b> — too old to send (taken {takenLabel(reading.takenAt)})
      </span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <button type="button" onClick={onDiscard} className="min-h-[36px] px-3 rounded-full bg-ink text-paper text-[12px] font-medium">Discard it</button>
          <button type="button" onClick={() => setConfirming(false)} className="min-h-[36px] px-3 rounded-full border border-line text-[12px] font-medium">Keep</button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="min-h-[36px] px-3 rounded-full border border-line bg-paper text-[12px] font-medium">Discard</button>
      )}
    </div>
  )
}

export default function TempChartsPage() {
  const { activeRc, activeRcId, activeKind, activeLocationId, ready: scopeReady } = useRc()
  const { user, role } = useUser()
  // Safe ranges, units and the "Read" auto-fill are MANAGER+; removing a
  // reading is LEAD+. The server enforces the same rules (api/temps/*).
  const canManage = !!role && atLeast(role as Role, 'MANAGER')
  const canRemove = !!role && atLeast(role as Role, 'LEAD')
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
  const [backfilling, setBackfilling] = useState(false)
  // Readings logged with no signal, waiting on this phone (temp-queue.ts).
  const [queued, setQueued] = useState<QueuedReading[]>([])
  const refreshQueued = useCallback(() => setQueued(loadTempQueue()), [])

  const [history, setHistory] = useState<HistoryReading[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [histUnit, setHistUnit] = useState('')
  const [histRange, setHistRange] = useState('7') // '7' | '14' | '30' | '0' (all) | 'custom'
  const [histFrom, setHistFrom] = useState('') // 'YYYY-MM-DD', used when histRange === 'custom'
  const [histTo, setHistTo] = useState('')
  const [histView, setHistView] = useState<'day' | 'equipment'>('day')

  // ── load today's units + readings ──
  const load = useCallback(async () => {
    if (!scopeReady) return   // wait for the scope, or this fires an unscoped load first
    try {
      const p = new URLSearchParams({ date: TODAY })
      setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
      // no-store: the route sends max-age=5, which let a reload right after
      // logging or Read serve the pre-write response (0/13 after 378 inserts).
      const res = await fetch(`/api/temps/units?${p.toString()}`, { cache: 'no-store' })
      const data = await res.json()
      setUnits(Array.isArray(data) ? data : [])
    } catch {
      /* keep last good state */
    } finally {
      setLoading(false)
    }
  }, [activeKind, activeRcId, activeRc, activeLocationId, TODAY, scopeReady])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])
  useAppRefresh(() => { load(); if (view === 'history') loadHistory() })
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  // ── on-phone queue: send what is waiting on load, on reconnect, and when the
  // page comes back into view ──
  const flushQueued = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { refreshQueued(); return }
    if (loadTempQueue().length === 0) { refreshQueued(); return }
    const r = await flushTempQueue()
    refreshQueued()
    if (r.sent > 0) load()
    if (r.rejected > 0 || r.tooOld > 0) {
      const n = r.rejected + r.tooOld
      setToast(`${n} reading${n === 1 ? '' : 's'} from this phone could not be saved`)
    } else if (r.sent > 0) {
      setToast(`Sent ${r.sent} reading${r.sent === 1 ? '' : 's'} saved on this phone`)
    }
  }, [load, refreshQueued])

  useEffect(() => {
    flushQueued()
    const onOnline = () => { flushQueued() }
    const onVis = () => { if (document.visibilityState === 'visible') flushQueued() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [flushQueued])

  // Today's queued readings show on their unit (marked pending) so a cook in a
  // dead zone sees the fridge as logged.
  const shownUnits = useMemo(() => {
    const mine = queued.filter(q => q.logDate === TODAY && !q.tooOld)
    if (mine.length === 0) return units
    return units.map(u => {
      const extra = mine.filter(q => q.unitId === u.id)
      if (extra.length === 0) return u
      const readings = [
        ...(u.readings ?? []),
        ...extra.map(q => ({ id: `${QUEUED_PREFIX}${q.clientId}`, time: q.time, temp: q.temp, pending: true })),
      ].sort((a, b) => a.time.localeCompare(b.time))
      return { ...u, readings }
    })
  }, [units, queued, TODAY])

  // ── history ──
  // Build the readings query for the current window. Presets ('7'|'14'|'30')
  // compute a `from` N days back; '0' = all time (no bounds); 'custom' uses the
  // from/to dates. Callers may pass an override so a control's onChange can
  // query with its new value without waiting for a state flush (mobile).
  type HistWindow = { range?: string; from?: string; to?: string }
  const buildHistoryQS = useCallback((o?: HistWindow) => {
    const range = o?.range ?? histRange
    const qs = new URLSearchParams()
    setScopeParams(qs, { activeKind, activeRcId, activeRc, activeLocationId })
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
  }, [activeKind, activeRcId, activeRc, activeLocationId, histRange, histFrom, histTo])

  const loadHistory = useCallback(async (o?: HistWindow) => {
    if (!scopeReady) return   // wait for the scope, or this fires an unscoped load first
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
  }, [buildHistoryQS, scopeReady])

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
  /** Error text from a refused save, or null when it went through. */
  const refusal = async (res: Response): Promise<string | null> => {
    if (res.ok) return null
    const data = await res.json().catch(() => null)
    return (data && typeof data.error === 'string' && data.error) || 'Not saved — try again'
  }
  const send = async (url: string, init: RequestInit): Promise<boolean> => {
    try {
      const err = await refusal(await fetch(url, init))
      if (err) { showToast(`Not saved — ${err}`); return false }
      return true
    } catch {
      showToast('No connection — not saved, try again')
      return false
    }
  }

  const handlers: TempHandlers = {
    // Awaited end to end: the sheet closes only once the reading is on the
    // server or safely queued on this phone. A refusal keeps it open.
    logReading: async (uid, temp, time) => {
      const u = units.find(x => x.id === uid)
      const reading: QueuedReading = {
        clientId: newClientId(),
        unitId: uid, temp, time, logDate: TODAY, recordedBy,
        takenAt: new Date().toISOString(),
      }
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      const out = offline ? ({ outcome: 'retry' } as const) : await postReading(reading)
      if (out.outcome === 'rejected') {
        showToast(`Not saved — ${out.error}`)
        return { status: 'error', error: out.error }
      }
      if (out.outcome === 'retry') {
        enqueueReading(reading)
        refreshQueued()
        showToast('Saved on this phone — sends when signal is back')
        return { status: 'queued' }
      }
      await load()
      if (u) {
        const out = (u.safeMin != null && temp < u.safeMin) || (u.safeMax != null && temp > u.safeMax)
        showToast(out ? `Flagged ${temp}°C · ${u.name}` : `Logged ${temp}°C · ${u.name}`)
      }
      return { status: 'saved' }
    },
    removeReading: async (id) => {
      if (id.startsWith(QUEUED_PREFIX)) {
        dropQueuedReading(id.slice(QUEUED_PREFIX.length))
        refreshQueued()
        return
      }
      if (await send(`/api/temps/readings/${id}`, { method: 'DELETE' })) await load()
    },
    addUnit: async (u) => {
      const ok = await send('/api/temps/units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...u, revenueCenterId: rcId }),
      })
      if (!ok) return
      await load()
      showToast(`Added ${u.name}`)
    },
    updateUnit: async (id, patch) => {
      await send(`/api/temps/units/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      await load()
    },
    deleteUnit: async (id) => {
      if (await send(`/api/temps/units/${id}`, { method: 'DELETE' })) await load()
    },
  }

  const metrics = computeDayMetrics(shownUnits)
  const waitingCount = queued.filter(q => !q.tooOld).length
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

  // "Read" — auto-fill random readings for every visible unit, from its last
  // logged day through today (idempotent; days already holding 2 readings are
  // left alone). Backed by src/lib/temps/backfill.ts, the same code as the CLI.
  const onBackfill = async () => {
    if (backfilling) return
    setBackfilling(true)
    try {
      const body: Record<string, string> = {}
      const p = new URLSearchParams()
      setScopeParams(p, { activeKind, activeRcId, activeRc, activeLocationId })
      p.forEach((v, k) => { body[k] = v })
      if (recordedBy) body.recordedBy = recordedBy
      const res = await fetch('/api/temps/readings/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        showToast(data?.error ? `Read failed — ${data.error}` : 'Read failed — try again')
        return
      }
      await load()
      if (view === 'history') await loadHistory()
      const n = Number(data?.inserted ?? 0)
      showToast(n === 0
        ? 'Every unit is already read through today'
        : `Read ${n} reading${n === 1 ? '' : 's'} · ${data.from} → ${data.to}`)
    } catch {
      showToast('Read failed — try again')
    } finally {
      setBackfilling(false)
    }
  }

  return (
    <div className="space-y-3 md:space-y-5">
      {waitingCount > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-gold-soft text-gold-2 px-3.5 py-2.5 text-[13px] font-medium">
          <CloudOff size={15} className="shrink-0" />
          <span>
            {waitingCount} reading{waitingCount === 1 ? '' : 's'} saved on this phone — sends when signal is back
          </span>
        </div>
      )}
      {queued.filter(q => q.tooOld).map(q => (
        <TooOldRow
          key={q.clientId}
          reading={q}
          unitName={units.find(u => u.id === q.unitId)?.name ?? 'A unit'}
          onDiscard={() => { dropQueuedReading(q.clientId); refreshQueued() }}
        />
      ))}
      <TempDesktop
        units={shownUnits}
        canManage={canManage}
        canRemove={canRemove}
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
        onBackfill={onBackfill}
        backfilling={backfilling}
        histDays={histDays}
      />

      <TempMobile
        units={shownUnits}
        canManage={canManage}
        canRemove={canRemove}
        metrics={metrics}
        handlers={handlers}
        today={TODAY}
        rcLabel={rcLabel}
        history={history}
        histLoading={histLoading}
        ensureHistory={ensureHistory}
        onExport={onExport}
        onBackfill={onBackfill}
        backfilling={backfilling}
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
