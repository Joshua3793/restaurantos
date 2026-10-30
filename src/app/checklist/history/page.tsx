'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { inRange, minusDays, pacificHHMM, runProgress, sharedRunComplete, shiftBusinessDate, type Phase } from '@/lib/checklists/rules'
import { historyCsv, type HistoryRun } from '@/lib/checklists/history-csv'
import type { HistoryDay, HistoryPeople, HistoryView } from '@/lib/checklists/history-types'
import type { LineView } from '@/lib/checklists/runs'
import { firstName, fmtReading, unitOf } from '@/components/checklists/LineRow'

// /checklist/history — MANAGER+ review of any day's opening and closing lists:
// who ticked what and when, filtered by person or station, exportable as CSV.
// Mobile first: one fluid column, capped at 640 px on a desktop.

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not load — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

const atUtcNoon = (d: string) => new Date(d + 'T12:00:00Z')
const part = (d: string, o: Intl.DateTimeFormatOptions) => atUtcNoon(d).toLocaleString('en-US', { ...o, timeZone: 'UTC' })

/** '2026-10-28' → 'Tue 28 Oct'. */
const dayLabel = (d: string) => `${part(d, { weekday: 'short' })} ${atUtcNoon(d).getUTCDate()} ${part(d, { month: 'short' })}`

/** Pacific clock time without a leading zero: '07:31' → '7:31'. */
const hhmm = (iso: string) => pacificHHMM(new Date(iso)).replace(/^0/, '')

const REASON_WORD: Record<NonNullable<LineView['flagReason']>, string> = {
  BROKEN: 'Broken', RAN_OUT: 'Ran out', OUT_OF_RANGE: 'Out of range', OTHER: 'Other',
}

const PHASES: { phase: Phase; title: string; word: string }[] = [
  { phase: 'CLOSE', title: 'Closing', word: 'closing' },
  { phase: 'OPEN', title: 'Opening', word: 'opening' },
]

// ── Derived facts about a run ──────────────────────────────────────────────

/** First and last time anything happened on a run (Pacific), as ISO strings. */
function activityRange(r: HistoryRun): { first: string; last: string } | null {
  const stamps = [
    ...r.lines.flatMap(l => [l.doneAt, l.resolvedAt]),
    r.signedOffAt,
  ].filter((x): x is string => !!x).sort()
  return stamps.length > 0 ? { first: stamps[0], last: stamps[stamps.length - 1] } : null
}

/** A shared run is never signed off; it is done when every job is handled. */
const runDone = (r: HistoryRun) => (r.isShared ? sharedRunComplete(r.lines) : r.status === 'SIGNED')

function runSummary(r: HistoryRun): string {
  const p = runProgress(r.lines)
  const act = activityRange(r)
  const lead = r.status === 'SIGNED' && r.signedOffAt
    ? `Signed off ${hhmm(r.signedOffAt)}`
    : act ? `Left ${hhmm(act.last)}` : 'Never started'
  const parts = [lead, `${p.handled}/${p.total}`]
  if (p.flagged > 0) parts.push(`${p.flagged} flagged`)
  if (r.status !== 'SIGNED' && p.blockersLeft > 0) {
    parts.push(`${p.blockersLeft} ${r.phase === 'OPEN' ? 'before-doors' : 'before-you-leave'} open`)
  }
  return parts.join(' · ')
}

type LogEntry = { key: string; at: string | null; what: string; sub: string; red: boolean }

function lineEntry(l: LineView): LogEntry {
  const unit = unitOf(l)
  const what = l.value != null ? `${l.title} · ${fmtReading(l.value, unit)}` : l.title
  const by = firstName(l.doneByName)
  if (l.status === 'FLAGGED') {
    const fixed = l.resolvedAt ? `Fixed${l.resolvedByName ? ` by ${firstName(l.resolvedByName)}` : ''} ${hhmm(l.resolvedAt)}` : ''
    const sub = [
      'Flagged',
      l.flagReason ? REASON_WORD[l.flagReason] : '',
      l.flagNote ? `“${l.flagNote}”` : '',
      by,
      fixed,
    ].filter(Boolean).join(' · ')
    return { key: l.id, at: l.doneAt, what, sub, red: !l.resolvedAt }
  }
  if (l.status === 'DONE') {
    const inRangeText = l.value != null && (l.safeMin != null || l.safeMax != null) && inRange(l.value, l.safeMin, l.safeMax)
      ? 'in range' : ''
    return { key: l.id, at: l.doneAt, what, sub: [by, inRangeText].filter(Boolean).join(' · '), red: false }
  }
  return { key: l.id, at: null, what, sub: 'Not done', red: false }
}

