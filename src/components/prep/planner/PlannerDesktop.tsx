'use client'
// Smart Prep v2 — desktop split-view planner (design planner.jsx PPPlanner).
// ONE dial per item: the urgency step carries the deadline and the stock
// meaning. Suggestions on the left, the chef's prep list on the right with a
// station-load strip and schedule slots; nothing reaches a cook until posted.
import { useMemo, useState } from 'react'
import { Zap, Undo2, Lock, Package, Check, Plus } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { RcService } from '@/lib/service-hours'
import {
  effectiveUrgency, planDayContext, planGroups, batchYield,
  draftListOrder as draftOrd,
} from '@/lib/prep-plan'
import {
  crewSchedule, crewCapacity, wontFitText, cookGroups, planChanges, filterCounts, type PrepFilter,
} from '@/lib/prep-smart'
import { resetTargets, emptyListIds } from '@/lib/prep-bulk'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { GroupHead } from './atoms'
import { PrepListPane, FilterChips, ViewSwitch, type PrepView } from './PrepListPane'
import { CrewBar } from './CrewBar'
import { GoStrip } from './GoStrip'
import { DraftRow } from './DraftRow'
import { PostDialog, type PostDue } from './PostDialog'

export interface PlannerHandlers {
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
  onQty: (item: PrepItemRich, qty: number) => void
  onNote: (item: PrepItemRich, note: string) => void
  onAssign: (item: PrepItemRich, cookId: string | null) => void
  onAssignStation: (station: string, cookId: string) => void
  onPriorityChange: (id: string, step: string) => void
  onReorder: (orders: Array<{ prepItemId: string; listOrder: number }>) => void
  onResetQuantities: () => void
  onAddAllToMake: () => void
  onEmptyList: () => void
  /** Save a corrected par on the linked recipe; resolves true when saved. */
  onFixPar: (item: PrepItemRich, parLevel: number) => Promise<boolean>
  /** Who's on today — the full new crew list. */
  onCrewChange: (cookIds: string[]) => void
  onPost: (dues: PostDue[]) => void
  onRecall: () => void
}

/** Smart Prep state the page owns: today's crew, the one to-make count, and
 *  whether this person may fix a par (lead and above). */
export interface SmartState {
  crewIds: string[]
  toMake: number
  canFixPar: boolean
}

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

/** Per-item batch display mode: chef's toggle wins, else batches by default
 *  whenever the linked recipe gives a usable base yield. */
export function isBatchMode(item: PrepItemRich, toggles: Map<string, boolean>): boolean {
  const t = toggles.get(item.id)
  if (t !== undefined) return t
  return batchYield(item) != null
}

