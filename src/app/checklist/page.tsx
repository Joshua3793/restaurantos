'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, Flag } from 'lucide-react'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { defaultPhase, type Phase } from '@/lib/checklists/rules'
import { applyLine, type LineAction } from '@/lib/checklists/apply-line'
import { discardQueuedFor, enqueueLine, flushLineQueue, hasQueued, loadLineQueue, waitingFromOthers } from '@/components/checklists/line-queue'
import { OthersWaiting } from '@/components/checklists/OthersWaiting'
import type { CookView } from '@/lib/checklists/cook-view'
import type { LineView, RunView } from '@/lib/checklists/runs'
import { StationPicker } from '@/components/checklists/StationPicker'
import { ChecklistView } from '@/components/checklists/ChecklistView'
import { LineSheet } from '@/components/checklists/LineSheet'
import { SignOffFooter } from '@/components/checklists/SignOffFooter'
import { closingLede } from '@/lib/checklists/lede'
import { ReportSheet } from '@/components/inbox/ReportSheet'
import { ChecklistTabs } from '@/components/checklists/ChecklistTabs'
import type { RowLine } from '@/components/checklists/LineRow'
import { JobPanel } from '@/components/checklists/JobPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useAppRefresh } from '@/lib/app-refresh'
import { useBackDismiss } from '@/lib/back-stack'
import { lineOrder, type ListFilter } from '@/lib/checklists/list-layout'

// /checklist — the cook's opening / closing list for their station(s).
// ?station=<id> (LEAD+): work that station's list for its crew — opened from
// the board's "Work this list". Ticks, flags and the sign-off are the same.
// Phone: one fluid column; a job opens in a bottom sheet. Desktop (lg+): the
// list on the left, the picked job in a panel on the right with the hand-over
// and sign-off under it, and the keyboard walks the list (↑ ↓ Space F 0–9).

const POLL_MS = 30_000
// A save that hangs this long counts as no signal (it stays queued), so a stuck
// request never holds the screen's refresh back.
const CALL_TIMEOUT_MS = 15_000

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      signal: ctl.signal,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not save — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
  } finally {
    clearTimeout(timer)
  }
}

const parsePhase = (p: string | null): Phase | null => (p === 'OPEN' || p === 'CLOSE' ? p : null)

