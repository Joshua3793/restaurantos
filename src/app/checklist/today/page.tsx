'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { defaultPhase, pacificHHMM, type Phase } from '@/lib/checklists/rules'
import type { StationTone } from '@/lib/checklists/station-status'
import type { TodayFlag, TodayLine, TodayStation, TodayView } from '@/lib/checklists/today-types'
import { ChecklistTabs } from '@/components/checklists/ChecklistTabs'
import { useMediaQuery } from '@/hooks/useMediaQuery'

// /checklist/today — LEAD+ board: every station's opening / closing progress
// for today's shift, plus the open flagged problems. Phone: one fluid column of
// rows that open in place. Desktop (lg+): every station as a card in a grid,
// the picked station's jobs and the flagged problems in a column on the right.

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

const PACIFIC = 'America/Los_Angeles'

/** '2026-10-29' → 'WED 29 OCT'. */
function crumbDay(businessDate: string): string {
  const d = new Date(businessDate + 'T12:00:00Z')
  const wd = d.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' })
  const mo = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${wd} ${d.getUTCDate()} ${mo}`.toUpperCase()
}

/** Pacific clock time without a leading zero: '07:31' → '7:31'. */
const hhmm = (d: Date) => pacificHHMM(d).replace(/^0/, '')

const pacificDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

/** A time today reads '7:31'; an earlier day reads 'Tue 28 Oct 7:31'. */
function whenLabel(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (pacificDay(d) === pacificDay(now)) return hhmm(d)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d)
  const get = (t: string) => day.find(p => p.type === t)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')} ${hhmm(d)}`
}

