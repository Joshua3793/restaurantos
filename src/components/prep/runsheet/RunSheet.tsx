'use client'
// Prep run-sheet — desktop frame.
// Originally ported from the prototype's PTDesktop (scratchpad/prototype-ref/desktop.jsx).
// The header has since been compacted to a progress hairline + one control row
// (see docs/superpowers/specs/2026-09-14-todo-header-compact-design.md) — the
// prototype's status band and per-cook crew strip are gone. What remains:
// Kitchen/My-station segmented, station filter, the ladder (renderLadder: steps
// / station), the NOW divider, and the collapsible Done section.
//
// The ladder is ONE ordering, derived from the step the chef dialled in Smart
// Prep: every posted row gets its step deadline for the day and a start-by
// counted back from THAT (withLadderTimes), sections are "Late to start" plus
// the four steps (runSheetGroups), and rows inside a section follow deadline →
// start-by → the chef's listOrder. The old Time / Priority toggle ordered by
// `service − times` and by the 3-level priority — two numbers the planner never
// used, which is why the To Do could not show the plan that was posted. The prototype's DSidebar (the app
// has its own nav), tweaks slider, and clock slider are dropped — real props
// drive everything instead. The prototype's horizontal-scrolling in-progress
// rail is gone too: an item being worked on stays in the ladder as a WorkingRow. Flat Tailwind tokens replace
// the hex palette; mono via `font-mono`; Lucide icons.
import { useState, useMemo, useEffect } from 'react'
import { RotateCcw, Check } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from './assignee'
import { RunRow } from './RunRow'
import { RestRow } from './RestRow'
import { WorkingRow } from './WorkingRow'
import { GroupHead } from './GroupHead'
import { NowLine } from './NowLine'
import { Segmented } from './atoms'
import { fmtClock, fmtMins, fmtQty, postedWhenLabel } from '@/lib/prep-runsheet'
import { planDayContext, withLadderTimes, runSheetGroups, ladderOrder, lateToStart, PLAN_URG_META, onStation } from '@/lib/prep-plan'
import { serviceStatus, formatServiceStatus, type RcService } from '@/lib/service-hours'

type Mode = 'kitchen' | 'station'
type Group = 'ladder' | 'station'

// Minutes-since-midnight for a done item's completion timestamp — the Done
// section shows a wall-clock stamp for when each row finished.
function minuteOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

// PARTIAL is a reachable resolved state (the Log yield sheet records it when the logged
// qty falls short of the plan) — treat DONE/PARTIAL as done-equivalent everywhere.
// Right gutter every row container reserves, so the ladder's Remove button can
// hang OUTSIDE the card without overflowing the sheet. Applied to Working On and
// Done too — only todo rows paint a button in it, but every card has to end at
// the same x or the sections look ragged.
const RUN_GUTTER = 'pr-[30px]'

const isDone = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
// Working On holds HANDS-ON jobs only. A staged job resting in an unattended
// stage (`rest`, attached by withLadderTimes) is in flight but not "doing" —
// it sits in the WAITING section above Working On, blue, ordered by the time
// its next hands-on step is due. The ladder holds only what has not started.
const isDoing = (i: PrepItemRich) => i.todayLog?.status === 'IN_PROGRESS' && !i.rest
const isWaiting = (i: PrepItemRich) => i.todayLog?.status === 'IN_PROGRESS' && !!i.rest
const isTodo = (i: PrepItemRich) => !isDone(i) && !isDoing(i) && !isWaiting(i)

