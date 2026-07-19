'use client'
// Prep run-sheet — mobile frame.
// Ported from the prototype's PTMobile (scratchpad/prototype-ref/mobile.jsx):
// header (date / now / next-service), My-station|Kitchen segmented (default
// station), horizontal cook picker, in-progress rail, station mode = NextUpHero
// + "Coming up" queue, kitchen mode = time sections, and a collapsible Done.
// The prototype's recipe/log bottom-sheets are dropped — the fused PrepDrawer
// (onOpenRecipe) and PrepDoneSheet (onLog) are the real surfaces, opened via
// props. Flat Tailwind tokens replace the hex palette; mono via `font-mono`.
import { useState, useMemo, useEffect } from 'react'
import { ChefHat, ChevronDown, RotateCcw } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { RunRowMobile } from './RunRowMobile'
import { InProgressRailMobile } from './InProgressRailMobile'
import { NextUpHero } from './NextUpHero'
import { GroupHead } from './GroupHead'
import { NowLine } from './NowLine'
import { Segmented } from './atoms'
import { IcCheck } from '@/components/prep/icons'
import { fmtClock, fmtDuration, runState } from '@/lib/prep-runsheet'

type Mode = 'station' | 'kitchen'

// Local port of the prototype's `ptFmtQ` — kg/L show one decimal only when
// fractional, everything else rounds to a whole. Same rule as the row/hero/rail.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

// PARTIAL is a reachable resolved state (mirrors RunSheet's isDone) — do NOT
// treat it as todo.
const isDone = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
const isDoing = (i: PrepItemRich) => i.todayLog?.status === 'IN_PROGRESS'
const isTodo = (i: PrepItemRich) => !isDone(i) && !isDoing(i)
const sbOr = (i: PrepItemRich) => i.startByMinutes ?? Infinity

