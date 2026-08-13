'use client'
// Smart Prep v2 — mobile planner (design planner-mobile.jsx): the same two
// panes as tabs, arrow-nudge reordering instead of drag, sticky post bar.
import { useMemo, useState } from 'react'
import { Sparkles, Zap, Undo2, Lock, AlertTriangle, Package, Check, ChevronDown, Minus, Plus, X } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIORITY_ORDER, PLAN_PRIO_META, effectivePriority, suggestedDraftQty, draftQty, prepStep } from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { BucketHead, PrioPicker, AssignPill } from './atoms'
import { SuggestionRow } from './SuggestionRow'
import { PostDialog } from './PostDialog'
import { Segmented } from '@/components/prep/runsheet/atoms'
import type { PlannerHandlers } from './PlannerDesktop'
import { sortDraft } from './PlannerDesktop'

const fmtQ = (q: number, u: string) => `${(u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)} ${u}`
const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

function MobileDraftCard({ item, cooks, locked, first, last, onMove, handlers }: {
  item: PrepItemRich; cooks: Cook[]; locked: boolean; first: boolean; last: boolean
  onMove: (dir: -1 | 1) => void
  handlers: PlannerHandlers
}) {
  const p = effectivePriority(item)
  const sugg = suggestedDraftQty(item)
  const qty = draftQty(item)
  const step = prepStep(item.unit)
  const overridden = sugg > 0 && Math.abs(qty - sugg) > 0.01
  const arrow = (dir: -1 | 1, disabled: boolean) => (
    <button type="button" onClick={() => onMove(dir)} disabled={locked || disabled}
      className={`w-[26px] h-5 rounded-md bg-bg border border-line grid place-items-center ${disabled ? 'opacity-30' : ''}`}>
      <ChevronDown size={11} className="text-ink-3" style={{ transform: dir < 0 ? 'rotate(180deg)' : 'none' }} />
    </button>
  )
  return (
    <div className="bg-paper border border-line rounded-[11px] px-2.5 py-[9px] border-l-[3px]"
      style={{ borderLeftColor: p === '911' ? '#dc2626' : p === 'NEEDED_TODAY' ? '#d97706' : '#16a34a' }}>
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-[3px] shrink-0 pt-px">{arrow(-1, first)}{arrow(1, last)}</div>
        <button type="button" onClick={() => handlers.onOpen(item)} className="flex-1 min-w-0 text-left">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.name}</span>
            {item.isBlocked && <span className="font-mono text-[9px] font-bold uppercase bg-gold-soft text-gold-2 px-1.5 py-0.5 rounded-full shrink-0">BLOCKED</span>}
          </span>
          <span className="block font-mono text-[9px] text-ink-4 mt-0.5 truncate">
            {item.station ?? item.category}{item.startByMinutes != null ? ` · START ${fmtClock(item.startByMinutes)}` : ''}{item.service ? ` · ${item.service.name}` : ''}
          </span>
        </button>
        <button type="button" disabled={locked} onClick={() => handlers.onRemove(item)}
          className="w-6 h-6 rounded-[7px] grid place-items-center shrink-0">
          <X size={13} className={locked ? 'text-line-2' : 'text-ink-4'} />
        </button>
      </div>
      <div className="flex items-center gap-[7px] mt-2">
        <div className="inline-flex items-center bg-bg-2 border border-line rounded-[9px] shrink-0">
          <button type="button" disabled={locked} onClick={() => handlers.onQty(item, Math.max(step, +(qty - step).toFixed(2)))} className="w-[30px] h-8 grid place-items-center">
            <Minus size={13} className="text-ink-2" />
          </button>
          <span className={`min-w-[52px] text-center font-mono text-[12.5px] font-bold ${overridden ? 'text-gold-2' : 'text-ink'}`}>{fmtQ(qty, item.unit)}</span>
          <button type="button" disabled={locked} onClick={() => handlers.onQty(item, +(qty + step).toFixed(2))} className="w-[30px] h-8 grid place-items-center">
            <Plus size={13} className="text-ink-2" />
          </button>
        </div>
        <PrioPicker item={item} locked={locked} onChange={prio => handlers.onPriorityChange(item.id, prio)} />
        <span className="flex-1" />
        <AssignPill cookId={item.todayLog?.assignedTo ?? null} cooks={cooks} locked={locked} onAssign={id => handlers.onAssign(item, id)} />
      </div>
      <input
        key={item.todayLog?.id ?? item.id}
        defaultValue={item.todayLog?.note ?? ''}
        disabled={locked}
        onBlur={e => { if ((item.todayLog?.note ?? '') !== e.target.value) handlers.onNote(item, e.target.value) }}
        placeholder="+ note for the cook"
        className="w-full mt-[7px] text-[12px] text-ink-2 bg-transparent border-0 border-t border-line pt-[7px] outline-none placeholder:text-ink-4"
      />
    </div>
  )
}