// The one-line caption on the left of the control row: done count, the posted
// provenance (time, poster, item count) when there is a live post, the clock,
// and the service caption. Truncates rather than wrapping — the controls on the
// right take the second line on iPad, the caption never does.
function HeaderCaption({
  doneN,
  totalN,
  post,
  clock,
  svcCaption,
}: {
  doneN: number
  totalN: number
  post: PrepPostInfo | null
  clock: string
  svcCaption: string | null
}) {
  return (
    <div className="flex items-center gap-2 min-w-0 font-mono text-[10.5px] text-ink-3">
      <span className="min-w-0 truncate">
        <b className="text-ink font-semibold">{doneN}</b>
        <span className="text-ink-4">/{totalN}</span> done
        {post && (
          <>
            {' · '}
            <Check size={10} className="inline-block align-[-1px] text-green" />
            {' '}Posted {postedWhenLabel(post.postedAt, post.listDate)} · {post.postedByName} · {post.itemCount} item{post.itemCount !== 1 ? 's' : ''}
          </>
        )}
        {' · '}
        <b className="text-ink font-semibold">{clock}</b>
        {svcCaption && <> · {svcCaption}</>}
      </span>
      {post?.dirty && (
        <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] bg-gold-soft text-gold-2 px-2 py-0.5 rounded-full whitespace-nowrap shrink-0">
          Chef has unposted changes
        </span>
      )}
    </div>
  )
}