/** 68 → '1h 08m', 35 → '35m'. */
function untilLabel(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

const REASON_LABEL: Record<NonNullable<TodayFlag['reason']>, string> = {
  BROKEN: 'BROKEN', RAN_OUT: 'RAN OUT', OUT_OF_RANGE: 'OUT OF RANGE', OTHER: 'OTHER',
}

const PILL: Record<StationTone, string> = {
  red: 'bg-red-soft text-red-text',
  gold: 'bg-gold-soft text-gold-2',
  green: 'bg-green-soft text-green-text',
  grey: 'bg-bg-2 text-ink-2',
}
const BAR: Record<StationTone, string> = { red: 'bg-red', gold: 'bg-gold', green: 'bg-green', grey: 'bg-ink-4' }

function whoLine(s: TodayStation): string {
  const parts = [
    s.crew.length > 0 ? s.crew.join(', ') : s.isShared ? '' : 'Nobody yet',
    ...(s.isShared ? ['Shared by everyone'] : []),
  ].filter(Boolean)
  // Shared: "Shared by everyone · Leo"; a station: "Leo".
  if (s.isShared) parts.reverse()
  if (s.signedOffAt) parts.push(`finished ${hhmm(new Date(s.signedOffAt))}`)
  return parts.join(' · ')
}

const LINE_TEXT: Record<'TODO' | 'DONE' | 'FLAGGED', string> = { TODO: 'TO DO', DONE: 'DONE', FLAGGED: 'FLAGGED' }

function StationRow({ s, open, onToggle }: { s: TodayStation; open: boolean; onToggle: () => void }) {
  const pct = s.total > 0 ? Math.round((s.handled / s.total) * 100) : 0
  return (
    <div className="border-t border-bg-2 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex flex-col gap-2 px-4 py-[13px] min-h-[64px] text-left"
      >
        <span className="flex items-center gap-2.5 w-full">
          <span className="flex-none w-2 h-2 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">{s.name}</span>
            <span className="font-mono text-[10.5px] text-ink-3">{whoLine(s)}</span>
          </span>
          <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${PILL[s.status.tone]}`}>
            {s.status.label}
          </span>
        </span>
        <span className="flex items-center gap-2.5 w-full">
          <span className="flex-1 h-[5px] bg-bg-2 rounded-full overflow-hidden flex">
            <span className={`h-full rounded-full ${BAR[s.status.tone]}`} style={{ width: `${pct}%` }} />
          </span>
          <span className="font-mono text-[11px] font-semibold text-ink-2 min-w-[42px] text-right">{s.handled}/{s.total}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3.5">
          {s.lines.length === 0 ? (
            <p className="m-0 font-mono text-[11px] text-ink-3">No list opened yet.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col">
              {s.lines.map(l => (
                <li key={l.id} className="flex items-baseline gap-2.5 py-1.5 border-t border-bg-2 first:border-t-0">
                  <span className="flex-1 min-w-0 text-[13.5px] text-ink-2">{l.title}</span>
                  <span className="flex-none font-mono text-[10px] text-ink-3 text-right">
                    <span className={l.status === 'FLAGGED' && !l.fixed ? 'text-red-text' : l.status === 'DONE' || l.fixed ? 'text-green-text' : ''}>
                      {l.fixed ? 'FIXED' : LINE_TEXT[l.status]}
                    </span>
                    {l.byName && l.status !== 'TODO' ? ` · ${l.byName}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** The jobs still to do, blockers first — what a card shows under its bar. */
function leftOf(s: TodayStation): TodayLine[] {
  const todo = s.lines.filter(l => l.status === 'TODO')
  return [...todo.filter(l => l.isBlocker), ...todo.filter(l => !l.isBlocker)]
}

function StationCard({ s, selected, onSelect }: { s: TodayStation; selected: boolean; onSelect: () => void }) {
  const pct = s.total > 0 ? Math.round((s.handled / s.total) * 100) : 0
  const left = leftOf(s)
  const flagged = s.lines.filter(l => l.status === 'FLAGGED' && !l.fixed).length
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`bg-paper border rounded-[12px] px-4 py-3.5 flex flex-col gap-2.5 text-left min-h-[176px] ${selected ? 'border-gold shadow-[0_0_0_3px_var(--gold-soft,#fef3c7)]' : 'border-line hover:border-line-2'}`}
    >
      <span className="flex items-start gap-2 w-full">
        <span className="flex-none w-2 h-2 mt-[6px] rounded-full" style={{ background: s.color }} aria-hidden />
        <span className="flex-1 min-w-0 text-[14.5px] leading-[1.25] font-semibold tracking-[-0.015em] text-ink">{s.name}</span>
        <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${PILL[s.status.tone]}`}>{s.status.label}</span>
      </span>
      <span className="font-mono text-[10.5px] text-ink-3 truncate">{whoLine(s)}</span>
      <span className="flex items-center gap-2.5 w-full">
        <span className="flex-1 h-[5px] bg-bg-2 rounded-full overflow-hidden flex">
          <span className={`h-full rounded-full ${BAR[s.status.tone]}`} style={{ width: `${pct}%` }} />
        </span>
        <span className="font-mono text-[11px] font-semibold text-ink-2">{s.handled}/{s.total}</span>
      </span>
      <span className="flex flex-col gap-1.5">
        {s.lines.length === 0 ? (
          <span className="text-[12.5px] text-ink-3">No list opened yet.</span>
        ) : left.length === 0 ? (
          <span className="text-[12.5px] text-green-text">{flagged > 0 ? `All handled · ${flagged} flagged` : 'All done'}</span>
        ) : (
          <>
            {left.slice(0, 3).map(l => (
              <span key={l.id} className="flex items-center gap-2 text-[12.5px] text-ink-2 min-w-0">
                <span className={`flex-none w-3 h-3 rounded-[4px] box-border border-[1.5px] ${l.isBlocker ? 'border-red' : 'border-line-2'}`} aria-hidden />
                <span className="truncate">{l.title}</span>
              </span>
            ))}
            {left.length > 3 && <span className="font-mono text-[10.5px] text-ink-3">+{left.length - 3} more</span>}
          </>
        )}
      </span>
    </button>
  )
}

function StationDetail({ s }: { s: TodayStation }) {
  const blockers = s.lines.filter(l => l.isBlocker)
  const rest = s.lines.filter(l => !l.isBlocker)
  const group = (label: string, lines: TodayLine[], urgent: boolean) => lines.length > 0 && (
    <div>
      <div className="px-[18px] pt-3 pb-1.5 font-mono text-[10px] font-medium tracking-[0.08em] flex justify-between">
        <span className={urgent ? 'text-red-text' : 'text-ink-3'}>{label}</span>
        <span className="text-ink-3">{lines.filter(l => l.status !== 'TODO').length}/{lines.length}</span>
      </div>
      <ul className="m-0 p-0 list-none">
        {lines.map(l => (
          <li key={l.id} className="flex items-center gap-3 px-[18px] min-h-[42px] border-t border-bg-2">
            <span
              className={`flex-none w-[18px] h-[18px] rounded-[5px] box-border grid place-items-center font-mono text-[11px] font-semibold ${
                l.status === 'DONE' || l.fixed ? 'bg-green text-white' : l.status === 'FLAGGED' ? 'bg-red-soft border-[1.5px] border-red text-red-text' : l.isBlocker ? 'border-2 border-red' : 'border-[1.5px] border-line-2'
              }`}
              aria-hidden
            >
              {(l.status === 'DONE' || l.fixed) && '✓'}{l.status === 'FLAGGED' && !l.fixed && '!'}
            </span>
            <span className={`flex-1 min-w-0 text-[13.5px] ${l.status === 'DONE' ? 'text-ink-3 line-through' : l.isBlocker && l.status === 'TODO' ? 'text-red-text font-semibold' : 'text-ink'}`}>{l.title}</span>
            <span className="flex-none font-mono text-[10px] text-ink-3">
              {l.fixed ? 'FIXED' : l.status === 'TODO' ? '' : LINE_TEXT[l.status]}{l.byName && l.status !== 'TODO' ? ` · ${l.byName}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
  const left = blockers.filter(l => l.status === 'TODO').length
  return (
    <section aria-label={s.name} className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className="px-[18px] py-4 border-b border-line flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-none" style={{ background: s.color }} aria-hidden />
          <span className="flex-1 min-w-0 text-[17px] font-semibold tracking-[-0.02em]">{s.name}</span>
          <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full ${PILL[s.status.tone]}`}>{s.status.label} · {s.handled}/{s.total}</span>
        </span>
        <span className="font-mono text-[10.5px] text-ink-3">{whoLine(s)}</span>
      </div>
      {s.lines.length === 0 ? (
        <p className="m-0 px-[18px] py-4 text-[13.5px] text-ink-3">Nobody has opened this list yet today.</p>
      ) : (
        <div className="pb-2">
          {group(left > 0 ? `MUST DO · ${left} LEFT` : 'MUST DO', blockers, left > 0)}
          {group('THE REST', rest, false)}
        </div>
      )}
    </section>
  )
}

function FlagRow({ f, now, busy, onFix }: { f: TodayFlag; now: Date; busy: boolean; onFix: () => void }) {
  const when = whenLabel(f.at, now)
  const reading = f.value != null ? `${f.value}${f.unit ? ` ${f.unit}` : ''}` : null
  const meta = [f.stationName, f.byName, when, reading].filter(Boolean).join(' · ')
  return (
    <div className="border-t border-bg-2 first:border-t-0">
      <div className="flex gap-3 px-4 pt-3.5 pb-3 items-start">
        <span className="flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full bg-red-soft text-red-text whitespace-nowrap">
          {f.reason ? REASON_LABEL[f.reason] : 'FLAGGED'}
        </span>
        <span className="flex-1 min-w-0 flex flex-col gap-[3px]">
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">{f.title}</span>
          <span className="font-mono text-[10.5px] text-ink-3">
            {meta}{f.note ? ` · “${f.note}”` : ''}
          </span>
        </span>
      </div>
      <div className="px-4 pb-3.5">
        <button
          type="button"
          disabled={busy}
          onClick={onFix}
          className="w-full min-h-[44px] rounded-[9px] border border-line-2 bg-paper text-[13px] font-medium text-ink-2 disabled:opacity-50"
        >
          Mark fixed
        </button>
      </div>
    </div>
  )
}

export default function ChecklistTodayPage() {
  return (
    <Suspense fallback={null}>
      <TodayBoard />
    </Suspense>
  )
}

function TodayBoard() {
  const router = useRouter()
  const params = useSearchParams()
  const paramPhase = parsePhase(params.get('phase'))
  const { activeRcId, activeRc, ready } = useRc()
  const { role } = useUser()
  const toast = useToast()

  const [view, setView] = useState<TodayView | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  // Flags a lead just marked fixed: hidden at once, and kept hidden if a poll lands first.
  const [fixing, setFixing] = useState<ReadonlySet<string>>(() => new Set())

  const allowed = !role || atLeast(role as Role, 'LEAD')
  const desk = useMediaQuery('(min-width: 1024px)') === true

  // The kitchen + phase whose reply may land; a slow reply for an older pick is dropped.
  const latestKey = useRef({ rc: activeRcId, phase: paramPhase })
  latestKey.current = { rc: activeRcId, phase: paramPhase }

  const load = useCallback(async () => {
    if (!activeRcId) return
    const qs = new URLSearchParams({ rcId: activeRcId })
    if (paramPhase) qs.set('phase', paramPhase)
    const r = await call<TodayView>(`/api/checklists/today?${qs}`)
    // Only the latest kitchen / phase may land: a slow reply for the old one is dropped.
    if (activeRcId !== latestKey.current.rc || paramPhase !== latestKey.current.phase) return
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setNow(new Date())
    setView(r.data)
  }, [activeRcId, paramPhase])

  useEffect(() => {
    if (!ready || !allowed) return
    setView(null)
    setLoadError(null)
    setOpenId(null)
    if (!activeRcId) return
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [ready, allowed, activeRcId, load])

  const markFixed = async (f: TodayFlag) => {
    if (fixing.has(f.lineId)) return
    setFixing(prev => new Set(prev).add(f.lineId))
    const r = await call<{ ok: true }>(`/api/checklists/lines/${f.lineId}/resolve`, { method: 'POST' })
    if (!r.ok && r.status !== 409) {
      setFixing(prev => { const n = new Set(prev); n.delete(f.lineId); return n })
      toast.show({ type: 'error', title: r.error })
      return
    }
    // 409: someone else got there first — the problem is handled either way.
    if (!r.ok) toast.show({ type: 'error', title: r.error })
    await load()
    setFixing(prev => { const n = new Set(prev); n.delete(f.lineId); return n })
  }

  const phase: Phase = view?.phase ?? paramPhase ?? defaultPhase()
  const setPhase = (p: Phase) => {
    if (p === phase) return
    router.replace(`/checklist/today?phase=${p}`, { scroll: false })
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const stations = view?.stations ?? []
  const flags = (view?.flags ?? []).filter(f => !fixing.has(f.lineId))
  // A station with nothing on its list today is left out of the lede's counts.
  const working = stations.filter(s => s.status.label !== 'NOTHING TODAY')
  const doneCount = working.filter(s => s.status.tone === 'green').length
  const firstNotStarted = working.find(s => s.status.label === 'NOT STARTED') ?? null

  const services = activeRc?.services ?? []
  let doorsIn: string | null = null
  if (phase === 'OPEN' && services.length > 0) {
    const [h, m] = pacificHHMM(now).split(':').map(Number)
    const until = Math.min(...services.map(s => s.timeMinutes)) - (h * 60 + m)
    if (until > 0) doorsIn = untilLabel(until)
  }

  const crumb = [
    view ? crumbDay(view.businessDate) : null,
    (activeRc?.name ?? '').toUpperCase() || null,
    view ? hhmm(now) : null,
  ].filter(Boolean).join(' · ')

  let lede: React.ReactNode = null
  if (view) {
    const n = flags.length
    const doors = doorsIn && <>Doors in <b className="font-mono font-semibold">{doorsIn}</b>. </>
    const flagText = `${n} ${n === 1 ? 'problem is' : 'problems are'} flagged`
    if (firstNotStarted || n > 0) {
      lede = (
        <>
          {doors}
          {firstNotStarted && <b className="font-semibold text-red-text">{firstNotStarted.name} hasn’t started</b>}
          {firstNotStarted && n > 0 && ' and '}
          {n > 0 && (firstNotStarted ? flagText : flagText.charAt(0).toUpperCase() + flagText.slice(1))}.
        </>
      )
    } else if (working.length > 0 && doneCount === working.length) {
      lede = <span className="text-green-text">Every station is done.</span>
    } else if (working.length > 0) {
      lede = <>{doors}Every station has started. {doneCount} of {working.length} done.</>
    }
  }

  const flagSection = (
    <section aria-label="Flagged" className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className="flex justify-between items-baseline px-4 py-3 border-b border-line">
        <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Flagged</span>
        <span className={`font-mono text-[10.5px] ${flags.length > 0 ? 'text-red-text' : 'text-ink-3'}`}>
          {flags.length > 0 ? `${flags.length} OPEN` : 'NONE OPEN'}
        </span>
      </div>
      {flags.length === 0 ? (
        <p className="m-0 px-4 py-4 text-[14px] text-ink-3">Nothing flagged in the last 7 days.</p>
      ) : flags.map(f => (
        <FlagRow key={f.lineId} f={f} now={now} busy={fixing.has(f.lineId)} onFix={() => markFixed(f)} />
      ))}
    </section>
  )
  // Desktop: the picked card, else the first station that is behind, else the first.
  const deskStation = stations.find(s => s.id === openId)
    ?? working.find(s => s.status.tone === 'red')
    ?? stations[0]
    ?? null

  return (
    <div className="max-w-[640px] lg:max-w-none mx-auto w-full flex flex-col gap-4">
      {/* Phones waiting for an OK show as the red count on Sign-ins. */}
      <ChecklistTabs active="board" />
      <header className="flex items-center justify-between gap-3">
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

      <section className="flex flex-col gap-2">
        <div className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">{crumb}</div>
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">{phase === 'OPEN' ? 'Opening' : 'Closing'}</h1>
        {lede && <p className="m-0 text-[15px] leading-[1.45] text-ink-2">{lede}</p>}
      </section>

      {!allowed ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">This board is for leads and managers.</div>
      ) : !ready || (activeRcId && !view && !loadError) ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
      ) : !activeRcId ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Pick a kitchen in the top bar to see its stations.</div>
      ) : !view ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
          <p className="m-0 text-[14px] text-red-text">{loadError}</p>
          <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
        </div>
      ) : (
        desk ? (
          <div className="grid grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px] gap-5 items-start">
            {stations.length === 0 ? (
              <p className="m-0 bg-paper border border-line rounded-[14px] px-4 py-4 text-[14px] text-ink-3">No stations are set up for this kitchen yet.</p>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {stations.map(s => (
                  <StationCard key={s.id} s={s} selected={deskStation?.id === s.id} onSelect={() => setOpenId(s.id)} />
                ))}
              </div>
            )}
            <aside className="sticky top-[60px] max-h-[calc(100dvh-76px)] overflow-y-auto flex flex-col gap-3">
              {deskStation && <StationDetail s={deskStation} />}
              {flagSection}
            </aside>
          </div>
        ) : (
        <>
          <section aria-label="Stations" className="bg-paper border border-line rounded-[14px] overflow-hidden">
            <div className="flex justify-between items-baseline px-4 py-3 border-b border-line">
              <span className="text-[13.5px] font-semibold tracking-[-0.01em]">Stations</span>
              <span className="font-mono text-[10.5px] text-ink-3">{doneCount} OF {stations.length} DONE</span>
            </div>
            {stations.length === 0 ? (
              <p className="m-0 px-4 py-4 text-[14px] text-ink-3">No stations are set up for this kitchen yet.</p>
            ) : stations.map(s => (
              <StationRow key={s.id} s={s} open={openId === s.id} onToggle={() => setOpenId(id => (id === s.id ? null : s.id))} />
            ))}
          </section>

          {flagSection}
        </>
        )
      )}
    </div>
  )
}
