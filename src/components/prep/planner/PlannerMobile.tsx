'use client'
// Smart Prep — phone planner, ONE scroll: what's left to make, who's on today,
// your list (first rows, Open ▾ for all of it), then the whole prep list by
// category. 44 px targets; the post bar never covers the last card.
import { useMemo, useState } from 'react'
import { Zap, Undo2, Lock, Package, Check, ChevronDown, X, Plus } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { RcService } from '@/lib/service-hours'
import {
  PLAN_URG_META, effectiveUrgency, planDayContext, planGroups, urgencyDeadline, deadlineLabel,
  suggestedDraftQty, draftQty, batchYield, batchCount, draftListOrder as draftOrd,
  type PlanDayContext,
} from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { fmtAmount } from '@/lib/prep-amount'
import {
  crewSchedule, crewCapacity, wontFitText, planChanges, filterCounts, type PrepFilter,
} from '@/lib/prep-smart'
import { resetTargets, emptyListIds } from '@/lib/prep-bulk'
import { GroupHead, UrgPicker, AssignPill, QtyStepper, NoteField, Popover, popItemCls } from './atoms'
import { DraftReason, WontFit } from './DraftRow'
import { PostDialog } from './PostDialog'
import { PrepListPane, FilterChips, type PrepView } from './PrepListPane'
import { CrewBar } from './CrewBar'
import { GoStrip } from './GoStrip'
import { batchWords } from './PrepRow'
import { isBatchMode, ConfirmEmpty } from './PlannerDesktop'
import type { PlannerHandlers, SmartState } from './PlannerDesktop'

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

function MobileDraftCard({ item, cooks, crewIds, locked, ctx, wont, batchMode, first, last, onMove, onToggleBatch, handlers }: {
  item: PrepItemRich; cooks: Cook[]; crewIds: string[]; locked: boolean
  ctx: PlanDayContext | null; wont: string | null; batchMode: boolean
  first: boolean; last: boolean
  onMove: (dir: -1 | 1) => void
  onToggleBatch: (item: PrepItemRich, next: boolean) => void
  handlers: PlannerHandlers
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const arrow = (dir: -1 | 1, disabled: boolean) => (
    <button type="button" onClick={() => onMove(dir)} disabled={locked || disabled}
      aria-label={dir < 0 ? 'Move up' : 'Move down'}
      className={`w-11 h-11 rounded-[9px] bg-bg border border-line grid place-items-center ${disabled ? 'opacity-30' : ''}`}>
      <ChevronDown size={16} className="text-ink-2" style={{ transform: dir < 0 ? 'rotate(180deg)' : 'none' }} />
    </button>
  )
  return (
    <div className="bg-paper border border-line rounded-[11px] px-2.5 py-[9px] border-l-[3px]" style={{ borderLeftColor: m.hex }}>
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-1 shrink-0">{arrow(-1, first)}{arrow(1, last)}</div>
        {/* name (wraps, never truncates) and ONE plain reason line — the deadline
            lives on the step button, the schedule only speaks when it won't fit */}
        <button type="button" onClick={() => handlers.onOpen(item)} className="flex-1 min-w-0 text-left">
          <span className="flex text-[14.5px] font-semibold tracking-[-0.01em] text-ink break-words">{item.name}</span>
          <span className="flex flex-wrap gap-x-1 mt-0.5"><DraftReason item={item} /> <WontFit text={wont} /></span>
        </button>
        {/* assign rides the name row — the controls row below is full with the
            stepper and the step button on a 375px phone */}
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} crewIds={crewIds} locked={locked} onAssign={id => handlers.onAssign(item, id)} sm />
        <button type="button" disabled={locked} onClick={() => handlers.onRemove(item)}
          aria-label={`Take ${item.name} off the list`}
          className="w-11 h-11 -mr-1 -mt-1 rounded-[9px] grid place-items-center shrink-0">
          <X size={16} className={locked ? 'text-line-2' : 'text-ink-3'} />
        </button>
      </div>
      {/* flex-wrap stays as the fallback for very narrow screens */}
      <div className="flex flex-wrap items-center gap-x-[7px] gap-y-1.5 mt-2 pl-[52px]">
        <QtyStepper item={item} locked={locked} batchMode={batchMode} onQty={handlers.onQty} onToggleBatch={onToggleBatch} suggested={suggestedDraftQty(item)} sm />
        <UrgPicker item={item} locked={locked} ctx={ctx} onChange={step => handlers.onPriorityChange(item.id, step)} w="min-h-[44px]" />
      </div>
      <div className="pl-[52px]"><NoteField item={item} locked={locked} onNote={handlers.onNote} sm /></div>
    </div>
  )
}

