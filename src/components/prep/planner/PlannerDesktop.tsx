'use client'
// Smart Prep v2 — desktop split-view planner (design planner.jsx PPPlanner):
// suggestions on the left, the chef's draft prep list on the right, and the
// post/recall footer. Nothing reaches a cook until the chef posts.
import { useMemo, useState } from 'react'
import { Sparkles, ChefHat, Zap, Undo2, Lock, Users, AlertTriangle, Package, Check } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIORITY_ORDER, effectivePriority } from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { BucketHead, Popover, popItemCls, popHeadCls } from './atoms'
import { SuggestionRow } from './SuggestionRow'
import { DraftRow } from './DraftRow'
import { PostDialog } from './PostDialog'

export interface PlannerHandlers {
  onOpen: (item: PrepItemRich) => void
  onAdd: (item: PrepItemRich) => void
  onRemove: (item: PrepItemRich) => void
  onQty: (item: PrepItemRich, qty: number) => void
  onNote: (item: PrepItemRich, note: string) => void
  onAssign: (item: PrepItemRich, cookId: string | null) => void
  onAssignStation: (station: string, cookId: string) => void
  onPriorityChange: (id: string, prio: string) => void
  onReorder: (orders: Array<{ prepItemId: string; listOrder: number }>) => void
  onAcceptSuggested: () => void
  onAddAllCritical: () => void
  onClearDraft: () => void
  onPost: () => void
  onRecall: () => void
}

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0
const draftOrd = (i: PrepItemRich) => i.todayLog?.listOrder ?? 9999

/** Draft = on-list items, priority-bucketed, chef order within a bucket. */
export function sortDraft(items: PrepItemRich[]): PrepItemRich[] {
  return items
    .filter(i => i.isOnList)
    .sort((a, b) =>
      PLAN_PRIORITY_ORDER.indexOf(effectivePriority(a)) - PLAN_PRIORITY_ORDER.indexOf(effectivePriority(b)) ||
      draftOrd(a) - draftOrd(b) ||
      a.name.localeCompare(b.name))
}

