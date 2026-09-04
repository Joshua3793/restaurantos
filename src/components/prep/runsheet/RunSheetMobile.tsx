'use client'
// Prep run-sheet — mobile frame.
// Ported from the prototype's PTMobile (scratchpad/prototype-ref/mobile.jsx):
// header (date / now / next-service), My-station|Kitchen segmented (default
// station), horizontal cook picker, station mode = NextUpHero + "Coming up"
// queue, kitchen mode = the step ladder, and a collapsible Done.
//
// Same ordering as the desktop RunSheet: every row is re-timed against its
// STEP (withLadderTimes) and the kitchen ladder is runSheetGroups — late to
// start, then the four steps. There is no Time / Priority toggle any more; the
// hero is simply the first row of that order for the picked cook. The prototype's
// horizontal-scrolling in-progress rail is gone: an item being worked on stays
// in the queue as a WorkingRowMobile.
// The prototype's recipe/log bottom-sheets are dropped — the fused PrepDrawer
// (onOpenRecipe) and PrepDoneSheet (onLog) are the real surfaces, opened via
// props. Flat Tailwind tokens replace the hex palette; mono via `font-mono`.
import { useState, useMemo, useEffect, useRef } from 'react'
import { ChefHat, ChevronDown, RotateCcw } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from './assignee'
import { RunRowMobile } from './RunRowMobile'
import { WorkingRowMobile } from './WorkingRowMobile'
import { NextUpHero } from './NextUpHero'
import { GroupHead } from './GroupHead'
import { NowLine } from './NowLine'
import { Segmented } from './atoms'
import { IcCheck } from '@/components/prep/icons'
import { fmtClock, fmtMins, fmtQty } from '@/lib/prep-runsheet'
import { planDayContext, withLadderTimes, runSheetGroups, ladderOrder, PLAN_URG_META } from '@/lib/prep-plan'
import { serviceStatus, formatServiceStatus, type RcService } from '@/lib/service-hours'

type Mode = 'station' | 'kitchen'

// Right gutter every mobile row container reserves, so Remove can hang OUTSIDE
// the card instead of pressing against the 44px Start button. Narrower than the
// desktop gutter — a phone has no width to spare — and applied to Working On and
// Done too so every card ends at the same x.
const MOBILE_GUTTER = 'pr-[22px]'

// PARTIAL is a reachable resolved state (mirrors RunSheet's isDone) — do NOT
// treat it as todo.
const isDone = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
const isDoing = (i: PrepItemRich) => i.todayLog?.status === 'IN_PROGRESS'
const isTodo = (i: PrepItemRich) => !isDone(i) && !isDoing(i)

// Empty state for My-station mode. Module scope (not inline) so it doesn't
// remount on every render — see CLAUDE.md's client-component note.
function StationClear() {
  return (
    <div className="text-center px-5 py-10 text-ink-3">
      <div className="w-[42px] h-[42px] rounded-full bg-bg-2 grid place-items-center mx-auto mb-2.5">
        <ChefHat size={20} className="text-ink-4" />
      </div>
      <div className="text-[13.5px] font-semibold text-ink-2">Station queue clear</div>
      <div className="text-[12px] mt-[3px]">Everything is started or done. Check the Kitchen tab to help out.</div>
    </div>
  )
}

