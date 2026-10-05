'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, ChevronRight, Hourglass } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { useRc } from '@/contexts/RevenueCenterContext'
import { setScopeParams } from '@/lib/scope-params'
import { serviceStatus, type RcService } from '@/lib/service-hours'
import { planDayContext, withLadderTimes, PLAN_URG_META } from '@/lib/prep-plan'
import { useNowMinute } from '@/components/prep/runsheet/useNowMinute'
import { ymd } from '@/components/temps/temp-utils'
import type { PrepItemRich } from '@/components/prep/types'
import { clockText, tempNeeds, fmtTimeOfDay, type StartTempUnit } from '@/lib/start-page'
import { cookBoard, makeText, type CookJob } from '@/lib/cook-start'
import { greetingFor, crumbDate } from './parts'

// The cook's start page (/today for STAFF, phone and line iPad). One question:
// what do I cook next? Rules in src/lib/cook-start.ts. No money anywhere.

interface Me { id: string; name: string; initials: string; homeStation: string | null }
interface CountSession { id: string; status: string; label: string; counts?: { total: number; counted: number } }
type Row = PrepItemRich

const getJson = (url: string) =>
  fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)

export function CookStart() {
  const { user } = useUser()
  const { activeRcId, activeRc, activeKind, activeLocationId, ready } = useRc()
  const { nowMs, nowMin } = useNowMinute()
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [items, setItems] = useState<PrepItemRich[] | null>(null)
  const [temps, setTemps] = useState<StartTempUnit[]>([])
  const [count, setCount] = useState<CountSession | null>(null)

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const scope = new URLSearchParams()
    setScopeParams(scope, { activeKind, activeRcId, activeRc, activeLocationId })
    const qs = scope.toString() ? `?${scope}` : ''
    const tempQs = new URLSearchParams(scope)
    tempQs.set('date', ymd(new Date()))
    const load = () => {
      getJson('/api/prep/me').then(v => { if (!cancelled) setMe(v?.cook ?? null) })
      getJson(`/api/prep/items${qs}`).then(v => { if (!cancelled) setItems(Array.isArray(v) ? v : []) })
      getJson(`/api/temps/units?${tempQs}`).then(v => { if (!cancelled) setTemps(Array.isArray(v) ? v : []) })
      getJson(`/api/count/sessions${qs}`).then((v: CountSession[] | null) => {
        if (!cancelled) setCount(Array.isArray(v) ? v.find(s => s.status === 'IN_PROGRESS') ?? null : null)
      })
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [ready, activeKind, activeRcId, activeRc, activeLocationId])

  const services = useMemo<RcService[]>(
    () => (activeKind === 'rc' ? ((activeRc?.services ?? []) as RcService[]) : []),
    [activeKind, activeRc],
  )
  const status = serviceStatus(services, nowMin, activeRc?.prepLeadMinutes ?? null)
  const clock = clockText(status, nowMin)
  // Same ladder the To Do builds, so "resting until 8:25" matches the run sheet.
  const ctx = useMemo(() => planDayContext(services, nowMin), [services, nowMin])
  const rows = useMemo<Row[]>(
    () => (items ? withLadderTimes(items, ctx, { nowMs, nowMin }) : []),
    [items, ctx, nowMs, nowMin],
  )
  const board = useMemo(() => cookBoard(rows, me?.id ?? null), [rows, me])
  // "Take it" puts an unclaimed job under this cook — the same assignment the
  // To Do's claim pill writes (PUT /api/prep/logs/[id] { assignedTo }). Grabs are
  // posted jobs, so their log already exists. The row moves into My jobs at once.
  const [taking, setTaking] = useState<string | null>(null)
  const [takeError, setTakeError] = useState<string | null>(null)
  const takeJob = async (item: PrepItemRich, cook: Me) => {
    const logId = item.todayLog?.id
    if (!logId) return
    setTaking(item.id); setTakeError(null)
    try {
      const res = await fetch(`/api/prep/logs/${logId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assignedTo: cook.id }),
      })
      if (!res.ok) throw new Error()
      setItems(prev => prev?.map(i => i.id === item.id
        ? { ...i, assignedCook: { id: cook.id, initials: cook.initials, name: cook.name, homeStation: cook.homeStation }, todayLog: i.todayLog ? { ...i.todayLog, assignedTo: cook.id } : i.todayLog }
        : i) ?? prev)
    } catch {
      setTakeError(`Could not take ${item.name} — try again.`)
    } finally {
      setTaking(null)
    }
  }

  const tempRow = tempNeeds(temps).find(t => t.id === 'temp-missing') ?? tempNeeds(temps)[0] ?? null

  const loaded = items !== null && me !== undefined
  const name = me?.name.split(' ')[0] ?? (user?.name || user?.email?.split('@')[0] || 'chef').split(' ')[0]
  const now = new Date()
  const left = board.jobs.length
  const pct = board.total > 0 ? Math.round((board.done / board.total) * 100) : 0
  const svc = status.kind === 'upcoming' ? status.service.name.toLowerCase() : null

  return (
    <div className="flex flex-col gap-4 pt-2">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
            {crumbDate(now)}{me?.homeStation && <> · {me.homeStation.toUpperCase()}</>}
          </div>
          <h1 className="mt-1.5 text-[28px] md:text-[32px] font-semibold tracking-[-0.03em] leading-[1.1]">
            Good {greetingFor(now)}, <em className="font-fraunces italic font-medium text-gold-2">{name}</em>.
          </h1>
          <p className="mt-1.5 text-[15px] leading-[1.45] text-ink-2 [&_b]:font-semibold">
            {!loaded ? 'Loading…'
              : board.total === 0 ? (me ? 'Nothing on the To Do for you yet.' : 'The To Do has not been posted yet.')
              : left === 0 && board.doing.length === 0 ? <>All {me ? 'your' : 'the'} jobs are done. Nice work.</>
              : <>{me ? 'You have' : 'The kitchen has'} <b>{left} {left === 1 ? 'job' : 'jobs'}</b> to start{svc ? ` before ${svc}` : ''}.</>}
          </p>
        </div>

        <Link href="/prep" className="block bg-ink text-paper rounded-2xl p-[18px] md:min-w-[300px] shrink-0">
          <div className="flex justify-between items-end gap-4">
            {clock ? (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">{clock.label}</div>
                <div className="text-[36px] font-semibold tracking-[-0.04em] leading-none mt-1 tabular-nums">{clock.big}</div>
              </div>
            ) : <div />}
            <div className="text-right">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">{me ? 'My jobs done' : 'Jobs done'}</div>
              <div className="text-[22px] font-semibold tracking-[-0.03em] mt-1">
                {loaded ? <>{board.done}<span className="text-[14px] font-medium text-ink-4"> / {board.total}</span></> : '—'}
              </div>
            </div>
          </div>
          {board.total > 0 && (
            <div className="h-1.5 rounded-full bg-ink-2 overflow-hidden mt-3.5">
              <div className="h-full bg-green" style={{ width: `${pct}%` }} />
            </div>
          )}
        </Link>
      </header>

      {count && (
        <Link href="/count" className="flex items-center gap-3 bg-paper border border-gold-soft rounded-[14px] p-3.5 min-h-[64px]">
          <span className="flex-1 min-w-0">
            <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-gold-2">Count in progress</span>
            <span className="block text-[15px] font-semibold mt-0.5">{count.label}</span>
          </span>
          <span className="text-[13px] font-medium text-gold-2 inline-flex items-center gap-1">Resume <ArrowRight size={14} /></span>
        </Link>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:items-start">
        <section aria-label={me ? 'My jobs' : 'Jobs'} className="min-w-0">
          {board.doing.length > 0 && (
            <div className="flex flex-col gap-2 mb-4">
              {board.doing.map(t => <DoingRow key={t.id} t={t} />)}
            </div>
          )}

          <div className="flex items-baseline justify-between px-0.5 mb-2">
            <h2 className="text-[15px] font-semibold">{me ? 'My jobs' : 'Jobs to start'}</h2>
            <span className="font-mono text-[10.5px] text-ink-3">in the To Do order</span>
          </div>
          {!loaded ? (
            <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
          ) : board.jobs.length === 0 ? (
            <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">
              {board.total > 0 ? 'Nothing left to start.'
                : me ? 'Nothing given to you yet — take one from Up for grabs, or ask the chef.'
                : 'Nothing posted yet — check with the chef.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {board.jobs.map((j, i) => <JobRow key={j.item.id} j={j} first={i === 0} showCook={!me} />)}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4 min-w-0">
          {me && board.grabs.length > 0 && (
            <section aria-label="Up for grabs">
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-red-text px-0.5 mb-2">Up for grabs · nobody on it</div>
              <div className="flex flex-col gap-2">
                {board.grabs.map(j => (
                  <div key={j.item.id} className="flex items-center gap-3 bg-paper border border-red-soft rounded-[14px] p-3.5 min-h-[64px]">
                    <Link href={`/prep?item=${j.item.id}`} className="flex-1 min-w-0">
                      <span className="block text-[15px] font-semibold">{j.item.name}</span>
                      <span className="block text-[12.5px] text-ink-3 mt-0.5">{j.stepLabel}{j.item.station ? ` · ${j.item.station}` : ' · any station'}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => takeJob(j.item, me)}
                      disabled={taking === j.item.id}
                      className="text-[13px] font-medium text-ink-2 border border-line-2 rounded-[10px] px-3.5 min-h-[44px] hover:border-ink-3 disabled:opacity-60"
                    >
                      {taking === j.item.id ? 'Taking…' : 'Take it'}
                    </button>
                  </div>
                ))}
              </div>
              {takeError && <p className="text-[12.5px] text-red-text mt-2 px-0.5">{takeError}</p>}
            </section>
          )}

          {tempRow && (
            <Link href="/temps" className="flex items-center gap-3 bg-paper border border-line rounded-[14px] p-3.5 min-h-[64px]">
              <span className="w-2.5 h-2.5 rounded-full bg-red shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-semibold">{tempRow.id === 'temp-missing' ? 'Log temps' : tempRow.title}</span>
                <span className="block text-[12.5px] text-ink-3 mt-0.5">{tempRow.id === 'temp-missing' ? `${tempRow.detail} — not done today` : tempRow.detail}</span>
              </span>
              <ChevronRight size={17} className="text-ink-4 shrink-0" />
            </Link>
          )}

          {loaded && !me && (
            <p className="text-[12.5px] text-ink-3 px-0.5">
              Showing everyone&apos;s jobs. To see only yours, ask a manager to link your login to your name on the crew list.
            </p>
          )}
        </aside>
      </div>
    </div>
  )
}

function DoingRow({ t }: { t: Row }) {
  const rest = t.rest
  return (
    <Link href={`/prep?item=${t.id}`} className="flex items-center gap-3 bg-blue-soft border border-blue-soft rounded-[14px] p-3.5 min-h-[64px]">
      <span className="flex-1 min-w-0">
        <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-blue-text">
          {rest ? 'Resting' : 'Cooking now'}{t.assignedCook ? ` · ${t.assignedCook.name.split(' ')[0]}` : ''}
        </span>
        <span className="block text-[15px] font-semibold mt-0.5 text-ink">
          {t.name}{rest ? ` — ${rest.stage.name.toLowerCase()}` : ''}
        </span>
        {rest && (
          <span className="flex items-center gap-1 text-[12.5px] text-blue-text mt-0.5">
            <Hourglass size={12} />
            {rest.state === 'resting' ? `Next step at ${fmtTimeOfDay(rest.readyAtMin)}` : 'Ready for the next step'}
          </span>
        )}
      </span>
      <span className="text-[13px] font-medium text-blue-text bg-paper border border-blue-soft rounded-[10px] px-3.5 min-h-[44px] inline-flex items-center">Open</span>
    </Link>
  )
}

function JobRow({ j, first, showCook }: { j: CookJob<Row>; first: boolean; showCook: boolean }) {
  const t = j.item
  const meta = PLAN_URG_META[j.urg]
  const make = makeText(t)
  const mins = t.activeMinutes ?? t.estimatedPrepTime
  const note = t.todayLog?.note?.trim()
  const bits = [make, mins ? `${mins} min` : null].filter(Boolean)
  const who = showCook ? (t.assignedCook?.name.split(' ')[0] ?? null) : undefined
  return (
    <Link href={`/prep?item=${t.id}`} className="block bg-paper border border-line rounded-[14px] p-3.5 md:p-4">
      {/* Phones stack the step pill under the name so the details keep the width. */}
      <span className="flex flex-col items-start gap-1.5 md:flex-row md:items-center md:gap-3">
        <span className="flex-1 min-w-0">
          <span className="block text-[16px] md:text-[18px] font-semibold text-ink">{t.name}</span>
          <span className="block text-[12.5px] md:text-[13.5px] mt-0.5 text-ink-3">
            {bits.join(' · ')}
            {who !== undefined && (
              <>{bits.length > 0 && ' · '}{who ?? <span className="text-red-text font-medium">Nobody yet</span>}</>
            )}
          </span>
        </span>
        <span className={`text-[11.5px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${meta.softClass} ${meta.textClass}`}>{meta.label}</span>
      </span>
      {t.blockedReason && (
        <span className="block mt-2 text-[12.5px] font-medium text-gold-2">{t.blockedReason}</span>
      )}
      {note && (
        <span className="block mt-2.5 text-[13px] text-ink-2 bg-gold-soft rounded-lg px-2.5 py-2">Chef: “{note}”</span>
      )}
      {first && (
        <span className="mt-3 flex items-center justify-center bg-ink text-paper rounded-[10px] min-h-[46px] text-[14px] font-semibold">Open and start</span>
      )}
    </Link>
  )
}