export function PlannerDesktop({
  items, allItems, stations, cooks, canPlan, post,
  search, onSearch, station, onStation, handlers, tasksSlot,
}: {
  items: PrepItemRich[]              // filtered (search/category) — shapes the LEFT pane
  allItems: PrepItemRich[]           // unfiltered — the draft pane must not hide rows on search
  stations: string[]
  cooks: Cook[]
  canPlan: boolean
  post: PrepPostInfo | null
  search: string
  onSearch: (v: string) => void
  station: string
  onStation: (v: string) => void
  handlers: PlannerHandlers
  tasksSlot?: React.ReactNode
}) {
  const locked = !canPlan
  const [dlg, setDlg] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [warn, setWarn] = useState<PrepPriority | null>(null)
  const [assignPop, setAssignPop] = useState(false)

  const pool = useMemo(
    () => items.filter(t => station === 'all' || (t.station ?? '') === station),
    [items, station],
  )
  const draft = useMemo(() => sortDraft(allItems), [allItems])
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const openCount = draft.filter(t => !t.todayLog?.assignedTo).length
  const crit = allItems.filter(t => effectivePriority(t) === '911' && !t.isOnList).length
  const clean = post != null && !post.dirty

  const flagWarn = (p: PrepPriority) => { setWarn(p); setTimeout(() => setWarn(null), 1800) }
  const byId = (id: string) => allItems.find(x => x.id === id)
  const onDragOverRow = (t: PrepItemRich) => (e: React.DragEvent) => {
    if (!drag) return
    const src = byId(drag)
    if (src && effectivePriority(src) === effectivePriority(t)) { e.preventDefault(); setOver(t.id) }
  }
  const onDropRow = (t: PrepItemRich) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!drag || drag === t.id) { setOver(null); return }
    const src = byId(drag)
    if (!src) return
    if (effectivePriority(src) !== effectivePriority(t)) { flagWarn(effectivePriority(t)); setOver(null); return }
    const bucket = draft.filter(x => effectivePriority(x) === effectivePriority(src)).map(x => x.id)
    const from = bucket.indexOf(drag), to = bucket.indexOf(t.id)
    if (from < 0 || to < 0) return
    bucket.splice(to, 0, bucket.splice(from, 1)[0])
    handlers.onReorder(bucket.map((id, i) => ({ prepItemId: id, listOrder: i })))
    setOver(null); setDrag(null)
  }

  const paneCls = 'bg-paper border border-line rounded-[14px] flex flex-col min-h-0 overflow-hidden'
  const btnCls = (disabled: boolean) =>
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-4 border-line cursor-not-allowed' : 'bg-paper text-ink-2 border-line-2 hover:border-ink-3'}`

  return (
    <div className="space-y-3.5">
      {tasksSlot}
      <div className="grid grid-cols-[440px_1fr] gap-3.5 items-stretch" style={{ height: 'calc(100vh - 230px)', minHeight: 560 }}>
        {/* ── suggestions ── */}
        <div className={paneCls}>
          <div className="shrink-0 flex items-center gap-2 px-3.5 pt-3 pb-2.5 border-b border-line">
            <span className="w-6 h-6 rounded-[7px] bg-gold-soft grid place-items-center shrink-0"><Sparkles size={13} className="text-gold-2" /></span>
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-semibold tracking-[-0.015em] text-ink">Suggestions</div>
              <div className="font-mono text-[9px] text-ink-4">{items.length} ACTIVE PREP ITEMS · FROM PAR + LAST COUNT</div>
            </div>
            <input
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search"
              className="w-24 text-[11.5px] text-ink bg-bg border border-line rounded-lg px-2 py-1.5 outline-none placeholder:text-ink-4"
            />
          </div>
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-line overflow-x-auto">
            {['all', ...stations].map(s => (
              <button key={s} type="button" onClick={() => onStation(s)}
                className={`shrink-0 font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] rounded-full px-2.5 py-1 border ${station === s ? 'bg-ink text-paper border-ink' : 'bg-bg text-ink-3 border-line'}`}>
                {s === 'all' ? 'ALL' : s}
              </button>
            ))}
          </div>
          <div className="shrink-0 flex gap-1.5 px-3 py-2.5 bg-bg border-b border-line">
            <button type="button" onClick={handlers.onAddAllCritical} disabled={locked || !crit} className={btnCls(locked || !crit)}>
              <AlertTriangle size={13} className={locked || !crit ? 'text-ink-4' : 'text-ink-3'} /> Add all criticals{crit ? ` · ${crit}` : ''}
            </button>
            <button type="button" onClick={handlers.onAcceptSuggested} disabled={locked} className={btnCls(locked)}>
              <Sparkles size={13} className={locked ? 'text-ink-4' : 'text-ink-3'} /> Accept suggested qty
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3.5 pt-0.5 min-h-0">
            {PLAN_PRIORITY_ORDER.map(p => {
              const grp = pool.filter(t => effectivePriority(t) === p)
              if (!grp.length) return null
              return (
                <div key={p}>
                  <BucketHead p={p} count={grp.length} />
                  <div className="flex flex-col gap-1.5">
                    {grp.map(t => (
                      <SuggestionRow key={t.id} item={t} locked={locked}
                        onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} />
                    ))}
                  </div>
                </div>
              )
            })}
            {pool.length === 0 && (
              <div className="py-14 text-center font-mono text-[10.5px] text-ink-4">NO ITEMS MATCH</div>
            )}
          </div>
        </div>

        {/* ── prep list draft ── */}
        <div className={`${paneCls} ${clean ? '' : '!border-ink'}`}>
          <div className={`shrink-0 flex items-center gap-2 px-3.5 pt-3 pb-2.5 border-b border-line ${clean ? 'bg-paper' : 'bg-bg'}`}>
            <span className="w-6 h-6 rounded-[7px] bg-ink grid place-items-center shrink-0"><ChefHat size={13} className="text-gold" /></span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold tracking-[-0.015em] text-ink">Prep list</span>
                <span className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] px-[7px] py-0.5 rounded-full ${clean ? 'bg-green-soft text-green-text' : 'bg-ink text-paper'}`}>
                  {post ? (post.dirty ? 'UNPOSTED CHANGES' : 'POSTED') : 'DRAFT'}
                </span>
              </div>
              <div className="font-mono text-[9px] text-ink-4">
                {draft.length} ITEMS · {fmtMins(mins).toUpperCase()} HANDS-ON · {openCount} UNASSIGNED
              </div>
            </div>
            <div className="relative shrink-0">
              <button type="button" onClick={() => setAssignPop(v => !v)} disabled={locked} className={btnCls(locked)}>
                <Users size={13} className={locked ? 'text-ink-4' : 'text-ink-3'} /> Assign a station
              </button>
              {assignPop && (
                <Popover onClose={() => setAssignPop(false)} w="w-56">
                  <div className={popHeadCls}>Give a whole station to</div>
                  {stations.map(s => {
                    const c = cooks.find(x => x.homeStation === s)
                    const n = draft.filter(t => t.station === s).length
                    const dis = !c || !n
                    return (
                      <button key={s} type="button" disabled={dis}
                        onClick={() => { if (c) { handlers.onAssignStation(s, c.id); setAssignPop(false) } }}
                        className={`${popItemCls(false)} ${dis ? 'opacity-40 cursor-not-allowed' : ''}`}>
                        {s}
                        <span className="ml-auto font-mono text-[9.5px] text-ink-4 font-semibold">{n} → {c ? c.initials : '—'}</span>
                      </button>
                    )
                  })}
                </Popover>
              )}
            </div>
            <button type="button" onClick={handlers.onClearDraft} disabled={locked || !draft.length} className={btnCls(locked || !draft.length)}>Clear</button>
          </div>

          <div className="flex-1 overflow-y-auto px-3.5 pb-3.5 pt-0.5 min-h-0">
            {!draft.length && (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-4">
                <Package size={26} className="text-line-2" />
                <span className="text-[13px] text-ink-3">Nothing on today&apos;s list yet</span>
                <span className="font-mono text-[10px]">ADD FROM SUGGESTIONS ON THE LEFT</span>
              </div>
            )}
            {PLAN_PRIORITY_ORDER.map(p => {
              const grp = draft.filter(t => effectivePriority(t) === p)
              if (!grp.length) return null
              return (
                <div key={p}>
                  <BucketHead p={p} count={grp.length} mins={grp.reduce((a, t) => a + activeOf(t), 0)} warn={warn === p} />
                  <div className="flex flex-col gap-1.5">
                    {grp.map(t => (
                      <DraftRow key={t.id} item={t} cooks={cooks} locked={locked}
                        dragging={drag === t.id} over={over === t.id}
                        onQty={handlers.onQty} onNote={handlers.onNote} onAssign={handlers.onAssign}
                        onPriorityChange={handlers.onPriorityChange} onRemove={handlers.onRemove} onOpen={handlers.onOpen}
                        onDragStart={() => setDrag(t.id)} onDragOver={onDragOverRow(t)} onDrop={onDropRow(t)}
                        onDragEnd={() => { setDrag(null); setOver(null) }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* footer / sign-off */}
          <div className="shrink-0 border-t border-line px-3.5 py-3 bg-paper">
            {locked ? (
              <div className="flex items-center gap-2 bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <Lock size={14} className="text-ink-3" />
                <span className="text-[12.5px] text-ink-2">Cooks claim, start and finish. Adding, removing and re-prioritising is the chef&apos;s.</span>
              </div>
            ) : clean ? (
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-2 bg-green-soft text-green-text rounded-[10px] px-3 py-2.5 text-[12.5px] font-semibold">
                  <Check size={14} className="text-green" /> Live on To Do
                </span>
                <span className="font-mono text-[10px] text-ink-3">
                  POSTED {fmtClock(new Date(post!.postedAt).getHours() * 60 + new Date(post!.postedAt).getMinutes())} BY {post!.postedByName.toUpperCase()} · {post!.itemCount} ITEMS · {fmtMins(post!.activeMinutes).toUpperCase()}
                </span>
                <span className="flex-1" />
                <button type="button" onClick={handlers.onRecall} className={btnCls(false)}>
                  <Undo2 size={13} className="text-ink-3" /> Recall to draft
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-[12.5px] font-medium text-ink-2">{post ? 'The kitchen is still on the last posted version' : 'Cooks see nothing until you post'}</div>
                  <div className="font-mono text-[9.5px] text-ink-4 mt-0.5">
                    {draft.length} ITEMS · {fmtMins(mins).toUpperCase()} HANDS-ON{openCount ? ` · ${openCount} UNASSIGNED` : ' · ALL ASSIGNED'}
                  </div>
                </div>
                <span className="flex-1" />
                <button type="button" onClick={() => setDlg(true)} disabled={!draft.length}
                  className={`inline-flex items-center gap-2 rounded-[11px] px-[18px] py-3 text-[13.5px] font-semibold ${draft.length ? 'bg-ink text-paper' : 'bg-bg-2 text-ink-4 cursor-not-allowed'}`}>
                  <Zap size={15} className={draft.length ? 'text-gold' : 'text-ink-4'} /> {post ? 'Update To Do' : 'Review & post to To Do'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {dlg && (
        <PostDialog draft={draft} cooks={cooks} stations={stations} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={() => { handlers.onPost(); setDlg(false) }} />
      )}
    </div>
  )
}
