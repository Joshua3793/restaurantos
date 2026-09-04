'use client'
// Smart Prep v2 — mobile planner (design planner-mobile.jsx): the same two
// panes as tabs, ONE urgency step per item, arrow-nudge reordering, group-by
// pills, sticky post bar.
import { useMemo, useState } from 'react'
import { Sparkles, Zap, Undo2, Lock, AlertTriangle, Package, Check, ChevronDown, X } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { RcService } from '@/lib/service-hours'
import {
  PLAN_URG_META, effectiveUrgency, planDayContext, planSchedule, planGroups,
  suggestedDraftQty, fmtDeadline, draftListOrder as draftOrd,
  type PlanSlot, type PlanDayContext,
} from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { GroupHead, UrgPicker, AssignPill, QtyStepper, Reason } from './atoms'
import { SuggestionRow } from './SuggestionRow'
import { PostDialog } from './PostDialog'
import { Segmented } from '@/components/prep/runsheet/atoms'
import { isBatchMode } from './PlannerDesktop'
import type { PlannerHandlers } from './PlannerDesktop'

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

function MobileDraftCard({ item, cooks, locked, ctx, slot, batchMode, first, last, onMove, onToggleBatch, handlers }: {
  item: PrepItemRich; cooks: Cook[]; locked: boolean
  ctx: PlanDayContext | null; slot: PlanSlot | null; batchMode: boolean
  first: boolean; last: boolean
  onMove: (dir: -1 | 1) => void
  onToggleBatch: (item: PrepItemRich, next: boolean) => void
  handlers: PlannerHandlers
}) {
  const m = PLAN_URG_META[effectiveUrgency(item)]
  const arrow = (dir: -1 | 1, disabled: boolean) => (
    <button type="button" onClick={() => onMove(dir)} disabled={locked || disabled}
      className={`w-[26px] h-5 rounded-md bg-bg border border-line grid place-items-center ${disabled ? 'opacity-30' : ''}`}>
      <ChevronDown size={11} className="text-ink-3" style={{ transform: dir < 0 ? 'rotate(180deg)' : 'none' }} />
    </button>
  )
  return (
    <div className="bg-paper border border-line rounded-[11px] px-2.5 py-[9px] border-l-[3px]" style={{ borderLeftColor: m.hex }}>
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-[3px] shrink-0 pt-px">{arrow(-1, first)}{arrow(1, last)}</div>
        <button type="button" onClick={() => handlers.onOpen(item)} className="flex-1 min-w-0 text-left">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
            {item.isBlocked && <span className="font-mono text-[9px] font-bold uppercase bg-gold-soft text-gold-2 px-1.5 py-0.5 rounded-full shrink-0">BLOCKED</span>}
          </span>
          <span className={`block font-mono text-[9px] mt-0.5 truncate ${slot && !slot.fits ? 'text-red-text font-bold' : 'text-ink-4'}`}>
            {item.station ?? item.category}
            {slot
              ? ` · ${fmtClock(slot.start)}–${fmtClock(slot.end % 1440)} · by ${fmtDeadline(slot.deadline, fmtClock)}${slot.fits ? '' : ' · WON’T FIT'}`
              : item.startByMinutes != null ? ` · START ${fmtClock(item.startByMinutes)}` : ''}
          </span>
        </button>
        <button type="button" disabled={locked} onClick={() => handlers.onRemove(item)}
          className="w-6 h-6 rounded-[7px] grid place-items-center shrink-0">
          <X size={13} className={locked ? 'text-line-2' : 'text-ink-4'} />
        </button>
      </div>
      {/* flex-wrap: on narrow screens (≤375px) the batch stepper + dial can fill
          the row — the assign pill then wraps below instead of clipping off-screen */}
      <div className="flex flex-wrap items-center gap-x-[7px] gap-y-1.5 mt-2">
        <QtyStepper item={item} locked={locked} batchMode={batchMode} onQty={handlers.onQty} onToggleBatch={onToggleBatch} suggested={suggestedDraftQty(item)} sm />
        <UrgPicker item={item} locked={locked} ctx={ctx} onChange={step => handlers.onPriorityChange(item.id, step)} w="w-[96px]" />
        <span className="flex-1" />
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} locked={locked} onAssign={id => handlers.onAssign(item, id)} />
      </div>
      <div className="mt-[7px]"><Reason item={item} sm /></div>
      <input
        key={item.todayLog?.id ?? item.id}
        defaultValue={item.todayLog?.note ?? ''}
        disabled={locked}
        onBlur={e => { if ((item.todayLog?.note ?? '') !== e.target.value) handlers.onNote(item, e.target.value) }}
        placeholder="+ note for the cook"
        className="w-full mt-1.5 text-[12px] text-ink-2 bg-transparent border-0 border-t border-line pt-[7px] outline-none placeholder:text-ink-4"
      />
    </div>
  )
}

