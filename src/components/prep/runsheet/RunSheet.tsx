'use client'
// Prep run-sheet — desktop frame.
// Ported from the prototype's PTDesktop (scratchpad/prototype-ref/desktop.jsx):
// status band, Kitchen/My-station segmented, crew strip / cook picker, station
// filter, in-progress rail, the grouped ladder (renderLadder: time / station /
// priority), the NOW divider, and the collapsible Done section. The prototype's
// DSidebar (the app has its own nav), tweaks slider, and clock slider are
// dropped — real props drive everything instead. Flat Tailwind tokens replace
// the hex palette; mono via `font-mono`; Lucide icons.
import { useState, useMemo, useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { RunRow } from './RunRow'
import { InProgressRail } from './InProgressRail'
import { CrewStrip } from './CrewStrip'
import { GroupHead } from './GroupHead'
import { NowLine } from './NowLine'
import { Segmented } from './atoms'
import { fmtClock, fmtDuration, runState } from '@/lib/prep-runsheet'

type Mode = 'kitchen' | 'station'
type Group = 'time' | 'station' | 'priority'

// Local port of the prototype's `ptFmtQ` (same rule as RunRow/InProgressRail):
// kg/L show one decimal only when fractional, everything else rounds to a whole.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

// Minutes-since-midnight for a done item's completion timestamp — the Done
// section shows a wall-clock stamp the same way CrewStrip derives elapsed.
function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

// PARTIAL is a reachable resolved state (onDrawerComplete sets it when the logged
// qty falls short of suggestedQty) — treat DONE/PARTIAL as done-equivalent everywhere.
const isDone = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
const isDoing = (i: PrepItemRich) => i.todayLog?.status === 'IN_PROGRESS'
const isTodo = (i: PrepItemRich) => !isDone(i) && !isDoing(i)
const sbOr = (i: PrepItemRich) => i.startByMinutes ?? Infinity

export function RunSheet({
  items,
  cooks,
  nowMin,
  nowMs,
  onStart,
  onReopen,
  onLog,
  onClaim,
  onOpenRecipe,
}: {
  items: PrepItemRich[]
  cooks: Cook[]
  nowMin: number
  nowMs: number
  onStart: (item: PrepItemRich) => void
  onReopen: (item: PrepItemRich) => void
  onLog: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const [mode, setMode] = useState<Mode>('kitchen')
  const [cook, setCook] = useState<string | null>(cooks[0]?.id ?? null)
  const [group, setGroup] = useState<Group>('time')
  const [stFilter, setStFilter] = useState<string>('all')
  const [showDone, setShowDone] = useState(false)

  // `cooks` can arrive after mount (async fetch) — the initial useState only ran
  // once with an empty roster. Without this, My-station mode is stuck with cook
  // === null forever, showing an empty ladder.
  useEffect(() => {
    if (cook == null && cooks.length > 0) setCook(cooks[0].id)
  }, [cooks, cook])

  // Stations present in the current dataset (the prototype's static PT_STATIONS).
  const stations = useMemo(
    () => [...new Set(items.map(i => i.station).filter((s): s is string => !!s))].sort(),
    [items],
  )

  const member = cook ? cooks.find(c => c.id === cook) ?? null : null
  const isMine = (i: PrepItemRich) =>
    i.assignedCook?.id === cook || (!i.assignedCook && !!member && i.station === member.homeStation)
  const inScope = (i: PrepItemRich) =>
    mode === 'station' ? isMine(i) : stFilter === 'all' || i.station === stFilter

  const doing = useMemo(() => items.filter(i => isDoing(i) && inScope(i)), [items, mode, cook, stFilter, member])
  const done = useMemo(() => items.filter(isDone), [items])
  const todo = useMemo(
    () => items.filter(i => isTodo(i) && inScope(i)).sort((a, b) => sbOr(a) - sbOr(b)),
    [items, mode, cook, stFilter, member],
  )

  // Kitchen-mode badge = everything not yet done.
  const notDone = useMemo(() => items.filter(i => !isDone(i)), [items])
  const lateN = useMemo(
    () => items.filter(i => isTodo(i) && runState({ startBy: i.startByMinutes, blockedReason: i.blockedReason }, nowMin) === 'overdue').length,
    [items, nowMin],
  )
  const blockedN = todo.filter(i => i.isBlocked || !!i.blockedReason).length

  // Next upcoming service across the visible items.
  const nextSvc = useMemo(() => {
    const map = new Map<string, { id: string; name: string; timeMinutes: number }>()
    for (const i of items) if (i.service) map.set(i.service.id, i.service)
    return [...map.values()].filter(s => s.timeMinutes > nowMin).sort((a, b) => a.timeMinutes - b.timeMinutes)[0] ?? null
  }, [items, nowMin])

  const handsOn = (list: PrepItemRich[]) => fmtDuration(list.reduce((a, i) => a + (i.activeMinutes ?? 0), 0))

  const rowProps = { nowMin, cooks, onStart, onOpenRecipe, onClaim }
  const rows = (list: PrepItemRich[]) => (
    <div className="flex flex-col gap-2">
      {list.map(i => <RunRow key={i.id} item={i} {...rowProps} />)}
    </div>
  )

  const renderLadder = () => {
    if (group === 'station') {
      return stations.map(s => {
        const grp = todo.filter(i => i.station === s)
        if (!grp.length) return null
        const late = grp.filter(i => runState({ startBy: i.startByMinutes, blockedReason: i.blockedReason }, nowMin) === 'overdue').length
        return (
          <div key={s}>
            <GroupHead dot="bg-ink-3" title={s} count={grp.length} sub={late ? `${late} late to start` : null} />
            {rows(grp)}
          </div>
        )
      })
    }
    if (group === 'priority') {
      const defs: [string, string, string, string][] = [
        ['911', 'bg-red', 'Critical', 'stock out — make first'],
        ['NEEDED_TODAY', 'bg-gold', 'Needed today', 'below par before service'],
        ['LATER', 'bg-ink-4', 'Later', 'can slip to the afternoon'],
      ]
      return defs.map(([k, dot, title, sub]) => {
        const grp = todo.filter(i => i.priority === k)
        if (!grp.length) return null
        return (
          <div key={k}>
            <GroupHead dot={dot} title={title} count={grp.length} sub={sub} />
            {rows(grp)}
          </div>
        )
      })
    }
    // time (default): overdue → NOW line → within the hour → later this morning → afternoon
    const overdue = todo.filter(i => i.startByMinutes != null && i.startByMinutes < nowMin)
    const soon = todo.filter(i => i.startByMinutes != null && i.startByMinutes >= nowMin && i.startByMinutes < nowMin + 60)
    const morning = todo.filter(i => i.startByMinutes != null && i.startByMinutes >= nowMin + 60 && i.startByMinutes < 720)
    const aftThreshold = Math.max(nowMin + 60, 720)
    const aft = todo.filter(i => i.startByMinutes == null || i.startByMinutes >= aftThreshold)
    return (
      <>
        {overdue.length > 0 && (
          <div>
            <GroupHead dot="bg-red" title="Late to start" count={overdue.length} sub="won't be ready for service unless started now" />
            {rows(overdue)}
          </div>
        )}
        <div className="my-[18px]"><NowLine nowMin={nowMin} /></div>
        {soon.length > 0 && (
          <div>
            <GroupHead dot="bg-ink" title="Start within the hour" count={soon.length} sub={`${handsOn(soon)} hands-on`} />
            {rows(soon)}
          </div>
        )}
        {morning.length > 0 && (
          <div>
            <GroupHead dot="bg-ink-3" title="Later this morning" count={morning.length} sub={`${handsOn(morning)} hands-on`} />
            {rows(morning)}
          </div>
        )}
        {aft.length > 0 && (
          <div>
            <GroupHead dot="bg-ink-4" title="Afternoon · for dinner" count={aft.length} sub={`${handsOn(aft)} hands-on`} />
            {rows(aft)}
          </div>
        )}
        {!todo.length && (
          <div className="font-mono text-[11px] text-ink-4 text-center py-9">
            LIST CLEAR — EVERYTHING STARTED OR DONE
          </div>
        )}
      </>
    )
  }

  const donePct = items.length ? (done.length / items.length) * 100 : 0
  const doingPct = items.length ? (doing.length / items.length) * 100 : 0
  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <div className="max-w-[1010px] mx-auto tracking-[-0.005em]">
      {/* header */}
      <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.02em] mb-[9px] uppercase">Today / Prep</div>
      <div className="flex items-start justify-between gap-5 mb-4">
        <div>
          <h1 className="text-[32px] font-semibold tracking-[-0.04em] m-0 mb-[5px] leading-none">Prep run sheet</h1>
          <div className="text-[13px] text-ink-3">
            {todayLabel} · ordered by <b className="text-ink font-medium">start-by time</b> — hands-on + oven/rest time, counted back from service
          </div>
        </div>
        <Segmented<Mode>
          value={mode}
          onPick={setMode}
          className="shrink-0"
          options={[
            { id: 'kitchen', label: 'Kitchen', badge: notDone.length },
            { id: 'station', label: 'My station' },
          ]}
        />
      </div>

      {/* status band */}
      <div className="flex items-center gap-6 bg-paper border border-line rounded-[13px] px-5 py-[15px] mb-4">
        <div className="shrink-0">
          <div className="text-[26px] font-semibold tracking-[-0.04em] leading-none">
            {done.length}<span className="text-ink-4 font-medium">/{items.length}</span>
          </div>
          <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 mt-1">DONE</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex h-2 rounded-full overflow-hidden bg-bg-2 gap-0.5">
            {done.length > 0 && <div className="bg-green" style={{ width: `${donePct}%` }} />}
            {doing.length > 0 && <div className="bg-gold" style={{ width: `${doingPct}%` }} />}
          </div>
          <div className="flex gap-3.5 mt-[9px] font-mono text-[10px] text-ink-3">
            <span><b className="text-gold-2 font-semibold">{doing.length}</b> in progress</span>
            <span><b className={`font-semibold ${lateN ? 'text-red-text' : 'text-ink'}`}>{lateN}</b> late to start</span>
            <span><b className="text-ink font-semibold">{blockedN}</b> blocked on stock</span>
          </div>
        </div>
        <div className="shrink-0 text-right border-l border-line pl-[22px]">
          <div className="font-mono text-[20px] font-semibold tracking-[-0.02em]">{fmtClock(nowMin)}</div>
          <div className="font-mono text-[9.5px] text-ink-3 mt-[3px]">
            {nextSvc ? `${nextSvc.name} in ${fmtDuration(nextSvc.timeMinutes - nowMin)}` : 'ALL SERVICES STARTED'}
          </div>
        </div>
      </div>

      {/* crew (kitchen) or cook picker (station) */}
      {mode === 'kitchen' ? (
        cooks.length > 0 && <CrewStrip cooks={cooks} items={items} nowMin={nowMin} />
      ) : (
        <div className="flex items-center gap-2 mb-[18px] flex-wrap">
          <span className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 mr-1">COOK</span>
          {cooks.map(c => {
            const on = cook === c.id
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCook(c.id)}
                className={`inline-flex items-center gap-1.5 px-[13px] py-[7px] rounded-full border font-mono text-[11px] font-semibold cursor-pointer ${
                  on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-2'
                }`}
              >
                {c.initials}
                <span className={`text-[9px] font-normal ${on ? 'text-line-2' : 'text-ink-4'}`}>{c.homeStation ?? ''}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* station filter (kitchen) + grouping control */}
      <div className="flex items-center gap-2 flex-wrap">
        {mode === 'kitchen' && (
          <div className="flex gap-1.5 flex-wrap">
            {['all', ...stations].map(s => {
              const on = stFilter === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStFilter(s)}
                  className={`px-3 py-1.5 rounded-full border font-mono text-[10.5px] font-medium cursor-pointer capitalize ${
                    on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-3'
                  }`}
                >
                  {s === 'all' ? `All · ${todo.length + doing.length}` : s}
                </button>
              )
            })}
          </div>
        )}
        <div className="ml-auto">
          <Segmented<Group>
            value={group}
            onPick={setGroup}
            options={[
              { id: 'time', label: 'Time' },
              { id: 'station', label: 'Station' },
              { id: 'priority', label: 'Priority' },
            ]}
          />
        </div>
      </div>

      {/* in-progress rail */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="parallel timers — mark done to log yield" />
          <InProgressRail items={doing} nowMs={nowMs} cooks={cooks} onLog={onLog} onOpenRecipe={onOpenRecipe} />
        </>
      )}

      {/* ladder */}
      {renderLadder()}

      {/* done */}
      {done.length > 0 && (
        <div className="mt-[22px]">
          <button
            type="button"
            onClick={() => setShowDone(s => !s)}
            className="flex items-center gap-2 w-full bg-transparent border border-dashed border-line-2 rounded-[10px] px-3.5 py-2.5 cursor-pointer font-mono text-[10.5px] text-ink-3 tracking-[0.03em]"
          >
            <RotateCcw size={13} className={`text-ink-4 transition-transform ${showDone ? 'rotate-180' : ''}`} />
            DONE · {done.length} — yields logged, feeds history
          </button>
          {showDone && (
            <div className="flex flex-col gap-1.5 mt-2">
              {done.map(i => {
                const doneMin = i.todayLog?.completedAt ? minuteOfDay(i.todayLog.completedAt) : null
                const qty = i.todayLog?.actualPrepQty ?? i.suggestedQty ?? i.targetToday ?? i.parLevel
                return (
                  <div
                    key={i.id}
                    className="grid grid-cols-[64px_1fr_auto_auto] items-center gap-4 bg-paper border border-line rounded-[10px] px-4 py-[9px]"
                  >
                    <span className="font-mono text-[11px] text-ink-4">{doneMin != null ? fmtClock(doneMin) : '—'}</span>
                    <span className="text-[13px] font-medium text-ink-3 line-through">{i.name}</span>
                    <span className="font-mono text-[11px] font-semibold text-green-text">{fmtQty(qty, i.unit)} logged</span>
                    <button
                      type="button"
                      onClick={() => onReopen(i)}
                      title="Reopen"
                      className="w-7 h-7 rounded-[8px] bg-transparent border border-line grid place-items-center cursor-pointer text-ink-3"
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