const STEP_WORD = { PASS: 'Critical', MID: 'Mid-service', CLOSE: 'Before close', TMRW: 'Tomorrow' } as const

/** A collapsed Your-list line: name, amount · step · deadline, cook. */
function PreviewLine({ item, ctx, nowMin, cooks, isNew, onOpen }: {
  item: PrepItemRich; ctx: PlanDayContext | null; nowMin: number; cooks: Cook[]; isNew: boolean; onOpen: (item: PrepItemRich) => void
}) {
  const q = draftQty(item)
  const nb = batchYield(item) != null ? batchCount(item, q) : null
  const u = effectiveUrgency(item)
  const dl = ctx ? deadlineLabel(urgencyDeadline(u, ctx), nowMin, fmtClock) : null
  const cook = cooks.find(c => c.id === item.todayLog?.assignedTo)
  return (
    <button type="button" onClick={() => onOpen(item)}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 w-full text-left px-3.5 py-2.5 border-t border-line">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 text-[14px] font-semibold text-ink">
          {item.name}
          {isNew && <span className="text-[11.5px] font-semibold px-2 py-[1px] rounded-full bg-blue-soft text-blue-text">New</span>}
        </span>
        <span className="flex text-[12.5px] text-ink-2 mt-0.5">
          {nb != null && nb > 0 ? batchWords(nb) : fmtAmount(q, item.unit)} · {STEP_WORD[u]}{dl ? ` · ${dl}` : ''}
        </span>
      </span>
      <span className={`w-9 h-9 rounded-full grid place-items-center font-mono text-[11.5px] font-semibold ${cook ? 'bg-ink text-paper' : 'border border-dashed border-line-2 text-ink-3'}`}>
        {cook ? cook.initials : '+'}
      </span>
    </button>
  )
}