/** What happened, oldest first; jobs nobody touched go last. */
function runLog(r: HistoryRun): LogEntry[] {
  const done = r.lines.filter(l => l.status !== 'TODO').map(lineEntry)
  const untouched = r.lines.filter(l => l.status === 'TODO').map(lineEntry)
  if (r.status === 'SIGNED' && r.signedOffAt) {
    const note = r.handoverNote?.trim()
    done.push({
      key: 'signed',
      at: r.signedOffAt,
      what: `Signed off ${r.stationName}`,
      sub: [firstName(r.signedOffByName), note ? `note: “${note}”` : ''].filter(Boolean).join(' · '),
      red: false,
    })
  }
  done.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  return [...done, ...untouched]
}

/** "Pastry closing was never signed." / "A closing and B opening were never signed." */
function unsignedNames(runs: HistoryRun[]): string[] {
  return runs
    .filter(r => !r.isShared && r.status !== 'SIGNED')
    .map(r => `${r.stationName} ${r.phase === 'OPEN' ? 'opening' : 'closing'}`)
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function csvName(rcName: string | undefined, date: string): string {
  const slug = (rcName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `checklists-${slug || 'kitchen'}-${date}.csv`
}

// ── Pieces (module scope, so they never remount) ───────────────────────────

const PILL_BASE = 'min-h-[44px] rounded-full border border-line-2 bg-paper text-[13px] text-ink-2'

function DayStrip({ days, selected, onPick }: { days: HistoryDay[]; selected: string; onPick: (d: string) => void }) {
  const dot = { ok: 'bg-green', miss: 'bg-red', none: 'bg-transparent' } as const
  const hint = { ok: 'all signed off', miss: 'not all signed off', none: 'no lists' } as const
  return (
    <div role="group" aria-label="Day" className="grid grid-cols-7 gap-1">
      {days.map(d => {
        const on = d.date === selected
        return (
          <button
            key={d.date}
            type="button"
            aria-pressed={on}
            aria-label={`${dayLabel(d.date)}, ${hint[d.state]}`}
            onClick={() => onPick(d.date)}
            className={`min-h-[64px] rounded-[10px] border flex flex-col items-center justify-center gap-[3px] ${on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'}`}
          >
            <span className="font-mono text-[9.5px] tracking-[0.06em]">{part(d.date, { weekday: 'short' }).toUpperCase()}</span>
            <span className="font-mono text-[15px] font-semibold">{atUtcNoon(d.date).getUTCDate()}</span>
            <span className={`w-1.5 h-1.5 rounded-full ${dot[d.state]}`} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

function Select({ label, value, onChange, children }: {
  label: string; value: string; onChange: (v: string) => void; children: React.ReactNode
}) {
  return (
    <span className="relative inline-flex">
      <select
        aria-label={label}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`${PILL_BASE} appearance-none pl-3.5 pr-8 max-w-[180px] truncate`}
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-3" aria-hidden>▾</span>
    </span>
  )
}

function LogList({ entries }: { entries: LogEntry[] }) {
  return (
    <ol className="list-none m-0 pt-1 pb-2.5 pl-[34px] pr-4 flex flex-col">
      {entries.map(e => (
        <li key={e.key} className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5 py-[7px] border-b border-bg-2 last:border-b-0">
          <span className="font-mono text-[11px] font-semibold text-ink-2">{e.at ? hhmm(e.at) : '—'}</span>
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className={`text-[13.5px] ${e.at ? 'text-ink' : 'text-ink-3'}`}>{e.what}</span>
            {e.sub && <span className={`font-mono text-[10.5px] ${e.red ? 'text-red-text' : 'text-ink-3'}`}>{e.sub}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function RunRow({ r, open, onToggle }: { r: HistoryRun; open: boolean; onToggle: () => void }) {
  const done = runDone(r)
  const crew = r.crew.map(c => firstName(c.userName)).filter(Boolean).join(', ')
  return (
    <div className="border-t border-bg-2 first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`w-full flex items-center gap-2.5 px-4 py-3 min-h-[44px] text-left ${open ? 'bg-bg-2' : ''}`}
      >
        <span className="flex-none w-2 h-2 rounded-full" style={{ background: r.color }} aria-hidden />
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          <span className="text-[14.5px] font-semibold tracking-[-0.015em]">{r.stationName}{crew ? ` · ${crew}` : ''}</span>
          <span className="font-mono text-[10.5px] text-ink-3">{runSummary(r)}</span>
        </span>
        <span className={`flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full whitespace-nowrap ${done ? 'bg-green-soft text-green-text' : 'bg-red-soft text-red-text'}`}>
          {r.isShared ? (done ? 'DONE' : 'NOT DONE') : done ? 'SIGNED' : 'NOT SIGNED'}
        </span>
        <span className="flex-none font-mono text-[11px] text-ink-3" aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open && (r.lines.length === 0
        ? <p className="m-0 px-4 pb-3 pt-1 font-mono text-[11px] text-ink-3">No jobs on this list.</p>
        : <LogList entries={runLog(r)} />)}
    </div>
  )
}

function PhaseCard({ title, word, runs, openIds, onToggle }: {
  title: string; word: string; runs: HistoryRun[]; openIds: ReadonlySet<string>; onToggle: (id: string) => void
}) {
  const signable = runs.filter(r => !r.isShared)
  const signed = signable.filter(r => r.status === 'SIGNED').length
  const stamps = runs.flatMap(r => { const a = activityRange(r); return a ? [a.first, a.last] : [] }).sort()
  const span = stamps.length > 0 ? `${hhmm(stamps[0])} – ${hhmm(stamps[stamps.length - 1])}` : ''
  const allSigned = signable.length > 0 && signed === signable.length
  const label = runs.length === 0
    ? 'NO LISTS'
    : [signable.length > 0 ? `${signed} OF ${signable.length} SIGNED` : '', span].filter(Boolean).join(' · ')
  return (
    <section aria-label={title} className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className={`flex justify-between items-baseline gap-3 px-4 py-3 ${runs.length > 0 ? 'border-b border-line' : ''}`}>
        <span className="text-[13.5px] font-semibold tracking-[-0.01em]">{title}</span>
        <span className={`font-mono text-[10.5px] ${allSigned ? 'text-green-text' : signable.length > signed ? 'text-red-text' : 'text-ink-3'}`}>{label}</span>
      </div>
      {runs.map(r => <RunRow key={r.id} r={r} open={openIds.has(r.id)} onToggle={() => onToggle(r.id)} />)}
      {runs.length === 0 && <span className="sr-only">No {word} lists on this day.</span>}
    </section>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────

type Filters = { rc: string | null; date: string | null; userId: string; stationId: string }
const NO_FILTERS = { date: null, userId: '', stationId: '' } as const

export default function ChecklistHistoryPage() {
  const { activeRcId, activeRc, ready } = useRc()
  const { role } = useUser()
  const toast = useToast()

  const [filters, setFilters] = useState<Filters>({ rc: null, ...NO_FILTERS })
  const [view, setView] = useState<HistoryView | null>(null)
  const [people, setPeople] = useState<HistoryPeople['people']>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())

  const allowed = !role || atLeast(role as Role, 'MANAGER')
  // A different kitchen starts clean: its date, person and station picks do not carry over.
  const f: Filters = filters.rc === activeRcId ? filters : { rc: activeRcId, ...NO_FILTERS }
  const update = (patch: Partial<Omit<Filters, 'rc'>>) => setFilters({ ...f, ...patch })

  // The last finished night: nothing later has a history yet.
  const latest = useMemo(() => shiftBusinessDate('CLOSE'), [])

  // Only the newest request may land; a slow reply for an older pick is dropped.
  const seq = useRef(0)

  const load = useCallback(async () => {
    if (!activeRcId) return
    const mine = ++seq.current
    setLoading(true)
    const qs = new URLSearchParams({ rcId: activeRcId })
    if (f.date) qs.set('date', f.date)
    if (f.userId) qs.set('userId', f.userId)
    if (f.stationId) qs.set('stationId', f.stationId)
    const r = await call<HistoryView>(`/api/checklists/history?${qs}`)
    if (mine !== seq.current) return
    setLoading(false)
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setView(r.data)
    setOpenIds(new Set())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRcId, f.date, f.userId, f.stationId])

  useEffect(() => {
    if (!ready || !allowed || !activeRcId) return
    load()
  }, [ready, allowed, activeRcId, load])

  // A different kitchen: drop the old kitchen's screen at once, then fetch its people.
  useEffect(() => {
    setView(null)
    setLoadError(null)
    setPeople([])
    if (!ready || !allowed || !activeRcId) return
    let live = true
    call<HistoryPeople>(`/api/checklists/history/people?rcId=${encodeURIComponent(activeRcId)}`).then(r => {
      if (live && r.ok) setPeople(r.data.people)
    })
    return () => { live = false }
  }, [ready, allowed, activeRcId])

  const toggle = (id: string) => setOpenIds(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const shown = view?.date ?? f.date ?? latest
  const step = (n: number) => update({ date: n > 0 && minusDays(shown, -n) > latest ? latest : minusDays(shown, -n) })

  const exportCsv = () => {
    if (!view || view.runs.length === 0) return
    try {
      // The BOM makes Excel read the file as UTF-8, so "°C" survives.
      const blob = new Blob(['﻿' + historyCsv(view.runs)], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = csvName(activeRc?.name, view.date)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      toast.show({ type: 'error', title: 'Could not make the file — try again.' })
    }
  }

  // ── Lede ───────────────────────────────────────────────────────────────
  const filtered = !!(f.userId || f.stationId)
  let lede: React.ReactNode = null
  if (view) {
    const day = <b className="font-mono font-semibold">{dayLabel(view.date)}.</b>
    const signable = view.runs.filter(r => !r.isShared)
    const signed = signable.filter(r => r.status === 'SIGNED').length
    const missed = unsignedNames(view.runs)
    if (view.runs.length === 0) {
      lede = <>{day} {filtered ? 'Nothing matches these filters.' : 'No lists were opened.'}</>
    } else if (signable.length === 0) {
      lede = <>{day} Only the whole-kitchen list was used.</>
    } else {
      lede = (
        <>
          {day} {signed} of {signable.length} {signable.length === 1 ? 'list' : 'lists'} signed off.
          {missed.length > 0 && (
            <> <b className="font-semibold text-red-text">{joinNames(missed)}</b> {missed.length === 1 ? 'was' : 'were'} never signed.</>
          )}
        </>
      )
    }
  }

  return (
    <div className="max-w-[640px] mx-auto w-full flex flex-col gap-3.5">
      <header className="flex items-center justify-between gap-3">
        <Link href="/checklist/today" className="text-[13px] text-ink-3 min-h-[44px] inline-flex items-center">‹ Today</Link>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!view || view.runs.length === 0}
          className="min-h-[44px] px-3 rounded-[9px] border border-line-2 bg-paper font-mono text-[11px] text-ink-2 disabled:opacity-50"
        >
          Export ↓
        </button>
      </header>

      <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">History</h1>

      {!allowed ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">History is for managers.</div>
      ) : !ready ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
      ) : !activeRcId ? (
        <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Pick a kitchen in the top bar to see its history.</div>
      ) : !view ? (
        loadError ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
            <p className="m-0 text-[14px] text-red-text">{loadError}</p>
            <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
        )
      ) : (
        <>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => step(-7)}
              aria-label="Previous 7 days"
              className="min-h-[44px] min-w-[44px] rounded-full font-mono text-[15px] text-ink-2"
            >
              ‹
            </button>
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">
              {view.days[0] ? `${dayLabel(view.days[0].date)} – ${dayLabel(view.days[6].date)}`.toUpperCase() : ''}
            </span>
            <button
              type="button"
              onClick={() => step(7)}
              disabled={view.date >= latest}
              aria-label="Next 7 days"
              className="min-h-[44px] min-w-[44px] rounded-full font-mono text-[15px] text-ink-2 disabled:opacity-30"
            >
              ›
            </button>
          </div>
          <DayStrip days={view.days} selected={view.date} onPick={d => update({ date: d })} />

          <div className="flex flex-wrap gap-2">
            <Select label="Person" value={f.userId} onChange={v => update({ userId: v })}>
              <option value="">Everyone</option>
              {people.map(p => <option key={p.userId} value={p.userId}>{p.name}</option>)}
            </Select>
            <Select label="Station" value={f.stationId} onChange={v => update({ stationId: v })}>
              <option value="">All stations</option>
              {view.stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <label className={`${PILL_BASE} inline-flex items-center gap-2 pl-3.5 pr-2.5`}>
              <span>Pick a date…</span>
              <input
                type="date"
                value={view.date}
                max={latest}
                onChange={e => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) update({ date: e.target.value }) }}
                className="bg-transparent font-mono text-[12px] text-ink-2 outline-none"
              />
            </label>
          </div>

          {loadError && <p className="m-0 text-[13px] text-red-text">{loadError}</p>}
          <p className="m-0 text-[15px] leading-[1.45] text-ink-2" aria-live="polite">{lede}</p>

          <div className={`flex flex-col gap-3.5 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
            {PHASES.map(p => (
              <PhaseCard
                key={p.phase}
                title={p.title}
                word={p.word}
                runs={view.runs.filter(r => r.phase === p.phase)}
                openIds={openIds}
                onToggle={toggle}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