export function PlannerMobile({ items, allItems, cooks, stations, canPlan, post, handlers }: {
  items: PrepItemRich[]
  allItems: PrepItemRich[]
  cooks: Cook[]
  stations: string[]
  canPlan: boolean
  post: PrepPostInfo | null
  handlers: PlannerHandlers
}) {
  const locked = !canPlan
  const [tab, setTab] = useState<'draft' | 'sugg'>('draft')
  const [sgroup, setSgroup] = useState<'priority' | 'category'>('priority')
  const [dlg, setDlg] = useState(false)

  const draft = useMemo(() => sortDraft(allItems), [allItems])
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const openCount = draft.filter(t => !t.todayLog?.assignedTo).length
  const notInDraft = items.filter(t => !t.isOnList).length
  const clean = post != null && !post.dirty

  const nudge = (item: PrepItemRich, dir: -1 | 1) => {
    const bucket = draft.filter(x => effectivePriority(x) === effectivePriority(item)).map(x => x.id)
    const i = bucket.indexOf(item.id), j = i + dir
    if (i < 0 || j < 0 || j >= bucket.length) return
    ;[bucket[i], bucket[j]] = [bucket[j], bucket[i]]
    handlers.onReorder(bucket.map((id, k) => ({ prepItemId: id, listOrder: k })))
  }

  const bulkBtn = (disabled: boolean) =>
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-4 border-line' : 'bg-paper text-ink-2 border-line-2 active:bg-bg-2'}`

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
          <span className={`font-mono text-[9.5px] ${openCount ? 'text-gold' : 'text-ink-4'}`}>{openCount ? `${openCount} unassigned` : 'everything assigned'}</span>
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
                <AlertTriangle size={13} /> Add all criticals
              </button>
              <button type="button" onClick={handlers.onAcceptSuggested} disabled={locked} className={bulkBtn(locked)}>
                <Sparkles size={13} /> Accept suggested
              </button>
            </div>
            <div className="flex items-center gap-1.5 mt-[11px]">
              <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4">View by</span>
              {(['priority', 'category'] as const).map(k => (
                <button key={k} type="button" onClick={() => setSgroup(k)}
                  className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] rounded-full px-[11px] py-[5px] border ${sgroup === k ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-3 border-line-2'}`}>
                  {k}
                </button>
              ))}
            </div>
            {sgroup === 'priority'
              ? PLAN_PRIORITY_ORDER.map(p => {
                  const grp = items.filter(t => effectivePriority(t) === p)
                  if (!grp.length) return null
                  return (
                    <div key={p}>
                      <BucketHead p={p} count={grp.length} />
                      <div className="flex flex-col gap-1.5">
                        {grp.map(t => <SuggestionRow key={t.id} item={t} locked={locked} onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} />)}
                      </div>
                    </div>
                  )
                })
              : [...new Set(items.map(t => t.category))].sort().map(cat => {
                  const grp = items.filter(t => t.category === cat)
                    .sort((a, b) => PLAN_PRIORITY_ORDER.indexOf(effectivePriority(a)) - PLAN_PRIORITY_ORDER.indexOf(effectivePriority(b)))
                  if (!grp.length) return null
                  return (
                    <div key={cat}>
                      <div className="flex items-center gap-2 mt-3.5 mb-1.5 mx-0.5">
                        <span className="font-mono text-[10.5px] font-bold tracking-[0.05em] text-ink">{cat}</span>
                        <span className="font-mono text-[9.5px] text-ink-4">· {grp.length}</span>
                        <span className="flex gap-1 ml-auto">
                          {PLAN_PRIORITY_ORDER.map(p => {
                            const n = grp.filter(t => effectivePriority(t) === p).length
                            if (!n) return null
                            return (
                              <span key={p} className={`inline-flex items-center gap-1 font-mono text-[9px] font-bold ${PLAN_PRIO_META[p].textClass}`}>
                                <span className={`w-[5px] h-[5px] rounded-full ${PLAN_PRIO_META[p].dotClass}`} />{n}
                              </span>
                            )
                          })}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {grp.map(t => <SuggestionRow key={t.id} item={t} locked={locked} onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} />)}
                      </div>
                    </div>
                  )
                })}
          </>
        ) : (
          <>
            {!draft.length && (
              <div className="flex flex-col items-center gap-[7px] py-14 text-ink-4">
                <Package size={24} className="text-line-2" />
                <span className="text-[13px] text-ink-3">Nothing on today&apos;s list</span>
                <span className="font-mono text-[10px]">ADD FROM SUGGESTIONS</span>
              </div>
            )}
            {PLAN_PRIORITY_ORDER.map(p => {
              const grp = draft.filter(t => effectivePriority(t) === p)
              if (!grp.length) return null
              return (
                <div key={p}>
                  <BucketHead p={p} count={grp.length} mins={grp.reduce((a, t) => a + activeOf(t), 0)} />
                  <div className="flex flex-col gap-[7px]">
                    {grp.map((t, i) => (
                      <MobileDraftCard key={t.id} item={t} cooks={cooks} locked={locked}
                        first={i === 0} last={i === grp.length - 1}
                        onMove={dir => nudge(t, dir)} handlers={handlers} />
                    ))}
                  </div>
                </div>
              )
            })}
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
        <PostDialog draft={draft} cooks={cooks} stations={stations} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={() => { handlers.onPost(); setDlg(false) }} />
      )}
    </div>
  )
}
