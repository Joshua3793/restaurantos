'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { defaultPhase, type Phase } from '@/lib/checklists/rules'
import type { LineAction } from '@/lib/checklists/apply-line'
import type { CookView } from '@/lib/checklists/cook-view'
import type { LineView, RunView } from '@/lib/checklists/runs'
import { StationPicker } from '@/components/checklists/StationPicker'
import { ChecklistView } from '@/components/checklists/ChecklistView'
import { LineSheet } from '@/components/checklists/LineSheet'
import { SignOffFooter } from '@/components/checklists/SignOffFooter'
import { closingLede } from '@/lib/checklists/lede'
import type { RowLine } from '@/components/checklists/LineRow'

// /checklist — the cook's opening / closing list for their station(s).
// Mobile first: one fluid column, centred at 480 px on a desktop.

const POLL_MS = 30_000

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not save — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
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

  useEffect(() => {
    call<{ cook: { name?: string | null; homeStation: string | null } | null }>('/api/prep/me').then(r => {
      if (r.ok) {
        setHomeStation(r.data.cook?.homeStation ?? null)
        setCookName(r.data.cook?.name ?? null)
      }
      setMeLoaded(true)
    })
  }, [])

  const key = `${activeRcId ?? ''}|${paramPhase ?? ''}`
  const load = useCallback(async () => {
    if (!activeRcId) return
    const myKey = `${activeRcId}|${paramPhase ?? ''}`
    reqKey.current = myKey
    const seq = mutSeq.current
    const qs = new URLSearchParams({ rcId: activeRcId })
    const askPhase = paramPhase ?? pinnedPhase.current
    if (askPhase) qs.set('phase', askPhase)
    const r = await call<CookView>(`/api/checklists?${qs}`)
    if (reqKey.current !== myKey) return
    if (!r.ok) { setLoadError(r.error); return }
    if (!paramPhase && !pinnedPhase.current) pinnedPhase.current = r.data.phase
    if (inflight.current > 0 || seq !== mutSeq.current) return
    setLoadError(null)
    setView(r.data)
    setViewFor(myKey)
  }, [activeRcId, paramPhase])

  useEffect(() => {
    if (!ready) return
    setView(null)
    setLoadError(null)
    setSheetLineId(null)
    setPickerOpen(false)
    pinnedPhase.current = null   // a new kitchen or an explicit phase: let the server pick again
    if (!activeRcId) return
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [ready, activeRcId, load])

  useEffect(() => {
    // A lead with no pick lands on the whole-kitchen list instead (it gates the close).
    if (!view || !meLoaded || view.mine.length > 0 || view.shared || autoOpened.current === key) return
    // Never on a view left over from the kitchen or phase we just switched away from.
    if (viewFor !== key || (paramPhase && view.phase !== paramPhase)) return
    autoOpened.current = key
    setPickerOpen(true)
  }, [view, viewFor, meLoaded, key, paramPhase])

  /** Wraps a save so a poll in flight cannot paint over it. */
  const mutate = async <T,>(fn: () => Promise<T>): Promise<T> => {
    mutSeq.current++
    inflight.current++
    try { return await fn() } finally { inflight.current--; mutSeq.current++ }
  }

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

  // A TICK tap flips at once and rolls back with a toast if the save fails.
  const tapLine = async (line: RowLine) => {
    if (busyRef.current.has(line.id)) return
    if (line.answer !== 'TICK' || line.status === 'FLAGGED') { setSheetLineId(line.id); return }
    const tick = line.status === 'TODO'
    const before: LineView = line
    const optimistic: LineView = tick
      ? { ...line, status: 'DONE', value: null, doneByName: myName, doneById: user?.id ?? null, doneAt: new Date().toISOString(), flagReason: null, flagNote: null }
      : { ...line, status: 'TODO', value: null, doneByName: null, doneById: null, doneAt: null, flagReason: null, flagNote: null }
    setView(v => (v ? replaceLine(v, optimistic) : v))
    const r = await putLine(line, { action: tick ? 'tick' : 'untick' })
    if (r.ok) setView(v => (v ? replaceLine(v, r.data.line) : v))
    else {
      setView(v => (v ? replaceLine(v, before) : v))
      showError(r.error)
    }
  }

  const sheetAction = async (line: RowLine, action: LineAction): Promise<boolean> => {
    if (busyRef.current.has(line.id)) return false
    const r = await putLine(line, action)
    if (!r.ok) { showError(r.error); return false }
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
    router.replace(`/checklist?phase=${p}`, { scroll: false })
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
  const sheetOpen = !!(sheetLine && sheetRun && sheetRun.status === 'OPEN')
  // A sheet that closed because its run got signed must not come back after a reopen.
  useEffect(() => {
    if (!sheetOpen && sheetLineId) setSheetLineId(null)
  }, [sheetOpen, sheetLineId])

  const crumb = view
    ? [crumbDay(view.businessDate), phase === 'OPEN' ? 'OPENING' : 'CLOSING', ...(phase === 'CLOSE' && picked.length ? [picked.map(s => s.name.toUpperCase()).join(' + ')] : [])].join(' · ')
    : phase === 'OPEN' ? 'OPENING' : 'CLOSING'

  // A lead with no station picked still works the whole-kitchen list.
  const sharedOnly = !!view && mine.length === 0 && !!view.shared
  const sharedLeft = sharedOnly && view?.shared?.status === 'OPEN'
    ? view.shared.lines.filter(l => l.isBlocker && l.status === 'TODO').length
    : 0

  let lede: React.ReactNode = null
  if (sharedOnly) {
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
  const canSeeBoard = canReopen   // the board (/checklist/today) is LEAD+ too

  return (
    <div className="max-w-[480px] mx-auto w-full flex flex-col">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/today" className="text-[13px] text-ink-3 min-h-[44px] inline-flex items-center gap-0.5 -ml-1">
            <ChevronLeft size={16} aria-hidden /> Today
          </Link>
          {/* Leads and up run the whole kitchen from the board. */}
          {canSeeBoard && (
            <Link href="/checklist/today" className="font-mono text-[11px] text-gold-2 min-h-[44px] inline-flex items-center whitespace-nowrap">
              Station board →
            </Link>
          )}
        </div>
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
      </header>

      <section className="pt-2.5 flex flex-col gap-2.5">
        <div className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">{crumb}</div>
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">
          {phase === 'OPEN' ? 'Morning' : 'Close down'}, <em className="font-fraunces italic font-medium text-gold-2">{name}</em>.
        </h1>
        {lede && <p className="m-0 text-[15px] leading-[1.45] text-ink-2">{lede}</p>}
        {view && picked.length > 0 && (
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

      <div className="mt-4">
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
              busyIds={busyIds}
              onTap={tapLine}
              onMore={l => setSheetLineId(l.id)}
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
            busyIds={busyIds}
            onTap={tapLine}
            onMore={l => setSheetLineId(l.id)}
          />
        )}
      </div>

      {view && mine.length > 0 && (
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