export function PlannerMobile({ items, allItems, hidden, cooks, stations, services, nowMin, nowMs, canPlan, post, handlers, smart }: {
  items: PrepItemRich[]
  allItems: PrepItemRich[]
  /** Items switched off the prep list — the collapsed group under the suggestions. */
  hidden: PrepItemRich[]
  cooks: Cook[]
  stations: string[]
  services: RcService[]
  nowMin: number
  nowMs?: number
  canPlan: boolean
  post: PrepPostInfo | null
  handlers: PlannerHandlers
  smart: SmartState
}) {
  const locked = !canPlan
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<PrepView>('CATEGORY')
  const [viewMenu, setViewMenu] = useState(false)
  const [filter, setFilter] = useState<PrepFilter>('ALL')
  const [dlg, setDlg] = useState(false)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [batchToggles, setBatchToggles] = useState<Map<string, boolean>>(new Map())
  const onToggleBatch = (item: PrepItemRich, next: boolean) =>
    setBatchToggles(prev => new Map(prev).set(item.id, next))

  const ctx = useMemo(() => planDayContext(services, nowMin, nowMs), [services, nowMin, nowMs])
  const onList = useMemo(() => allItems.filter(i => i.isOnList), [allItems])
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
  const clean = post != null && !post.dirty
  const sorted = useMemo(() => [...draft].sort((a, b) =>
    urgencyIndex(a) - urgencyIndex(b) || draftOrd(a) - draftOrd(b)), [draft])

  const nudge = (item: PrepItemRich, dir: -1 | 1) => {
    const bucket = draft
      .filter(x => effectiveUrgency(x) === effectiveUrgency(item))
      .sort((a, b) => draftOrd(a) - draftOrd(b))
      .map(x => x.id)
    const i = bucket.indexOf(item.id), j = i + dir
    if (i < 0 || j < 0 || j >= bucket.length) return
    ;[bucket[i], bucket[j]] = [bucket[j], bucket[i]]
    handlers.onReorder(bucket.map((id, k) => ({ prepItemId: id, listOrder: k })))
  }

  const btn = (disabled: boolean) =>
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 min-h-[44px] text-[13px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-3 border-line' : 'bg-paper text-ink-2 border-line-2 active:bg-bg-2'}`
  const paneCls = 'bg-paper border border-line rounded-[14px] overflow-hidden'

  return (
    <div className="relative flex flex-col gap-3 mt-1">
      <p className="text-[14px] text-ink-3 m-0">
        <b className="font-semibold text-ink">{smart.toMake} more to make.</b>
        {!clean && changeCount > 0 && <> <b className="font-semibold text-gold-2">{changeCount} {changeCount === 1 ? 'change' : 'changes'}</b> not posted.</>}
      </p>

      <CrewBar cooks={cooks} crewIds={smart.crewIds} onCrewChange={handlers.onCrewChange} capacity={capacity} ctx={ctx} locked={locked} compact />

      {/* ── your list ── */}
      <div className={paneCls}>
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex items-center gap-2 w-full min-h-[48px] px-3.5 text-left">
          <span className="text-[15px] font-semibold text-ink">Your list</span>
          <span className="text-[12.5px] text-ink-3">{draft.length} to start · {cooking.length} on the go</span>
          <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-ink-2">
            {open ? 'Close' : 'Open'} <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none' }} />
          </span>
        </button>
        {!open ? (
          <>
            {sorted.slice(0, 2).map(t => (
              <PreviewLine key={t.id} item={t} ctx={ctx} nowMin={nowMin} cooks={cooks}
                isNew={changes.added.includes(t)} onOpen={handlers.onOpen} />
            ))}
            {(sorted.length > 2 || cooking.length > 0) && (
              <button type="button" onClick={() => setOpen(true)}
                className="flex w-full min-h-[44px] items-center px-3.5 border-t border-dashed border-line-2 text-[13px] text-ink-3 text-left">
                {sorted.length > 2 ? `+ ${sorted.length - 2} more` : ''}{sorted.length > 2 && cooking.length ? ' · ' : ''}{cooking.length ? `${cooking.length} on the go` : ''}
              </button>
            )}
            {!draft.length && !cooking.length && (
              <div className="px-3.5 pb-3 text-[13px] text-ink-3">Nothing on your list yet — add from the prep list below.</div>
            )}
          </>
        ) : (
          <>
            <GoStrip items={cooking} nowMs={nowMs ?? Date.now()} onOpen={handlers.onOpen} />
            <div className="flex flex-wrap gap-2 px-3 py-2.5 border-t border-line">
              {resets > 0 && (
                <button type="button" onClick={handlers.onResetQuantities} disabled={locked} className={btn(locked)}>
                  Reset {resets} {resets === 1 ? 'quantity' : 'quantities'}
                </button>
              )}
              <button type="button" onClick={() => setConfirmEmpty(true)} disabled={locked || !draft.length} className={btn(locked || !draft.length)}>
                Empty the list…
              </button>
            </div>
            <div className="px-2.5 pb-3">
              {!draft.length && (
                <div className="flex flex-col items-center gap-2 py-10 text-ink-3">
                  <Package size={24} className="text-line-2" />
                  <span className="text-[13.5px]">Nothing to start on your list</span>
                </div>
              )}
              {planGroups(draft, 'urgency', { ord: draftOrd }).map(g => (
                <div key={g.key}>
                  <GroupHead g={g} count={g.rows.length} mins={g.rows.reduce((a, t) => a + activeOf(t), 0)} />
                  <div className="flex flex-col gap-2">
                    {g.rows.map((t, i) => (
                      <MobileDraftCard key={t.id} item={t} cooks={cooks} crewIds={smart.crewIds} locked={locked}
                        ctx={ctx} wont={wontOf(t)} batchMode={isBatchMode(t, batchToggles)}
                        first={i === 0} last={i === g.rows.length - 1}
                        onMove={dir => nudge(t, dir)} onToggleBatch={onToggleBatch} handlers={handlers} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── the prep list ── */}
      <div className="flex items-center gap-1.5">
        <FilterChips filter={filter} onFilter={setFilter} counts={counts} compact />
        <span className="relative ml-auto">
          <button type="button" onClick={() => setViewMenu(v => !v)}
            className="inline-flex items-center gap-1 min-h-[44px] px-1.5 text-[13px] font-semibold text-ink-2 whitespace-nowrap">
            {view === 'CATEGORY' ? 'Category' : 'Step'} <ChevronDown size={14} />
          </button>
          {viewMenu && (
            <Popover onClose={() => setViewMenu(false)} w="w-40">
              {(['CATEGORY', 'STEP'] as const).map(v => (
                <button key={v} type="button" onClick={() => { setView(v); setViewMenu(false) }} className={`${popItemCls(view === v)} min-h-[44px]`}>
                  {v === 'CATEGORY' ? 'By category' : 'By step'}
                </button>
              ))}
            </Popover>
          )}
        </span>
      </div>
      {smart.toMake > 0 && (
        <button type="button" onClick={handlers.onAddAllToMake} disabled={locked} className={`${btn(locked)} self-start`}>
          <Plus size={15} className={locked ? 'text-ink-3' : 'text-gold-2'} /> Add all {smart.toMake} to make
        </button>
      )}
      <div className={paneCls}>
        <PrepListPane items={items} hidden={hidden} view={view} filter={filter} onFilter={setFilter}
          ctx={ctx} nowMin={nowMin} ord={draftOrd} locked={locked} canFixPar={smart.canFixPar}
          showJump={false} compact idPrefix="m-" handlers={handlers} />
      </div>

      {/* room for the post bar, so it never covers the last card */}
      <div aria-hidden className="h-[96px]" />

      {/* sticky post bar */}
      <div className="fixed left-0 right-0 bottom-[64px] z-30 px-4 pb-2 pt-3 bg-bg border-t border-line">
        {/* mr-[60px]: the chat bubble sits bottom-right at this height */}
        <div className="mr-[60px]">
          {locked ? (
            <div className="flex items-center justify-center gap-2 bg-paper border border-line rounded-xl min-h-[48px] text-[13px] font-semibold text-ink-3">
              <Lock size={14} /> Pick a kitchen you can edit to post
            </div>
          ) : clean ? (
            <div className="flex items-center gap-2 bg-paper border border-line rounded-xl px-3 py-2">
              <span className="w-8 h-8 rounded-lg bg-green-soft grid place-items-center shrink-0"><Check size={15} className="text-green" /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-semibold text-ink">Live on To Do</div>
                <div className="text-[12px] text-ink-3 truncate">
                  Posted {fmtClock(new Date(post!.postedAt).getHours() * 60 + new Date(post!.postedAt).getMinutes())} · {post!.itemCount} items
                </div>
              </div>
              <button type="button" onClick={handlers.onRecall} className="inline-flex items-center gap-1.5 rounded-[10px] px-3 min-h-[44px] text-[13px] font-semibold border border-line-2 bg-paper text-ink-2">
                <Undo2 size={14} /> Recall
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setDlg(true)} disabled={!onList.length}
              className={`flex items-center justify-center gap-2 w-full rounded-[13px] min-h-[52px] text-[15px] font-semibold ${onList.length ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-3'}`}>
              <Zap size={16} className={onList.length ? 'text-gold' : 'text-ink-3'} />
              Review &amp; post{changeCount ? ` · ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : ''}
            </button>
          )}
        </div>
      </div>

      {confirmEmpty && (
        <ConfirmEmpty count={emptyListIds(onList).length} onCancel={() => setConfirmEmpty(false)}
          onConfirm={() => { handlers.onEmptyList(); setConfirmEmpty(false) }} />
      )}
      {dlg && (
        <PostDialog all={allItems} onList={onList} cooks={cooks} crewIds={smart.crewIds} ctx={ctx} nowMin={nowMin} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={dues => { handlers.onPost(dues); setDlg(false) }} />
      )}
    </div>
  )
}

const URG = ['PASS', 'MID', 'CLOSE', 'TMRW']
const urgencyIndex = (t: PrepItemRich) => URG.indexOf(effectiveUrgency(t))