export function RunSheetMobile({
  items: rawItems,
  cooks,
  services,
  leadMinutes,
  nowMin,
  nowMs,
  onStart,
  onReopen,
  onLog,
  onStop,
  onClaim,
  onOpenRecipe,
  onRemove,
}: {
  items: PrepItemRich[]
  cooks: Cook[]
  /** The active RC's ACTIVE services (empty ⇒ on-demand) — same prop shape the
   *  desktop RunSheet takes, so both frames render one answer. */
  services: RcService[]
  leadMinutes: number | null
  nowMin: number
  nowMs: number
  onStart: (item: PrepItemRich) => void
  onReopen: (item: PrepItemRich) => void
  onLog: (item: PrepItemRich) => void
  onStop: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
  onOpenRecipe: (item: PrepItemRich) => void
  /** LEAD+ only — omitted for cooks, which is what hides the row's × button. */
  onRemove?: (item: PrepItemRich) => void
}) {
  const [mode, setMode] = useState<Mode>('station')
  const [cook, setCook] = useState<string | null>(cooks[0]?.id ?? null)
  const [showDone, setShowDone] = useState(false)
  // A mode the cook picked by hand is never overridden by the fallback below.
  const modeTouched = useRef(false)
  const pickMode = (m: Mode) => { modeTouched.current = true; setMode(m) }

  const ctx = useMemo(() => planDayContext(services, nowMin), [services, nowMin])
  const items = useMemo(() => withLadderTimes(rawItems, ctx), [rawItems, ctx])

  // `cooks` can arrive after mount (async fetch) — same null-guard the desktop
  // RunSheet uses so My-station isn't stuck with cook === null forever.
  useEffect(() => {
    if (cook == null && cooks.length > 0) setCook(cooks[0].id)
  }, [cooks, cook])

  const member = cook ? cooks.find(c => c.id === cook) ?? null : null
  // Assigned to the cook, or unassigned on the cook's home station. The station
  // match needs a REAL station on both sides: a cook with no home station used
  // to "match" every item with no station (null === null), so My station opened
  // to the one unstationed item on the list for every cook.
  const isMine = (i: PrepItemRich) =>
    i.assignedCook?.id === cook || (!i.assignedCook && !!member?.homeStation && i.station === member.homeStation)

  const todoAll = useMemo(() => items.filter(isTodo).sort(ladderOrder), [items])
  const doingAll = useMemo(() => items.filter(isDoing), [items])
  const done = useMemo(() => items.filter(isDone), [items])

  const myTodo = useMemo(() => todoAll.filter(isMine), [todoAll, cook, member])
  const doing = mode === 'station' ? doingAll.filter(isMine) : doingAll
  const hero = myTodo[0]
  const queue = myTodo.slice(1)

  // My station is empty for a cook with no home station and nothing assigned
  // (the live roster: 23 cooks, none homed, 0 assignments — every cook opened
  // the app to one unstationed item). Fall back to Kitchen until the cook
  // picks a mode themselves.
  useEffect(() => {
    if (modeTouched.current || cooks.length === 0) return
    if (!member?.homeStation && myTodo.length === 0 && todoAll.length > 0) setMode('kitchen')
  }, [cooks.length, member, myTodo.length, todoAll.length])

  // Kitchen-mode badge = late-to-start count across the whole brigade.
  // Same test as the ladder's "Late to start" section (see RunSheet.lateN).
  const lateN = useMemo(
    () => todoAll.filter(i => i.startByMinutes != null && i.startByMinutes < nowMin).length,
    [todoAll, nowMin],
  )

  // The service caption on the NOW line. Same derivation as the desktop RunSheet's
  // status band and /prep's page header: `serviceStatus` over the RC's CONFIGURED
  // services, not over whatever items happen to be on the board. The casing is CSS
  // (`uppercase` on the container), so the shared string needs no transform.
  const svcCaption = useMemo(() => {
    const status = serviceStatus(services, nowMin, leadMinutes)
    switch (status.kind) {
      case 'upcoming':
      case 'underway': {
        const f = formatServiceStatus(status)
        return f ? (f.trail ? `${f.lead} · ${f.trail}` : f.lead) : null
      }
      case 'closed':
        return null
      case 'none':
        return null
      default: {
        const _never: never = status
        return _never
      }
    }
  }, [services, nowMin, leadMinutes])

  const handsOn = (list: PrepItemRich[]) => fmtMins(list.reduce((a, i) => a + (i.activeMinutes ?? 0), 0))

  // Claim toggle — assign to the viewing cook, or unassign if already theirs
  // (mirrors the prototype's `claimTap`).
  const claimTap = (item: PrepItemRich) => onClaim(item, item.assignedCook?.id === cook ? null : cook)

  const rows = (list: PrepItemRich[], kitchen: boolean) => (
    <div className={`flex flex-col gap-[7px] ${MOBILE_GUTTER}`}>
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
          onRemove={onRemove}
        />
      ))}
    </div>
  )

  // kitchen mode: the step ladder across the whole brigade — late to start,
  // NOW line, then the four steps captioned with their deadline for the day.
  const renderKitchen = () => {
    const groups = runSheetGroups(todoAll, ctx, nowMin)
    const lateG = groups.find(g => g.late)
    const stepG = groups.filter(g => !g.late)
    return (
      <>
        {lateG && (
          <>
            <GroupHead dot="bg-red" title={lateG.label} count={lateG.rows.length} />
            {rows(lateG.rows, true)}
          </>
        )}
        <div className="my-3.5"><NowLine nowMin={nowMin} /></div>
        {stepG.map(g => (
          <div key={g.key}>
            <GroupHead dot={PLAN_URG_META[g.urg!].dotClass} title={g.label} count={g.rows.length} sub={g.sub} />
            {rows(g.rows, true)}
          </div>
        ))}
        {!todoAll.length && (
          <div className="font-mono text-[11px] text-ink-4 text-center py-9">
            LIST CLEAR — EVERYTHING STARTED OR DONE
          </div>
        )}
      </>
    )
  }

  return (
    <div className="tracking-[-0.005em]">
      {/* The mobile page header already owns the "Prep List" title + date, so the run
          sheet drops its duplicate title and keeps only its unique live timing line. */}
      <div className="font-mono text-[10px] font-medium tracking-[0.06em] uppercase text-ink-3 pt-0.5 pb-2.5">
        NOW {fmtClock(nowMin)}
        {svcCaption ? ` · ${svcCaption}` : ''}
      </div>

      <Segmented<Mode>
        value={mode}
        onPick={pickMode}
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

      {/* Working On — full-width rows, above every ladder group. */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="tap done to log yield" />
          <div className={`flex flex-col gap-2 ${MOBILE_GUTTER}`}>
            {doing.map(i => (
              <WorkingRowMobile
                key={i.id}
                item={i}
                nowMs={nowMs}
                onClaim={claimTap}
                onLog={onLog}
                onStop={onStop}
                onOpenRecipe={onOpenRecipe}
              />
            ))}
          </div>
        </>
      )}

      {mode === 'station' ? (
        <>
          {hero ? (
            <NextUpHero item={hero} nowMin={nowMin} onStart={onStart} onOpenRecipe={onOpenRecipe} />
          ) : (
            <StationClear />
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
            <div className={`flex flex-col gap-1.5 mt-[7px] ${MOBILE_GUTTER}`}>
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
                    <span className="flex-1 min-w-0 text-[13px] font-medium text-ink-3 line-through break-words">
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