/** '2026-10-29' → 'WED 29 OCT'. */
function crumbDay(businessDate: string): string {
  const d = new Date(businessDate + 'T12:00:00Z')
  const wd = d.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const mo = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${wd} ${d.getUTCDate()} ${mo}`.toUpperCase()
}

/** 540 → '9:00', 1020 → '17:00'. */
function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

function replaceLine(view: CookView, line: LineView): CookView {
  const fix = (r: RunView): RunView =>
    r.id === line.runId ? { ...r, lines: r.lines.map(l => (l.id === line.id ? line : l)) } : r
  return { ...view, mine: view.mine.map(fix), shared: view.shared ? fix(view.shared) : null }
}

/** The line as the server will save it — the same pure rule the route runs. */
function answered(line: LineView, action: LineAction, who: { id: string; name: string }, at: Date): LineView | { error: string } {
  const r = applyLine({ answer: line.answer, safeMin: line.safeMin, safeMax: line.safeMax }, action, who, at)
  if ('error' in r) return { error: r.error }
  const d = r.data
  return {
    ...line,
    status: d.status, value: d.value,
    doneById: d.doneById, doneByName: d.doneByName, doneAt: d.doneAt ? d.doneAt.toISOString() : null,
    flagReason: d.flagReason, flagNote: d.flagNote,
    resolvedById: null, resolvedByName: null, resolvedAt: null,
  }
}

/** Paint this cook's answers still waiting on the phone over a freshly loaded list. */
function withQueued(view: CookView, who: { id: string; name: string }): CookView {
  const queued = loadLineQueue().filter(e => e.userId === who.id)
  if (queued.length === 0) return view
  const lines = new Map([...view.mine, ...(view.shared ? [view.shared] : [])].flatMap(r => r.lines).map(l => [l.id, l]))
  let out = view
  for (const e of queued) {
    const line = lines.get(e.lineId)
    if (!line) continue
    const next = answered(line, e.action, who, new Date(e.takenAt))
    if (!('error' in next)) out = replaceLine(out, next)
  }
  return out
}

function replaceRun(view: CookView, run: RunView): CookView {
  return { ...view, mine: view.mine.map(r => (r.id === run.id ? run : r)) }
}

export default function ChecklistPage() {
  return (
    <Suspense fallback={null}>
      <ChecklistScreen />
    </Suspense>
  )
}

function ChecklistScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const paramPhase = parsePhase(params.get('phase'))
  const paramStation = params.get('station') || null
  const { activeRcId, activeRc, ready } = useRc()
  const { user, role } = useUser()
  const toast = useToast()

  const [view, setView] = useState<CookView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [homeStation, setHomeStation] = useState<string | null>(null)
  const [cookName, setCookName] = useState<string | null>(null)
  // The picker waits for this so the usual station can be pre-ticked.
  const [meLoaded, setMeLoaded] = useState(false)
  // Which rc|phase the view on screen was loaded for.
  const [viewFor, setViewFor] = useState('')
  // Lines with a save in flight: a second tap waits (no double-tap race).
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const busyRef = useRef(new Set<string>())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sheetLineId, setSheetLineId] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  // Desktop only: the job open in the side panel, and the list's filter chips.
  const desk = useMediaQuery('(min-width: 1024px)') === true
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ListFilter>('all')

  // A poll that started before (or during) a save must not overwrite it.
  const mutSeq = useRef(0)
  const inflight = useRef(0)
  // Only the latest rc/phase request may land.
  const reqKey = useRef('')
  // The picker opens by itself once per rc + phase, not on every poll.
  const autoOpened = useRef('')
  // With no ?phase= the server picks one by the clock. Once a list is on screen
  // its phase is pinned, so a poll at 05:00 or 14:00 never swaps it under the cook.
  const pinnedPhase = useRef<Phase | null>(null)

  const showError = useCallback((msg: string) => toast.show({ type: 'error', title: msg }), [toast])

  // Who is answering — a ref so load/flush read it without re-subscribing.
  const whoRef = useRef({ id: '', name: '' })
  whoRef.current = { id: user?.id ?? '', name: user?.name ?? user?.email ?? '' }
  // This cook's answers saved on the phone with no signal (line-queue.ts).
  const [queuedCount, setQueuedCount] = useState(0)
  // Other cooks' answers left on this (shared) phone: they only send under their own sign-in.
  const [othersQueued, setOthersQueued] = useState<ReturnType<typeof waitingFromOthers>>([])
  const refreshQueued = useCallback(() => {
    const uid = whoRef.current.id
    setQueuedCount(uid ? loadLineQueue().filter(e => e.userId === uid).length : 0)
    setOthersQueued(uid ? waitingFromOthers(uid) : [])
  }, [])

  useEffect(() => {
    call<{ cook: { name?: string | null; homeStation: string | null } | null }>('/api/prep/me').then(r => {
      if (r.ok) {
        setHomeStation(r.data.cook?.homeStation ?? null)
        setCookName(r.data.cook?.name ?? null)
      }
      setMeLoaded(true)
    })
  }, [])

  const key = `${activeRcId ?? ''}|${paramPhase ?? ''}|${paramStation ?? ''}`
  const load = useCallback(async () => {
    if (!activeRcId) return
    const myKey = `${activeRcId}|${paramPhase ?? ''}|${paramStation ?? ''}`
    reqKey.current = myKey
    const seq = mutSeq.current
    const qs = new URLSearchParams({ rcId: activeRcId })
    const askPhase = paramPhase ?? pinnedPhase.current
    if (askPhase) qs.set('phase', askPhase)
    if (paramStation) qs.set('station', paramStation)
    const r = await call<CookView>(`/api/checklists?${qs}`)
    if (reqKey.current !== myKey) return
    if (!r.ok) { setLoadError(r.error); return }
    if (!paramPhase && !pinnedPhase.current) pinnedPhase.current = r.data.phase
    if (inflight.current > 0 || seq !== mutSeq.current) return
    setLoadError(null)
    setView(whoRef.current.id ? withQueued(r.data, whoRef.current) : r.data)
    setViewFor(myKey)
  }, [activeRcId, paramPhase, paramStation])

  useEffect(() => {
    if (!ready) return
    setView(null)
    setLoadError(null)
    setSheetLineId(null)
    setSelectedId(null)
    setPickerOpen(false)
    pinnedPhase.current = null   // a new kitchen or an explicit phase: let the server pick again
    if (!activeRcId) return
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [ready, activeRcId, load])
  useAppRefresh(() => { load() })
  useBackDismiss(pickerOpen, () => setPickerOpen(false))

  useEffect(() => {
    // A lead with no pick lands on the whole-kitchen list instead (it gates the close).
    // A lead working another station's list is not asked to pick their own.
    if (!view || !meLoaded || view.mine.length > 0 || view.shared || view.visiting || paramStation || autoOpened.current === key) return
    // Never on a view left over from the kitchen or phase we just switched away from.
    if (viewFor !== key || (paramPhase && view.phase !== paramPhase)) return
    autoOpened.current = key
    setPickerOpen(true)
  }, [view, viewFor, meLoaded, key, paramPhase, paramStation])

  /** Wraps a save so a poll in flight cannot paint over it. */
  const mutate = async <T,>(fn: () => Promise<T>): Promise<T> => {
    mutSeq.current++
    inflight.current++
    try { return await fn() } finally { inflight.current--; mutSeq.current++ }
  }

  // Send the answers waiting on this phone: on load, on reconnect, when the page
  // comes back into view, and with the poll. Wrapped in mutate() so a poll in
  // flight can't paint the pre-send state back over them.
  const flushingRef = useRef(false)
  const flush = useCallback(async () => {
    const uid = whoRef.current.id
    if (!uid || flushingRef.current) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { refreshQueued(); return }
    if (!loadLineQueue().some(e => e.userId === uid)) { refreshQueued(); return }
    flushingRef.current = true
    try {
      mutSeq.current++
      inflight.current++
      let res: Awaited<ReturnType<typeof flushLineQueue<LineView>>>
      try {
        res = await flushLineQueue<LineView>(uid, (id, body) =>
          call<{ line: LineView }>(`/api/checklists/lines/${id}`, { method: 'PUT', body: JSON.stringify(body) }))
      } finally { inflight.current--; mutSeq.current++ }
      refreshQueued()
      if (res.rejected > 0) {
        showError(`${res.rejected} ${res.rejected === 1 ? 'answer' : 'answers'} saved on this phone could not be saved — check the list.`)
      }
      if (res.sent.length > 0 || res.rejected > 0) load()
    } finally {
      flushingRef.current = false
    }
  }, [load, refreshQueued, showError])

  const userId = user?.id ?? ''
  useEffect(() => {
    if (!userId) return
    flush()
    const onOnline = () => { flush() }
    const onVis = () => { if (document.visibilityState === 'visible') flush() }
    const id = setInterval(() => { if (document.visibilityState === 'visible') flush() }, POLL_MS)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      clearInterval(id)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [userId, flush])

  const setBusy = (id: string, on: boolean) => {
    if (on) busyRef.current.add(id)
    else busyRef.current.delete(id)
    setBusyIds(new Set(busyRef.current))
  }

  /** A 409 means the run was signed off (or changed) elsewhere: show the real state now. */
  const reloadOnConflict = (r: { ok: boolean; status?: number }) => {
    if (!r.ok && r.status === 409) load()
  }

  const putLine = async (line: RowLine, action: LineAction) => {
    setBusy(line.id, true)
    try {
      const r = await mutate(() => call<{ line: LineView }>(`/api/checklists/lines/${line.id}`, {
        method: 'PUT',
        body: JSON.stringify(action),
      }))
      reloadOnConflict(r)
      return r
    } finally {
      setBusy(line.id, false)
    }
  }

  const myName = user?.name ?? user?.email ?? ''
  // The name another cook sees on this phone if this answer is left waiting (never a full email).
  const queueName = cookName?.trim() || user?.name?.trim() || (user?.email ?? '').split('@')[0]

  /** True when this answer should wait on the phone instead of going now. */
  const mustQueue = (lineId: string) =>
    (typeof navigator !== 'undefined' && navigator.onLine === false) || hasQueued(lineId)

  /** Keep the answer on screen and save it on the phone; it sends when signal is back. */
  const queueAnswer = (lineId: string, action: LineAction, at: Date) => {
    if (!user?.id) return false
    enqueueLine({ lineId, action, takenAt: at.toISOString(), userId: user.id, userName: queueName })
    refreshQueued()
    // A job already waiting: send in order behind it, now if there is signal.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) void flush()
    return true
  }

  // A TICK tap flips at once. No signal: it stays ticked and waits on the phone.
  // A server refusal rolls back with a toast.
  const tapLine = async (line: RowLine) => {
    if (busyRef.current.has(line.id)) return
    if (line.answer !== 'TICK' || line.status === 'FLAGGED') { setSheetLineId(line.id); return }
    const tick = line.status === 'TODO'
    const action: LineAction = { action: tick ? 'tick' : 'untick' }
    const at = new Date()
    const before: LineView = line
    const optimistic: LineView = tick
      ? { ...line, status: 'DONE', value: null, doneByName: myName, doneById: user?.id ?? null, doneAt: at.toISOString(), flagReason: null, flagNote: null }
      : { ...line, status: 'TODO', value: null, doneByName: null, doneById: null, doneAt: null, flagReason: null, flagNote: null }
    setView(v => (v ? replaceLine(v, optimistic) : v))
    if (mustQueue(line.id) && queueAnswer(line.id, action, at)) return
    const r = await putLine(line, action)
    if (r.ok) setView(v => (v ? replaceLine(v, r.data.line) : v))
    else if (r.status === 0 && queueAnswer(line.id, action, at)) { /* kept on screen, waiting to send */ }
    else {
      setView(v => (v ? replaceLine(v, before) : v))
      showError(r.error)
    }
  }

  const sheetAction = async (line: RowLine, action: LineAction): Promise<boolean> => {
    if (busyRef.current.has(line.id)) return false
    const at = new Date()
    const offlineLine = () => {
      const next = answered(line, action, { id: user?.id ?? '', name: myName }, at)
      if ('error' in next) { showError(next.error); return false }
      if (!queueAnswer(line.id, action, at)) return false
      setView(v => (v ? replaceLine(v, next) : v))
      return true
    }
    if (mustQueue(line.id)) return offlineLine()
    const r = await putLine(line, action)
    if (!r.ok) {
      if (r.status === 0) return offlineLine()   // never reached the server
      showError(r.error)
      return false
    }
    setView(v => (v ? replaceLine(v, r.data.line) : v))
    return true
  }

  const pick = async (stationIds: string[]): Promise<boolean> => {
    if (!activeRcId || !view) return false
    const r = await mutate(() => call<CookView>('/api/checklists/pick', {
      method: 'POST',
      body: JSON.stringify({ rcId: activeRcId, phase: view.phase, stationIds }),
    }))
    if (!r.ok) { showError(r.error); return false }
    setView(r.data)
    setViewFor(key)
    return true
  }

  const signOff = async (run: RunView, handoverNote: string | undefined): Promise<boolean> => {
    const r = await mutate(() => call<{ run: RunView }>(`/api/checklists/runs/${run.id}/signoff`, {
      method: 'POST',
      body: JSON.stringify(handoverNote !== undefined ? { handoverNote } : {}),
    }))
    reloadOnConflict(r)
    if (!r.ok) { showError(r.error); return false }
    setView(v => (v ? replaceRun(v, r.data.run) : v))
    return true
  }

  const reopen = async (run: RunView): Promise<boolean> => {
    const r = await mutate(() => call<{ run: RunView }>(`/api/checklists/runs/${run.id}/reopen`, { method: 'POST' }))
    if (!r.ok) { showError(r.error); return false }
    setView(v => (v ? replaceRun(v, r.data.run) : v))
    return true
  }

  const phase: Phase = view?.phase ?? paramPhase ?? defaultPhase()
  const setPhase = (p: Phase) => {
    if (p === phase) return
    router.replace(`/checklist?phase=${p}${paramStation ? `&station=${encodeURIComponent(paramStation)}` : ''}`, { scroll: false })
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const name = (cookName?.trim() || user?.name?.trim() || 'chef').split(' ')[0]
  const services = activeRc?.services ?? []
  const doors = services.length > 0 ? clock(Math.min(...services.map(s => s.timeMinutes))) : null
  const stations = view?.stations ?? []
  const stationName = (id: string) => stations.find(s => s.id === id)?.name ?? ''
  const mine = view?.mine ?? []
  const openMine = mine.filter(r => r.status === 'OPEN')
  const picked = mine.map(r => stations.find(s => s.id === r.stationId)).filter((s): s is NonNullable<typeof s> => !!s)
  // A lead working another station's list (from the board).
  const visiting = view?.visiting ? stations.find(s => s.id === view.visiting) ?? null : null
  // The station asked for is gone, or this user may not visit: say so rather than show their own list silently.
  const visitRefused = !!view && !!paramStation && !visiting

  // OPEN: every before-doors job still to do on screen (the whole-kitchen ones too).
  // CLOSE: what holds up this cook's sign-off.
  const blockerLines = phase === 'OPEN'
    ? [...openMine.flatMap(r => r.lines), ...(view?.shared && view.shared.status === 'OPEN' ? view.shared.lines : [])]
    : openMine.flatMap(r => r.lines)
  const blockersLeft = blockerLines.filter(l => l.isBlocker && l.status === 'TODO').length
  const things = `${blockersLeft} ${blockersLeft === 1 ? 'thing' : 'things'}`
  const openNames = openMine.map(r => stationName(r.stationId)).join(' + ')
  // CLOSE counts the whole-kitchen blockers too, like the BEFORE YOU LEAVE header (R10).
  const sharedBlockersLeft = view?.shared && view.shared.status === 'OPEN'
    ? view.shared.lines.filter(l => l.isBlocker && l.status === 'TODO').length
    : 0

  const allLines = [...mine.flatMap(r => r.lines), ...(view?.shared?.lines ?? [])]
  const sheetLine = sheetLineId ? allLines.find(l => l.id === sheetLineId) ?? null : null
  const sheetRun = sheetLine
    ? [...mine, ...(view?.shared ? [view.shared] : [])].find(r => r.id === sheetLine.runId) ?? null
    : null
  const sheetOpen = !desk && !!(sheetLine && sheetRun && sheetRun.status === 'OPEN')
  // A sheet that closed because its run got signed must not come back after a reopen.
  useEffect(() => {
    if (!sheetOpen && sheetLineId) setSheetLineId(null)
  }, [sheetOpen, sheetLineId])

  // ── Desktop: selection, Next, keyboard ─────────────────────────────────
  const fullOrder = view ? lineOrder(mine, view.shared, phase) : []
  const shownOrder = view ? lineOrder(mine, view.shared, phase, filter) : []
  const allRuns = [...mine, ...(view?.shared ? [view.shared] : [])]
  const lineById = new Map(allLines.map(l => [l.id, l]))
  const selectedLine = selectedId ? lineById.get(selectedId) ?? null : null
  const selectedRun = selectedLine ? allRuns.find(r => r.id === selectedLine.runId) ?? null : null
  const firstOpen = fullOrder.find(id => lineById.get(id)?.status === 'TODO') ?? fullOrder[0] ?? null
  // Land on the first job still to do; pick again when the selected job leaves the list.
  const selectedGone = !selectedId || !lineById.has(selectedId)
  useEffect(() => {
    if (desk && view && selectedGone) setSelectedId(firstOpen)
  }, [desk, view, selectedGone, firstOpen])

  /** The next job still to do after the selected one (wrapping), or stay put. */
  const nextOpen = () => {
    const at = selectedId ? fullOrder.indexOf(selectedId) : -1
    for (let k = 1; k <= fullOrder.length; k++) {
      const id = fullOrder[(at + k + fullOrder.length) % fullOrder.length]
      if (lineById.get(id)?.status === 'TODO' && id !== selectedId) { selectRow(id); return }
    }
  }
  const selectRow = (id: string) => {
    setSelectedId(id)
    requestAnimationFrame(() => {
      document.querySelector(`[data-line-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }
  const move = (delta: 1 | -1) => {
    if (shownOrder.length === 0) return
    const at = selectedId ? shownOrder.indexOf(selectedId) : -1
    const next = at < 0 ? (delta > 0 ? 0 : shownOrder.length - 1) : Math.min(shownOrder.length - 1, Math.max(0, at + delta))
    selectRow(shownOrder[next])
  }

  // Keys go to the list unless the cook is typing or a sheet is open.
  const keysRef = useRef({ move, tapLine, selectedLine, selectedRun })
  keysRef.current = { move, tapLine, selectedLine, selectedRun }
  useEffect(() => {
    if (!desk || pickerOpen || reportOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return
      // A focused control outside the list keeps Space / Enter for itself.
      const onList = !t || t === document.body || !!t.closest('[data-line-id]')
      const k = keysRef.current
      const line = k.selectedLine
      const open = k.selectedRun?.status === 'OPEN'
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); k.move(1); return }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); k.move(-1); return }
      if (!line || !open) return
      if (e.key === ' ' && onList && line.answer === 'TICK' && line.status !== 'FLAGGED') {
        e.preventDefault()
        k.tapLine(line)
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        const chip = document.querySelector<HTMLElement>('[data-flag-first]')
        if (chip) { e.preventDefault(); chip.focus() }
        return
      }
      // A digit (or minus) starts the reading: focus the box and let the key land in it.
      if (/^[0-9.-]$/.test(e.key)) document.querySelector<HTMLElement>('[data-reading-input]')?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [desk, pickerOpen, reportOpen])

  const flaggedTonight = phase === 'CLOSE'
    ? allLines.filter(l => l.status === 'FLAGGED' && !l.resolvedAt)
    : []

  const crumb = view
    ? [crumbDay(view.businessDate), phase === 'OPEN' ? 'OPENING' : 'CLOSING', ...(phase === 'CLOSE' && picked.length ? [picked.map(s => s.name.toUpperCase()).join(' + ')] : [])].join(' · ')
    : phase === 'OPEN' ? 'OPENING' : 'CLOSING'

  // A lead with no station picked still works the whole-kitchen list.
  const sharedOnly = !!view && mine.length === 0 && !!view.shared
  const sharedLeft = sharedOnly && view?.shared?.status === 'OPEN'
    ? view.shared.lines.filter(l => l.isBlocker && l.status === 'TODO').length
    : 0

  let lede: React.ReactNode = null
  if (visiting) {
    const crew = visiting.crew.length > 0 ? visiting.crew.join(', ') : null
    const signed = openMine.length === 0
    lede = <>
      Working <b className="font-semibold">{visiting.name}</b>’s list{crew ? <> with {crew}</> : <> — nobody has picked it yet</>}.{' '}
      {signed
        ? <span className="text-green-text">Signed off.</span>
        : mine[0]?.lines.length === 0
          ? <>Nothing on this list today.</>
          : blockersLeft > 0
          ? <b className="font-semibold text-red-text">{things} left {phase === 'OPEN' ? 'before doors' : 'before sign-off'}.</b>
          : <span className="text-green-text">Ready to sign off.</span>}
    </>
  } else if (visitRefused) {
    lede = <>That station’s list isn’t available — showing your own list.</>
  } else if (sharedOnly) {
    lede = sharedLeft > 0
      ? <><b className="font-semibold text-red-text">{sharedLeft} whole-kitchen {sharedLeft === 1 ? 'job' : 'jobs'}</b> {phase === 'OPEN' ? 'before doors' : 'before you leave'}. Pick a station for its own list.</>
      : <>Whole-kitchen list below. Pick a station for its own list.</>
  } else if (view && mine.length === 0) {
    lede = <>{phase === 'OPEN' && doors && <>Doors at <b className="font-mono font-semibold">{doors}</b>. </>}Pick your station to see your list.</>
  } else if (view && openMine.length === 0) {
    lede = <span className="text-green-text">{phase === 'OPEN' ? 'Opening signed off. Nice work.' : 'Closing signed off. Good night.'}</span>
  } else if (view && phase === 'OPEN' && blockersLeft > 0) {
    lede = <>{doors && <>Doors at <b className="font-mono font-semibold">{doors}</b>. </>}<b className="font-semibold text-red-text">{things}</b> must be done before {doors ? 'then' : 'doors'}.</>
  } else if (view && phase === 'CLOSE' && blockersLeft + sharedBlockersLeft > 0) {
    const c = closingLede(blockersLeft, sharedBlockersLeft, openNames)
    lede = <><b className="font-semibold text-red-text">{c.count}</b>{c.tail}</>
  } else if (view) {
    lede = <span className="text-green-text">{phase === 'OPEN'
      ? 'Everything for doors is done. Finish the rest when you can.'
      : `Everything before you leave is done. Sign off ${openNames} when you’re ready.`}</span>
  }

  const sharedBlockersOpen = !!view?.shared && view.shared.status === 'OPEN'
    && view.shared.lines.some(l => l.isBlocker && l.status === 'TODO')

  const canReopen = !!role && atLeast(role as Role, 'LEAD')

  const deskProps = desk
    ? { filter, onFilter: setFilter, selectedId, onSelect: (l: RowLine) => selectRow(l.id) }
    : {}

  return (
    <div className="max-w-[480px] lg:max-w-none mx-auto w-full flex flex-col">
      {/* Leads and up move between the section's pages here; a cook has no tabs. */}
      <ChecklistTabs active={visiting ? 'board' : 'mine'} />
      {/* Desktop: the greeting on the left, Report + Opening/Closing on the right. */}
      <div className="flex flex-col lg:flex-row-reverse lg:items-end lg:justify-between lg:gap-6">
      <header className="flex flex-wrap items-center justify-between gap-x-3">
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="min-h-[44px] px-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-paper text-[13px] font-medium text-ink-2"
          >
            <Flag size={14} aria-hidden /> Report
          </button>
          <div className="flex bg-bg-2 rounded-full p-[3px]" role="group" aria-label="Opening or closing">
            {(['OPEN', 'CLOSE'] as Phase[]).map(p => (
              <button
                key={p}
                type="button"
                aria-pressed={phase === p}
                onClick={() => setPhase(p)}
                className={`rounded-full font-mono text-[11px] font-medium px-3.5 min-h-[44px] ${phase === p ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'}`}
              >
                {p === 'OPEN' ? 'Opening' : 'Closing'}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="pt-2.5 flex flex-col gap-2.5">
        <div className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">{crumb}</div>
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">
          {visiting
            ? <>{visiting.name} · {phase === 'OPEN' ? 'opening' : 'closing'}</>
            : <>{phase === 'OPEN' ? 'Morning' : 'Close down'}, <em className="font-fraunces italic font-medium text-gold-2">{name}</em>.</>}
        </h1>
        {lede && <p className="m-0 text-[15px] leading-[1.45] text-ink-2">{lede}</p>}
        {queuedCount > 0 && (
          <p role="status" className="m-0 font-mono text-[11px] text-gold-2">
            {queuedCount} waiting to send · saved on this phone
          </p>
        )}
        {othersQueued.map(o => (
          <OthersWaiting
            key={o.userId}
            name={o.name}
            count={o.count}
            canDiscard={canReopen}
            onDiscard={() => { discardQueuedFor(o.userId); refreshQueued() }}
          />
        ))}
        {(visiting || visitRefused) && (
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/checklist/today?phase=${phase}${visiting ? `&station=${encodeURIComponent(visiting.id)}` : ''}`}
              className="inline-flex items-center gap-1.5 border border-line bg-paper rounded-full px-3.5 min-h-[44px] text-[13px] font-medium text-ink-2"
            >
              ← All stations
            </Link>
            <Link
              href={`/checklist?phase=${phase}`}
              className="inline-flex items-center gap-1.5 border border-line bg-paper rounded-full px-3.5 min-h-[44px] text-[13px] font-medium text-ink-2"
            >
              My own list
            </Link>
          </div>
        )}
        {view && !visiting && picked.length > 0 && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="self-start inline-flex items-center gap-2 border border-line bg-paper rounded-full px-3.5 min-h-[44px] text-[13px] font-medium text-ink-2"
          >
            <span className="w-2 h-2 rounded-full" style={{ background: picked[0].color }} aria-hidden />
            <span>On <b className="font-semibold">{picked.map(s => s.name).join(' + ')}</b> today</span>
            <span className="font-mono text-[11px] text-ink-3 inline-flex items-center gap-0.5">change <ChevronDown size={12} aria-hidden /></span>
          </button>
        )}
      </section>
      </div>

      <div className={desk ? 'mt-5 grid grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px] gap-5 items-start' : 'mt-4'}>
      <div className="min-w-0">
        {!ready || (activeRcId && !view && !loadError) ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
        ) : !activeRcId ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Pick a kitchen in the top bar to see its list.</div>
        ) : !view ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
            <p className="m-0 text-[14px] text-red-text">{loadError}</p>
            <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
          </div>
        ) : sharedOnly ? (
          <div className="flex flex-col gap-4">
            <button type="button" onClick={() => setPickerOpen(true)} className="self-start min-h-[44px] px-4 rounded-full border border-line bg-paper text-[13px] font-medium text-ink-2">Pick your station</button>
            <ChecklistView
              phase={phase}
              mine={[]}
              shared={view.shared}
              stations={stations}
              handover={view.handover}
            kitchenNote={view.kitchenNote}
              busyIds={busyIds}
              onTap={tapLine}
              onMore={l => setSheetLineId(l.id)}
              {...deskProps}
            />
          </div>
        ) : mine.length === 0 ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
            <p className="m-0 text-[14px] text-ink-3">Pick where you are today and your list shows up here.</p>
            <button type="button" onClick={() => setPickerOpen(true)} className="h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium">Pick your station</button>
          </div>
        ) : (
          <ChecklistView
            phase={phase}
            mine={mine}
            shared={view.shared}
            stations={stations}
            handover={view.handover}
            kitchenNote={view.kitchenNote}
            busyIds={busyIds}
            onTap={tapLine}
            onMore={l => setSheetLineId(l.id)}
            {...deskProps}
          />
        )}
      </div>

      {desk && view && (
        <aside className="sticky top-[60px] max-h-[calc(100dvh-76px)] overflow-y-auto flex flex-col gap-3">
          <JobPanel
            line={selectedLine}
            phase={phase}
            placeLabel={selectedRun ? stationName(selectedRun.stationId) : ''}
            locked={selectedRun?.status === 'SIGNED'}
            onAction={sheetAction}
            onNext={nextOpen}
          />
          {flaggedTonight.length > 0 && (
            <section aria-label="Flagged tonight" className="bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-2">
              <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3">FLAGGED TONIGHT · ALREADY IN THE INBOX</span>
              {flaggedTonight.map(l => (
                <button key={l.id} type="button" onClick={() => selectRow(l.id)} className="flex items-center gap-2 text-left text-[13px] text-ink-2 min-h-[28px]">
                  <span className="w-2 h-2 rounded-full bg-gold flex-none" aria-hidden />
                  <span className="flex-1 min-w-0 truncate">{l.title}</span>
                </button>
              ))}
            </section>
          )}
          {mine.length > 0 && (
            <SignOffFooter
              rail
              phase={phase}
              runs={mine}
              stations={stations}
              canReopen={canReopen}
              sharedBlockersOpen={sharedBlockersOpen}
              onSignOff={signOff}
              onReopen={reopen}
            />
          )}
        </aside>
      )}
      </div>

      {!desk && view && mine.length > 0 && (
        <SignOffFooter
          phase={phase}
          runs={mine}
          stations={stations}
          canReopen={canReopen}
          sharedBlockersOpen={sharedBlockersOpen}
          onSignOff={signOff}
          onReopen={reopen}
        />
      )}

      {pickerOpen && view && (
        <StationPicker
          stations={stations}
          phase={view.phase}
          homeStation={homeStation}
          myName={myName}
          onClose={() => setPickerOpen(false)}
          onPick={pick}
        />
      )}

      <ReportSheet
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        rcId={activeRcId}
        defaultPlace={picked[0]?.name ?? null}
      />

      {sheetOpen && sheetLine && sheetRun && (
        <LineSheet
          key={sheetLine.id}
          line={sheetLine}
          phase={phase}
          placeLabel={stationName(sheetRun.stationId)}
          onClose={() => setSheetLineId(null)}
          onAction={sheetAction}
        />
      )}
    </div>
  )
}