export function PlannerDesktop({
  items, allItems, hidden, stations, cooks, services, nowMin, nowMs, canPlan, post,
  search, onSearch, handlers, smart,
}: {
  items: PrepItemRich[]              // filtered (search/category) — shapes the LEFT pane
  allItems: PrepItemRich[]           // unfiltered — the draft pane must not hide rows on search
  hidden: PrepItemRich[]             // switched off the prep list — the collapsed group under the suggestions
  stations: string[]
  cooks: Cook[]
  services: RcService[]
  nowMin: number
  /** epoch now — lets the schedule slot a job in flight from its next hands-on time */
  nowMs?: number
  canPlan: boolean
  post: PrepPostInfo | null
  search: string
  onSearch: (v: string) => void
  handlers: PlannerHandlers
  smart: SmartState
}) {
  const locked = !canPlan
  // The prep list opens on the whole list by category — the view cooks use most.
  const [view, setView] = useState<PrepView>('CATEGORY')
  const [filter, setFilter] = useState<PrepFilter>('ALL')
  const [groupBy, setGroupBy] = useState<'urgency' | 'cook'>('urgency')
  const [dlg, setDlg] = useState(false)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [batchToggles, setBatchToggles] = useState<Map<string, boolean>>(new Map())
  const onToggleBatch = (item: PrepItemRich, next: boolean) =>
    setBatchToggles(prev => new Map(prev).set(item.id, next))

  const ctx = useMemo(() => planDayContext(services, nowMin, nowMs), [services, nowMin, nowMs])
  const onList = useMemo(() => allItems.filter(i => i.isOnList), [allItems])
  // Jobs already cooking ride the On the go strip — never a draft row.
  const cooking = useMemo(() => onList.filter(i => i.pipeline), [onList])
  const draft = useMemo(() => onList.filter(i => !i.pipeline), [onList])
  const crewSize = smart.crewIds.length
  const sched = useMemo(() => crewSchedule(onList, crewSize, ctx, nowMin, draftOrd), [onList, crewSize, ctx, nowMin])
  const capacity = useMemo(() => crewCapacity(onList, crewSize, ctx), [onList, crewSize, ctx])
  const wontOf = (t: PrepItemRich) => { const sl = sched.get(t.id); return sl && !sl.fits ? wontFitText(sl, crewSize, fmtClock) : null }
  const changes = useMemo(() => planChanges(allItems), [allItems])
  const changeCount = changes.added.length + changes.removed.length
  const resets = useMemo(() => resetTargets(allItems, ctx, nowMin).length, [allItems, ctx, nowMin])
  const counts = useMemo(() => filterCounts(items, ctx, nowMin), [items, ctx, nowMin])
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const openCount = draft.filter(t => !t.todayLog?.assignedTo).length
  const clean = post != null && !post.dirty

  const flagWarn = (k: string) => { setWarn(k); setTimeout(() => setWarn(null), 1800) }
  const byId = (id: string) => allItems.find(x => x.id === id)
  const onDragOverRow = (t: PrepItemRich) => (e: React.DragEvent) => {
    if (!drag) return
    const src = byId(drag)
    if (src && effectiveUrgency(src) === effectiveUrgency(t)) { e.preventDefault(); setOver(t.id) }
  }
  const onDropRow = (t: PrepItemRich, groupKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!drag || drag === t.id) { setOver(null); return }
    const src = byId(drag)
    if (!src) return
    if (effectiveUrgency(src) !== effectiveUrgency(t)) { flagWarn(groupKey); setOver(null); return }
    const bucket = draft
      .filter(x => effectiveUrgency(x) === effectiveUrgency(src))
      .sort((a, b) => draftOrd(a) - draftOrd(b))
      .map(x => x.id)
    const from = bucket.indexOf(drag), to = bucket.indexOf(t.id)
    if (from < 0 || to < 0) return
    bucket.splice(to, 0, bucket.splice(from, 1)[0])
    handlers.onReorder(bucket.map((id, i) => ({ prepItemId: id, listOrder: i })))
    setOver(null); setDrag(null)
  }

  const paneCls = 'bg-paper border border-line rounded-[14px] flex flex-col min-h-0 overflow-hidden'
  const btnCls = (disabled: boolean) =>
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 min-h-[34px] text-[12.5px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-3 border-line cursor-not-allowed' : 'bg-paper text-ink-2 border-line-2 hover:border-ink-3'}`
  const groups = groupBy === 'cook'
    ? cookGroups(draft, cooks, smart.crewIds).map(g => ({ ...g, sub: undefined, urg: undefined }))
    : planGroups(draft, 'urgency', { ord: draftOrd })
  const changeNames = [
    ...changes.added.map(t => `+ ${t.name}`),
    ...changes.removed.map(t => `− ${t.name}`),
  ]

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] text-ink-3 m-0">
        <b className="font-semibold text-ink">{smart.toMake} more to make.</b>{' '}
        Your list: {draft.length} to start, {cooking.length} on the go
        {!clean && changeCount > 0 && <> — <b className="font-semibold text-gold-2">{changeCount} {changeCount === 1 ? 'change' : 'changes'} not posted yet.</b></>}
      </p>

      <CrewBar cooks={cooks} crewIds={smart.crewIds} onCrewChange={handlers.onCrewChange} capacity={capacity} ctx={ctx} locked={locked} />

      {/* 440px prep-list column only when there's desktop room — on iPad
          (md..xl) it would starve Your list, whose header controls get clipped
          by the pane's overflow-hidden. */}
      <div className="grid grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-3.5 items-stretch" style={{ height: 'calc(100vh - 290px)', minHeight: 560 }}>
        {/* ── the prep list ── */}
        <div className={paneCls}>
          <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 pt-3 pb-2.5 border-b border-line">
            <span className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Prep list</span>
            <ViewSwitch view={view} onView={setView} />
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search items"
              aria-label="Search items"
              className="ml-auto w-36 min-h-[34px] text-[13px] text-ink bg-bg border border-line rounded-[9px] px-3 outline-none placeholder:text-ink-3"
            />
          </div>
          <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-3 py-2 bg-bg border-b border-line">
            <FilterChips filter={filter} onFilter={setFilter} counts={counts} />
          </div>
          {smart.toMake > 0 && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line">
              <button type="button" onClick={handlers.onAddAllToMake} disabled={locked} className={btnCls(locked)}>
                <Plus size={14} className={locked ? 'text-ink-3' : 'text-gold-2'} /> Add all {smart.toMake} to make
              </button>
              <span className="text-[12px] text-ink-3">never adds a flagged par</span>
            </div>
          )}
          <div className="flex-1 overflow-y-auto min-h-0">
            <PrepListPane items={items} hidden={hidden} view={view} filter={filter} onFilter={setFilter}
              ctx={ctx} nowMin={nowMin} ord={draftOrd} locked={locked} canFixPar={smart.canFixPar}
              showJump idPrefix="d-" handlers={handlers} />
          </div>
        </div>

        {/* ── your list ── */}
        <div className={`${paneCls} ${clean ? '' : '!border-ink'}`}>
          <div className={`shrink-0 flex flex-wrap items-center gap-2 px-4 pt-3 pb-2.5 border-b border-line ${clean ? 'bg-paper' : 'bg-bg'}`}>
            <div className="flex-1 min-w-[180px]">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold tracking-[-0.015em] text-ink">Your list</span>
                <span className={`text-[11.5px] font-semibold px-2 py-0.5 rounded-full ${clean ? 'bg-green-soft text-green-text' : post ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-2'}`}>
                  {post ? (post.dirty ? 'Not posted' : 'Posted') : 'Draft'}
                </span>
              </div>
              <div className="text-[12px] text-ink-3 mt-0.5">
                {draft.length} to start · {fmtMins(mins)} hands-on · {openCount ? `${openCount} open` : 'all assigned'}
              </div>
            </div>
            <span className="inline-flex shrink-0 border border-line rounded-full bg-paper p-[2px]">
              {([['urgency', 'By step'], ['cook', 'By cook']] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setGroupBy(k)} aria-pressed={groupBy === k}
                  className={`min-h-[30px] px-3 rounded-full text-[12.5px] font-semibold ${groupBy === k ? 'bg-ink text-paper' : 'text-ink-3'}`}>{l}</button>
              ))}
            </span>
            {resets > 0 && (
              <button type="button" onClick={handlers.onResetQuantities} disabled={locked} className={btnCls(locked)}>
                Reset {resets} {resets === 1 ? 'quantity' : 'quantities'} to suggested
              </button>
            )}
            <button type="button" onClick={() => setConfirmEmpty(true)} disabled={locked || !draft.length} className={btnCls(locked || !draft.length)}>
              Empty the list…
            </button>
          </div>

          <GoStrip items={cooking} nowMs={nowMs ?? Date.now()} onOpen={handlers.onOpen} />

          <div className="flex-1 overflow-y-auto px-3.5 pb-3.5 pt-0.5 min-h-0">
            {!draft.length && (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-3">
                <Package size={26} className="text-line-2" />
                <span className="text-[13.5px] text-ink-2">Nothing to start on your list yet</span>
                <span className="text-[12.5px]">Add from the prep list on the left</span>
              </div>
            )}
            {groups.map(g => (
              <div key={g.key}>
                <GroupHead g={g} count={g.rows.length} mins={g.rows.reduce((a, t) => a + activeOf(t), 0)} warn={warn === g.key} />
                <div className="flex flex-col gap-1.5">
                  {g.rows.map(t => (
                    <DraftRow key={t.id} item={t} cooks={cooks} crewIds={smart.crewIds} locked={locked}
                      ctx={ctx} wont={wontOf(t)} batchMode={isBatchMode(t, batchToggles)}
                      dragging={drag === t.id} over={over === t.id}
                      onQty={handlers.onQty} onToggleBatch={onToggleBatch} onNote={handlers.onNote} onAssign={handlers.onAssign}
                      onUrgChange={handlers.onPriorityChange} onRemove={handlers.onRemove} onOpen={handlers.onOpen}
                      onDragStart={() => setDrag(t.id)} onDragOver={onDragOverRow(t)} onDrop={onDropRow(t, g.key)}
                      onDragEnd={() => { setDrag(null); setOver(null) }} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* footer / sign-off */}
          <div className="shrink-0 border-t border-line px-4 py-3 bg-paper">
            {locked ? (
              <div className="flex items-center gap-2 bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <Lock size={14} className="text-ink-3" />
                <span className="text-[12.5px] text-ink-2">Pick a kitchen you can edit to plan and post the list.</span>
              </div>
            ) : clean ? (
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 bg-green-soft text-green-text rounded-[10px] px-3 py-2.5 text-[13px] font-semibold">
                  <Check size={14} className="text-green" /> Live on To Do
                </span>
                <span className="text-[12px] text-ink-3">
                  Posted {fmtClock(new Date(post!.postedAt).getHours() * 60 + new Date(post!.postedAt).getMinutes())} by {post!.postedByName} · {post!.itemCount} items
                </span>
                <span className="flex-1" />
                <button type="button" onClick={handlers.onRecall} className={btnCls(false)}>
                  <Undo2 size={13} className="text-ink-3" /> Recall to draft
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-ink">
                    {changeCount > 0 ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'} not posted` : post ? 'Changes not posted' : 'Cooks see nothing until you post'}
                  </div>
                  <div className="text-[12.5px] text-ink-3 mt-0.5 truncate">
                    {changeNames.length ? changeNames.join(' · ') : `${draft.length} items · ${fmtMins(mins)} hands-on`}
                    {post ? ' — cooks still see the last posted list' : ''}
                  </div>
                </div>
                <span className="flex-1" />
                <button type="button" onClick={() => setDlg(true)} disabled={!onList.length}
                  className={`inline-flex items-center gap-2 rounded-[11px] px-[18px] min-h-[44px] text-[14px] font-semibold shrink-0 ${onList.length ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-3 cursor-not-allowed'}`}>
                  <Zap size={15} className={onList.length ? 'text-gold' : 'text-ink-3'} /> Review &amp; post
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmEmpty && (
        <ConfirmEmpty count={emptyListIds(onList).length} onCancel={() => setConfirmEmpty(false)}
          onConfirm={() => { handlers.onEmptyList(); setConfirmEmpty(false) }} />
      )}
      {dlg && (
        <PostDialog draft={draft} cooks={cooks} ctx={ctx} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={dues => { handlers.onPost(dues); setDlg(false) }} />
      )}
    </div>
  )
}

/** Asks once before emptying the list; jobs already cooking stay. Undo follows. */
export function ConfirmEmpty({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <span className="absolute inset-0 bg-[rgba(9,9,11,0.45)]" onClick={onCancel} />
      <div role="dialog" aria-label="Empty the list" className="relative w-full max-w-[360px] bg-paper rounded-2xl p-5 flex flex-col gap-3">
        <div className="text-[17px] font-semibold text-ink">Take {count} off the list?</div>
        <div className="text-[13.5px] text-ink-2 leading-snug">Jobs on the go stay. You can undo this for 10 seconds.</div>
        <div className="flex gap-2 mt-1">
          <button type="button" onClick={onConfirm} className="flex-1 min-h-[44px] rounded-[11px] bg-ink text-paper text-[14px] font-semibold">Take them off</button>
          <button type="button" onClick={onCancel} className="flex-1 min-h-[44px] rounded-[11px] border border-line text-ink-2 text-[14px] font-semibold">Keep</button>
        </div>
      </div>
    </div>
  )
}