export function RunSheet({
  items: rawItems,
  cooks,
  services,
  post,
  leadMinutes,
  nowMin,
  nowMs,
  onStart,
  onReopen,
  onLog,
  onStop,
  onClaim,
  onOpenRecipe,
  onStage,
  onRemove,
}: {
  items: PrepItemRich[]
  cooks: Cook[]
  /** The active RC's ACTIVE services (empty ⇒ on-demand). The run sheet's service
   *  caption derives from the RC's configuration, never from what happens to be on
   *  the board — see `svcCaption`. */
  services: RcService[]
  /** The live post for this RC's list (null when nothing is posted). The sheet
   *  paints the "Posted 8:17 PM · Joshua · 14 items" caption itself now that
   *  the black PostedBand above it is gone. */
  post: PrepPostInfo | null
  leadMinutes: number | null
  nowMin: number
  nowMs: number
  onStart: (item: PrepItemRich) => void
  onReopen: (item: PrepItemRich) => void
  onLog: (item: PrepItemRich) => void
  onStop: (item: PrepItemRich) => void
  onClaim: (item: PrepItemRich, cookId: string | null) => void
  onOpenRecipe: (item: PrepItemRich) => void
  /** Staged prep — move an item's live log to a stage (Next on a working / rest row). */
  onStage: (item: PrepItemRich, stageIndex: number) => void
  /** LEAD+ only — omitted for cooks, which is what hides the row's × button. */
  onRemove?: (item: PrepItemRich) => void
}) {
  const [mode, setMode] = useState<Mode>('kitchen')
  const [cook, setCook] = useState<string | null>(cooks[0]?.id ?? null)
  const [group, setGroup] = useState<Group>('ladder')
  const [stFilter, setStFilter] = useState<string>('all')
  const [showDone, setShowDone] = useState(false)

  // `cooks` can arrive after mount (async fetch) — the initial useState only ran
  // once with an empty roster. Without this, My-station mode is stuck with cook
  // === null forever, showing an empty ladder.
  useEffect(() => {
    if (cook == null && cooks.length > 0) setCook(cooks[0].id)
  }, [cooks, cook])

  // The day's anchors from the RC's services, and every row re-timed against
  // its STEP. From here on `items` carries the step-aware start-by + deadline,
  // so the counts, the section headers and the rows all read the same number.
  const ctx = useMemo(() => planDayContext(services, nowMin), [services, nowMin])
  const items = useMemo(() => withLadderTimes(rawItems, ctx, { nowMs, nowMin }), [rawItems, ctx, nowMs, nowMin])

  // Every station named on the list (an item may name several).
  const stations = useMemo(
    () => [...new Set(items.flatMap(i => i.stations))].sort(),
    [items],
  )

  const member = cook ? cooks.find(c => c.id === cook) ?? null : null
  // Assigned to the cook, or unassigned and makeable on the cook's home station.
  // The cook needs a REAL home station: without one nothing station-matches, so
  // a cook with no station never sees the whole any-station list as "mine".
  const isMine = (i: PrepItemRich) =>
    i.assignedCook?.id === cook || (!i.assignedCook && !!member?.homeStation && onStation(i, member.homeStation))
  const inScope = (i: PrepItemRich) =>
    mode === 'station' ? isMine(i) : stFilter === 'all' || onStation(i, stFilter)

  const doing = useMemo(() => items.filter(i => isDoing(i) && inScope(i)), [items, mode, cook, stFilter, member])
  // Hairline = the whole list, never the station filter — same basis as the mobile sheet.
  const doingAll = useMemo(() => items.filter(isDoing), [items])
  // Waiting — jobs resting in an unattended stage, soonest ready first.
  const waiting = useMemo(
    () => items.filter(i => isWaiting(i) && inScope(i)).sort((a, b) => a.rest!.readyAtMin - b.rest!.readyAtMin),
    [items, mode, cook, stFilter, member],
  )
  const done = useMemo(() => items.filter(isDone), [items])
  const todo = useMemo(
    () => items.filter(i => isTodo(i) && inScope(i)).sort(ladderOrder),
    [items, mode, cook, stFilter, member],
  )

  // Kitchen-mode badge = everything not yet done.
  const notDone = useMemo(() => items.filter(i => !isDone(i)), [items])
  // Rest rows whose timer has run out — the cook can move them on.
  const readyN = useMemo(() => items.filter(i => i.rest && i.rest.state !== 'resting').length, [items])

  // The service caption in the header. Source of truth is the RC's configured
  // services via `serviceStatus` — the SAME answer /prep's page header, /pass and
  // /preshift render, so the band can no longer disagree with the header above it.
  //
  // This used to derive services from the prep items themselves and filter
  // `timeMinutes > nowMin` (upcoming-only), which meant it had no concept of a
  // service being underway, and its answer changed as items came on/off the board.
  const svcCaption = useMemo(() => {
    const status = serviceStatus(services, nowMin, leadMinutes)
    switch (status.kind) {
      case 'upcoming':
      case 'underway': {
        const f = formatServiceStatus(status)
        return f ? (f.trail ? `${f.lead} · ${f.trail}` : f.lead) : null
      }
      // Configured services, none left today → render nothing (retires the old
      // 'ALL SERVICES STARTED', vocabulary that existed nowhere else in the app).
      case 'closed':
        return null
      // On-demand. The page header already says so; don't say it twice.
      case 'none':
        return null
      default: {
        const _never: never = status
        return _never
      }
    }
  }, [services, nowMin, leadMinutes])

  const handsOn = (list: PrepItemRich[]) => fmtMins(list.reduce((a, i) => a + (i.activeMinutes ?? 0), 0))

  // "N low on stock" for a group's caption — same test the old status card used
  // for its kitchen-wide count; now per section so a blocked job is counted where it sits.
  const lowStock = (list: PrepItemRich[]) => {
    const n = list.filter(i => i.isBlocked || !!i.blockedReason).length
    return n ? `${n} low on stock` : null
  }

  const rowProps = { nowMin, cooks, onStart, onOpenRecipe, onClaim, onRemove }
  const rows = (list: PrepItemRich[]) => (
    <div className={`flex flex-col gap-2 ${RUN_GUTTER}`}>
      {list.map(i => <RunRow key={i.id} item={i} {...rowProps} />)}
    </div>
  )

  const renderLadder = () => {
    if (group === 'station') {
      return stations.map(s => {
        const grp = todo.filter(i => onStation(i, s))
        if (!grp.length) return null
        const late = grp.filter(i => lateToStart(i, nowMin)).length
        return (
          <div key={s}>
            <GroupHead dot="bg-ink-3" title={s} count={grp.length} sub={[late ? `${late} late to start` : null, lowStock(grp)].filter(Boolean).join(' · ') || null} />
            {rows(grp)}
          </div>
        )
      })
    }
    // steps (default): late to start → NOW line → the four steps, each captioned
    // with its deadline for the day. Rows inside follow ladderOrder.
    const groups = runSheetGroups(todo, ctx, nowMin)
    const lateG = groups.find(g => g.late)
    const stepG = groups.filter(g => !g.late)
    return (
      <>
        {lateG && (
          <div>
            <GroupHead dot="bg-red" title={lateG.label} count={lateG.rows.length} sub={["won't make its step unless started now", lowStock(lateG.rows)].filter(Boolean).join(' · ')} />
            {rows(lateG.rows)}
          </div>
        )}
        <div className="my-[18px]"><NowLine nowMin={nowMin} /></div>
        {stepG.map(g => (
          <div key={g.key}>
            <GroupHead
              dot={PLAN_URG_META[g.urg!].dotClass}
              title={g.label}
              count={g.rows.length}
              sub={[g.sub, `${handsOn(g.rows)} hands-on`, lowStock(g.rows)].filter(Boolean).join(' · ')}
            />
            {rows(g.rows)}
          </div>
        ))}
        {!todo.length && (
          <div className="font-mono text-[11px] text-ink-4 text-center py-9">
            LIST CLEAR — EVERYTHING STARTED OR DONE
          </div>
        )}
      </>
    )
  }

  const donePct = items.length ? (done.length / items.length) * 100 : 0
  const doingPct = items.length ? (doingAll.length / items.length) * 100 : 0

  return (
    <div className="max-w-[1010px] mx-auto tracking-[-0.005em]">
      {/* The whole header is a 3px progress hairline and ONE control row. The
          black posted band, the ordering sentence, the status card and the
          per-cook crew cards used to stack here (~700px of chrome before the
          first job); every number they carried now lives in the section header
          that owns it — see docs/superpowers/specs/2026-09-14-todo-header-compact-design.md. */}
      <div className="flex h-[3px] rounded-full overflow-hidden bg-bg-2 gap-0.5 mb-3">
        {done.length > 0 && <div className="bg-green" style={{ width: `${donePct}%` }} />}
        {doingAll.length > 0 && <div className="bg-gold" style={{ width: `${doingPct}%` }} />}
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap mb-3.5">
        <HeaderCaption doneN={done.length} totalN={items.length} post={post} clock={fmtClock(nowMin)} svcCaption={svcCaption} />

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <Segmented<Mode>
            value={mode}
            onPick={setMode}
            options={[
              { id: 'kitchen', label: 'Kitchen', badge: notDone.length },
              { id: 'station', label: 'My station' },
            ]}
          />
          {mode === 'kitchen' ? (
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
          ) : (
            <div className="flex items-center gap-1.5 flex-wrap">
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
          <Segmented<Group>
            value={group}
            onPick={setGroup}
            options={[
              { id: 'ladder', label: 'Steps' },
              { id: 'station', label: 'Station' },
            ]}
          />
        </div>
      </div>

      {/* Waiting — jobs resting in an unattended stage (a cure, a proof, a smoke),
          above everything: they are in flight, they hold no cook, and the only
          thing to do is move them on when the timer is up. Blue is their colour. */}
      {waiting.length > 0 && (
        <>
          <GroupHead
            dot="bg-blue"
            title="Waiting"
            count={waiting.length}
            sub={readyN ? `${readyN} ready to move` : 'resting — nothing to do until the timer is up'}
          />
          <div className={`flex flex-col gap-2 ${RUN_GUTTER}`}>
            {waiting.map(i => (
              <RestRow key={i.id} item={i} nowMin={nowMin} nowMs={nowMs} cooks={cooks} onStage={onStage} onOpenRecipe={onOpenRecipe} onClaim={onClaim} />
            ))}
          </div>
        </>
      )}

      {/* Working On — full-width rows on the ladder's own grid, above every
          ladder group in all three groupings. */}
      {doing.length > 0 && (
        <>
          <GroupHead dot="bg-gold" title="Working On" count={doing.length} sub="parallel timers — mark done to log yield" />
          <div className={`flex flex-col gap-2 ${RUN_GUTTER}`}>
            {doing.map(i => (
              <WorkingRow
                key={i.id}
                item={i}
                nowMs={nowMs}
                cooks={cooks}
                onClaim={onClaim}
                onLog={onLog}
                onStop={onStop}
                onOpenRecipe={onOpenRecipe}
                onStage={onStage}
              />
            ))}
          </div>
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
            <div className={`flex flex-col gap-1.5 mt-2 ${RUN_GUTTER}`}>
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