export function PlannerMobile({ items, allItems, cooks, stations, services, nowMin, canPlan, post, handlers }: {
  items: PrepItemRich[]
  allItems: PrepItemRich[]
  cooks: Cook[]
  stations: string[]
  services: RcService[]
  nowMin: number
  canPlan: boolean
  post: PrepPostInfo | null
  handlers: PlannerHandlers
}) {
  const locked = !canPlan
  const [tab, setTab] = useState<'draft' | 'sugg'>('draft')
  const [groupBy, setGroupBy] = useState<'urgency' | 'station' | 'category'>('urgency')
  const [dlg, setDlg] = useState(false)
  const [batchToggles, setBatchToggles] = useState<Map<string, boolean>>(new Map())
  const onToggleBatch = (item: PrepItemRich, next: boolean) =>
    setBatchToggles(prev => new Map(prev).set(item.id, next))

  const ctx = useMemo(() => planDayContext(services, nowMin), [services, nowMin])
  const draft = useMemo(() => allItems.filter(i => i.isOnList), [allItems])
  const sched = useMemo<Map<string, PlanSlot>>(
    () => (ctx ? planSchedule(draft, cooks, ctx, draftOrd) : new Map()),
    [draft, cooks, ctx],
  )
  const wont = draft.filter(t => sched.get(t.id) && !sched.get(t.id)!.fits).length
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const openCount = draft.filter(t => !t.todayLog?.assignedTo).length
  const notInDraft = items.filter(t => !t.isOnList).length
  const clean = post != null && !post.dirty
  const groupOpts = { stations, crew: cooks, ord: draftOrd }

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

  const bulkBtn = (disabled: boolean) =>
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-4 border-line' : 'bg-paper text-ink-2 border-line-2 active:bg-bg-2'}`

  const groupPills = (opts: Array<['urgency' | 'station' | 'category', string]>) => (
    <div className="flex items-center gap-1.5 mt-[11px]">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4">Group by</span>
      {opts.map(([k, l]) => (
        <button key={k} type="button" onClick={() => setGroupBy(k)}
          className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] rounded-full px-[11px] py-[5px] border ${groupBy === k ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-3 border-line-2'}`}>
          {l}
        </button>
      ))}
    </div>
  )

  return (
    <div className="relative">
      {/* summary card */}
      <div className="flex items-center gap-3 bg-ink text-[#e4e4e7] rounded-[13px] px-3.5 py-3">
        <div className="shrink-0">
          <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4">Prep list</div>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="font-mono text-[20px] font-semibold text-paper">{draft.length}</span>
            <span className={`font-mono text-[9.5px] font-bold uppercase px-2 py-0.5 rounded-full ${clean ? 'bg-green-soft text-green-text' : 'bg-[#27272a] text-paper'}`}>
              {post ? (post.dirty ? 'CHANGES' : 'POSTED') : 'DRAFT'}
            </span>
          </div>
        </div>
        <span className="w-px self-stretch bg-[#27272a]" />
        <div className="flex-1 flex flex-col gap-[3px] min-w-0">
          <span className="font-mono text-[9.5px] text-ink-4">{draft.length} on the list · {fmtMins(mins)} hands-on</span>
          <span className={`font-mono text-[9.5px] ${openCount || wont ? 'text-gold' : 'text-ink-4'}`}>
            {openCount ? `${openCount} unassigned` : 'everything assigned'}{wont ? ` · ${wont} won’t fit` : ''}
          </span>
        </div>
      </div>

      <Segmented className="mt-3" value={tab} onPick={setTab} options={[
        { id: 'draft', label: 'Prep list', badge: draft.length },
        { id: 'sugg', label: 'Suggestions', badge: notInDraft, badgeTone: notInDraft ? 'red' : 'neutral' },
      ]} />

      <div className="pb-24">
        {tab === 'sugg' ? (
          <>
            <div className="flex gap-[7px] mt-3">
              <button type="button" onClick={handlers.onAddAllCritical} disabled={locked} className={bulkBtn(locked)}>
                <AlertTriangle size={13} /> Add all critical
              </button>
              <button type="button" onClick={handlers.onAcceptSuggested} disabled={locked} className={bulkBtn(locked)}>
                <Sparkles size={13} /> Accept suggested
              </button>
            </div>
            {groupPills([['urgency', 'Step'], ['station', 'Station'], ['category', 'Category']])}
            {planGroups(items, groupBy, groupOpts).map(g => (
              <div key={g.key}>
                <GroupHead g={g} count={g.rows.length} />
                <div className="flex flex-col gap-1.5">
                  {g.rows.map(t => <SuggestionRow key={t.id} item={t} locked={locked} onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} />)}
                </div>
              </div>
            ))}
          </>
        ) : (
          <>
            {!draft.length ? (
              <div className="flex flex-col items-center gap-[7px] py-14 text-ink-4">
                <Package size={24} className="text-line-2" />
                <span className="text-[13px] text-ink-3">Nothing on today&apos;s list</span>
                <span className="font-mono text-[10px]">ADD FROM SUGGESTIONS</span>
              </div>
            ) : (
              <>
                {groupPills([['urgency', 'Step'], ['station', 'Station']])}
                {planGroups(draft, groupBy === 'category' ? 'urgency' : groupBy, groupOpts).map(g => (
                  <div key={g.key}>
                    <GroupHead g={g} count={g.rows.length} mins={g.rows.reduce((a, t) => a + activeOf(t), 0)} />
                    <div className="flex flex-col gap-[7px]">
                      {g.rows.map((t, i) => (
                        <MobileDraftCard key={t.id} item={t} cooks={cooks} locked={locked}
                          ctx={ctx} slot={sched.get(t.id) ?? null} batchMode={isBatchMode(t, batchToggles)}
                          first={i === 0} last={i === g.rows.length - 1}
                          onMove={dir => nudge(t, dir)} onToggleBatch={onToggleBatch} handlers={handlers} />
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* sticky post bar */}
      <div className="fixed left-0 right-0 bottom-[64px] z-30 px-4 pb-2 pt-4 bg-gradient-to-t from-bg via-bg/90 to-transparent pointer-events-none">
        <div className="pointer-events-auto">
          {locked ? (
            <div className="flex items-center justify-center gap-2 bg-paper border border-line rounded-xl py-3 font-mono text-[10.5px] font-bold uppercase tracking-[0.03em] text-ink-3">
              <Lock size={13} /> Chef posts the list
            </div>
          ) : clean ? (
            <div className="flex items-center gap-2 bg-paper border border-line rounded-xl px-3 py-2.5 shadow-lg">
              <span className="w-[26px] h-[26px] rounded-lg bg-green-soft grid place-items-center shrink-0"><Check size={14} className="text-green" /></span>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold text-ink">Live on To Do</div>
                <div className="font-mono text-[9px] text-ink-4 truncate">
                  POSTED {fmtClock(new Date(post!.postedAt).getHours() * 60 + new Date(post!.postedAt).getMinutes())} · {post!.itemCount} ITEMS
                </div>
              </div>
              <button type="button" onClick={handlers.onRecall} className="inline-flex items-center gap-1.5 rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold border border-line-2 bg-paper text-ink-2">
                <Undo2 size={13} /> Recall
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setDlg(true)} disabled={!draft.length}
              className={`flex items-center justify-center gap-2 w-full rounded-[13px] py-[15px] text-[14.5px] font-semibold shadow-[0_8px_24px_-10px_rgba(9,9,11,0.4)] ${draft.length ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-4'}`}>
              <Zap size={15} className={draft.length ? 'text-gold' : 'text-ink-4'} /> {post ? `Update To Do · ${draft.length}` : `Review & post · ${draft.length}`}
            </button>
          )}
        </div>
      </div>

      {dlg && (
        <PostDialog draft={draft} cooks={cooks} stations={stations} ctx={ctx} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={dues => { handlers.onPost(dues); setDlg(false) }} />
      )}
    </div>
  )
}