export function RunSheetMobile({
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
  const [mode, setMode] = useState<Mode>('station')
  const [cook, setCook] = useState<string | null>(cooks[0]?.id ?? null)
  const [showDone, setShowDone] = useState(false)

  // `cooks` can arrive after mount (async fetch) — same null-guard the desktop
  // RunSheet uses so My-station isn't stuck with cook === null forever.
  useEffect(() => {
    if (cook == null && cooks.length > 0) setCook(cooks[0].id)
  }, [cooks, cook])

  const member = cook ? cooks.find(c => c.id === cook) ?? null : null
  const isMine = (i: PrepItemRich) =>
    i.assignedCook?.id === cook || (!i.assignedCook && !!member && i.station === member.homeStation)

  const todoAll = useMemo(
    () => items.filter(isTodo).sort((a, b) => sbOr(a) - sbOr(b)),
    [items],
  )
  const doingAll = useMemo(() => items.filter(isDoing), [items])
  const done = useMemo(() => items.filter(isDone), [items])

  const myTodo = useMemo(() => todoAll.filter(isMine), [todoAll, cook, member])
  const doing = mode === 'station' ? doingAll.filter(isMine) : doingAll
  const hero = myTodo[0]
  const queue = myTodo.slice(1)

  // Kitchen-mode badge = late-to-start count across the whole brigade.
  const lateN = useMemo(
    () => todoAll.filter(i => runState({ startBy: i.startByMinutes, blockedReason: i.blockedReason }, nowMin) === 'overdue').length,
    [todoAll, nowMin],
  )

  // Next upcoming service across the visible items.
  const nextSvc = useMemo(() => {
    const map = new Map<string, { id: string; name: string; timeMinutes: number }>()
    for (const i of items) if (i.service) map.set(i.service.id, i.service)
    return [...map.values()].filter(s => s.timeMinutes > nowMin).sort((a, b) => a.timeMinutes - b.timeMinutes)[0] ?? null
  }, [items, nowMin])

  const handsOn = (list: PrepItemRich[]) => fmtDuration(list.reduce((a, i) => a + (i.activeMinutes ?? 0), 0))

  // Claim toggle — assign to the viewing cook, or unassign if already theirs
  // (mirrors the prototype's `claimTap`).
  const claimTap = (item: PrepItemRich) => onClaim(item, item.assignedCook?.id === cook ? null : cook)

  const rows = (list: PrepItemRich[], kitchen: boolean) => (
    <div className="flex flex-col gap-[7px]">
      {list.map(i => (
        <RunRowMobile
          key={i.id}
          item={i}
          nowMin={nowMin}
          kitchen={kitchen}
          cook={member}
          onClaim={claimTap}
          onOpenRecipe={onOpenRecipe}
          onStart={onStart}
        />
      ))}
    </div>
  )

  // kitchen mode: time sections across the whole brigade.
  const renderKitchen = () => {
    const overdue = todoAll.filter(i => i.startByMinutes != null && i.startByMinutes < nowMin)
    const soon = todoAll.filter(i => i.startByMinutes != null && i.startByMinutes >= nowMin && i.startByMinutes < nowMin + 60)
    const rest = todoAll.filter(i => i.startByMinutes == null || i.startByMinutes >= nowMin + 60)
    return (
      <>
        {overdue.length > 0 && (
          <>
            <GroupHead dot="bg-red" title="Late to start" count={overdue.length} />
            {rows(overdue, true)}
          </>
        )}
        <div className="my-3.5"><NowLine nowMin={nowMin} /></div>
        {soon.length > 0 && (
          <>
            <GroupHead dot="bg-ink" title="Start within the hour" count={soon.length} />
            {rows(soon, true)}
          </>
        )}
        {rest.length > 0 && (
          <>
            <GroupHead dot="bg-ink-3" title="Later today" count={rest.length} />
            {rows(rest, true)}
          </>
        )}
        {!todoAll.length && (
          <div className="font-mono text-[11px] text-ink-4 text-center py-9">
            LIST CLEAR — EVERYTHING STARTED OR DONE
          </div>
        )}
      </>
    )
  }

  const todayLabel = new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()

  return (
    <div className="tracking-[-0.005em]">
      {/* header */}
      <div className="pt-1.5 pb-3">
        <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 mb-1.5">
          {todayLabel} · NOW {fmtClock(nowMin)}
          {nextSvc ? ` · ${nextSvc.name} IN ${fmtDuration(nextSvc.timeMinutes - nowMin)}` : ''}
        </div>
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.035em] leading-none">Prep list</h1>
      </div>

      <Segmented<Mode>
        value={mode}
        onPick={setMode}
        options={[
          { id: 'station', label: 'My station' },
          { id: 'kitchen', label: 'Kitchen', badge: lateN || null, badgeTone: lateN ? 'red' : undefined },
        ]}
      />

      {/* cook picker (station mode) */}
      {mode === 'station' && cooks.length > 0 && (
        <div className="flex gap-1.5 mt-3 overflow-x-auto">
          {cooks.map(c => {
            const on = cook === c.id
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCook(c.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-[7px] rounded-full shrink-0 border font-mono text-[10.5px] font-semibold cursor-pointer ${
                  on ? 'border-ink bg-ink text-paper' : 'border-line bg-paper text-ink-2'
                }`}
              >
                {c.initials}
                <span className={`text-[8.5px] font-normal ${on ? 'text-line-2' : 'text-ink-4'}`}>{c.homeStation ?? ''}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* in-progress rail */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="tap done to log yield" />
          {/* full-bleed horizontal scroll rail */}
          <div className="-mx-4 px-4">
            <InProgressRailMobile items={doing} nowMs={nowMs} onLog={onLog} onOpenRecipe={onOpenRecipe} />
          </div>
        </>
      )}

      {mode === 'station' ? (
        <>
          {hero ? (
            <NextUpHero item={hero} nowMin={nowMin} onStart={onStart} onOpenRecipe={onOpenRecipe} />
          ) : (
            <div className="text-center px-5 py-10 text-ink-3">
              <div className="w-[42px] h-[42px] rounded-full bg-bg-2 grid place-items-center mx-auto mb-2.5">
                <ChefHat size={20} className="text-ink-4" />
              </div>
              <div className="text-[13.5px] font-semibold text-ink-2">Station queue clear</div>
              <div className="text-[12px] mt-[3px]">Everything is started or done. Check the Kitchen tab to help out.</div>
            </div>
          )}
          {queue.length > 0 && (
            <>
              <GroupHead dot="bg-ink-3" title="Coming up" count={queue.length} sub={`${handsOn(queue)} hands-on`} />
              {rows(queue, false)}
            </>
          )}
        </>
      ) : (
        renderKitchen()
      )}

      {/* done */}
      {done.length > 0 && (
        <div className="mt-[18px]">
          <button
            type="button"
            onClick={() => setShowDone(s => !s)}
            className="flex items-center gap-2 w-full bg-transparent border border-dashed border-line-2 rounded-[10px] px-[13px] py-2.5 cursor-pointer font-mono text-[10px] text-ink-3 tracking-[0.03em]"
          >
            <ChevronDown size={12} className={`text-ink-4 transition-transform ${showDone ? 'rotate-180' : ''}`} />
            DONE · {done.length}
          </button>
          {showDone && (
            <div className="flex flex-col gap-1.5 mt-[7px]">
              {done.map(i => {
                const qty = i.todayLog?.actualPrepQty ?? i.suggestedQty ?? i.targetToday ?? i.parLevel
                return (
                  <div
                    key={i.id}
                    className="flex items-center gap-2.5 bg-paper border border-line rounded-[10px] px-3 py-[9px]"
                  >
                    <span className="w-[22px] h-[22px] rounded-[7px] bg-green grid place-items-center shrink-0">
                      <IcCheck size={13} className="text-white" strokeWidth={3} />
                    </span>
                    <span className="flex-1 min-w-0 text-[13px] font-medium text-ink-3 line-through whitespace-nowrap overflow-hidden text-ellipsis">
                      {i.name}
                    </span>
                    <span className="font-mono text-[10.5px] font-semibold text-green-text">{fmtQty(qty, i.unit)}</span>
                    <button
                      type="button"
                      onClick={() => onReopen(i)}
                      title="Reopen"
                      className="w-[26px] h-[26px] rounded-[7px] bg-transparent border border-line grid place-items-center cursor-pointer text-ink-3 shrink-0"
                    >
                      <RotateCcw size={12} />
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
