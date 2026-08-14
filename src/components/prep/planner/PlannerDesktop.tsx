'use client'
// Smart Prep v2 — desktop split-view planner (design planner.jsx PPPlanner).
// ONE dial per item: the urgency step carries the deadline and the stock
// meaning. Suggestions on the left, the chef's prep list on the right with a
// station-load strip and schedule slots; nothing reaches a cook until posted.
import { useMemo, useState } from 'react'
import { Sparkles, ChefHat, Zap, Undo2, Lock, Users, AlertTriangle, Package, Check } from 'lucide-react'
import type { PrepItemRich, PrepPostInfo } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { RcService } from '@/lib/service-hours'
import {
  effectiveUrgency, planDayContext, planSchedule, stationLoad, planGroups, batchYield,
  draftListOrder as draftOrd,
  type PlanDayContext, type PlanSlot,
} from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'
import { GroupHead, Popover, popItemCls, popHeadCls } from './atoms'
import { SuggestionRow } from './SuggestionRow'
import { DraftRow } from './DraftRow'
import { PostDialog } from './PostDialog'

export type PlanGroupBy = 'urgency' | 'station'

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
  onAcceptSuggested: () => void
  onAddAllCritical: () => void
  onClearDraft: () => void
  onPost: () => void
  onRecall: () => void
}

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

/** Per-item batch display mode: chef's toggle wins, else batches by default
 *  whenever the linked recipe gives a usable base yield. */
export function isBatchMode(item: PrepItemRich, toggles: Map<string, boolean>): boolean {
  const t = toggles.get(item.id)
  if (t !== undefined) return t
  return batchYield(item) != null
}

// ─── station load strip ────────────────────────────────────────────────────
export function LoadStrip({ draft, cooks, ctx }: { draft: PrepItemRich[]; cooks: Cook[]; ctx: PlanDayContext | null }) {
  if (!ctx) return null
  const rows = stationLoad(draft, cooks, ctx)
  if (!rows.length) return null
  return (
    <div className="shrink-0 flex gap-2 px-3.5 py-2 bg-bg border-b border-line">
      {rows.map(r => {
        const over = r.pct > 100
        return (
          <div key={r.station} className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold text-ink-2 truncate">{r.station}</span>
              <span className={`ml-auto font-mono text-[9px] ${over ? 'text-red-text font-bold' : 'text-ink-4'}`}>{fmtMins(r.forService)}/{fmtMins(r.cap)}</span>
            </div>
            <div className="flex h-1 rounded-full overflow-hidden bg-bg-2 mt-1">
              <span className={over ? 'bg-red' : r.pct > 80 ? 'bg-gold' : 'bg-green'} style={{ width: `${Math.min(100, r.pct)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function PlannerDesktop({
  items, allItems, stations, cooks, services, nowMin, canPlan, post,
  search, onSearch, handlers, tasksSlot,
}: {
  items: PrepItemRich[]              // filtered (search/category) — shapes the LEFT pane
  allItems: PrepItemRich[]           // unfiltered — the draft pane must not hide rows on search
  stations: string[]
  cooks: Cook[]
  services: RcService[]
  nowMin: number
  canPlan: boolean
  post: PrepPostInfo | null
  search: string
  onSearch: (v: string) => void
  handlers: PlannerHandlers
  tasksSlot?: React.ReactNode
}) {
  const locked = !canPlan
  const [groupBy, setGroupBy] = useState<PlanGroupBy>('urgency')
  // The suggestions pane groups independently of the prep list — the chef can
  // read the pool by urgency step, by station, or by category (matches mobile).
  const [suggBy, setSuggBy] = useState<'urgency' | 'station' | 'category'>('urgency')
  const [dlg, setDlg] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [assignPop, setAssignPop] = useState(false)
  const [batchToggles, setBatchToggles] = useState<Map<string, boolean>>(new Map())
  const onToggleBatch = (item: PrepItemRich, next: boolean) =>
    setBatchToggles(prev => new Map(prev).set(item.id, next))

  const ctx = useMemo(() => planDayContext(services, nowMin), [services, nowMin])
  // No station filter chips — the View-by toggle (step/station/category) is
  // how the pool is sliced now.
  const pool = items
  const draft = useMemo(() => allItems.filter(i => i.isOnList), [allItems])
  const sched = useMemo<Map<string, PlanSlot>>(
    () => (ctx ? planSchedule(draft, cooks, ctx, draftOrd) : new Map()),
    [draft, cooks, ctx],
  )
  const wont = draft.filter(t => sched.get(t.id) && !sched.get(t.id)!.fits).length
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const openCount = draft.filter(t => !t.todayLog?.assignedTo).length
  const urgent = allItems.filter(t => effectiveUrgency(t) === 'PASS' && !t.isOnList).length
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
    `inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-[11px] py-[7px] text-[12px] font-semibold border ${disabled ? 'bg-bg-2 text-ink-4 border-line cursor-not-allowed' : 'bg-paper text-ink-2 border-line-2 hover:border-ink-3'}`

  const groupOpts = { stations, crew: cooks, ord: draftOrd }

  return (
    <div className="space-y-3.5">
      {tasksSlot}
      {/* 440px suggestions column only when there's desktop room — on iPad
          (md..xl) it would starve the prep-list pane, whose header controls
          get clipped by the pane's overflow-hidden. */}
      <div className="grid grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[440px_1fr] gap-3.5 items-stretch" style={{ height: 'calc(100vh - 230px)', minHeight: 560 }}>
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
          <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-line">
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-4">View by</span>
            <div className="flex items-center gap-0.5 bg-bg border border-line rounded-full p-0.5 shrink-0">
              {([['urgency', 'STEP'], ['station', 'STATION'], ['category', 'CATEGORY']] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setSuggBy(k)}
                  className={`font-mono text-[9px] font-bold uppercase tracking-[0.05em] rounded-full px-2.5 py-1 ${suggBy === k ? 'bg-ink text-paper' : 'text-ink-3'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="shrink-0 flex flex-wrap gap-1.5 px-3 py-2.5 bg-bg border-b border-line">
            <button type="button" onClick={handlers.onAddAllCritical} disabled={locked || !urgent} className={btnCls(locked || !urgent)}>
              <AlertTriangle size={13} className={locked || !urgent ? 'text-ink-4' : 'text-ink-3'} /> Add all critical{urgent ? ` · ${urgent}` : ''}
            </button>
            <button type="button" onClick={handlers.onAcceptSuggested} disabled={locked} className={btnCls(locked)}>
              <Sparkles size={13} className={locked ? 'text-ink-4' : 'text-ink-3'} /> Accept suggested qty
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3.5 pt-0.5 min-h-0">
            {planGroups(pool, suggBy, groupOpts).map(g => (
              <div key={g.key}>
                <GroupHead g={g} count={g.rows.length} />
                <div className="flex flex-col gap-1.5">
                  {g.rows.map(t => (
                    <SuggestionRow key={t.id} item={t} locked={locked}
                      onOpen={handlers.onOpen} onAdd={handlers.onAdd} onRemove={handlers.onRemove} />
                  ))}
                </div>
              </div>
            ))}
            {pool.length === 0 && (
              <div className="py-14 text-center font-mono text-[10.5px] text-ink-4">NO ITEMS MATCH</div>
            )}
          </div>
        </div>

        {/* ── prep list ── */}
        <div className={`${paneCls} ${clean ? '' : '!border-ink'}`}>
          <div className={`shrink-0 flex flex-wrap items-center gap-2 px-3.5 pt-3 pb-2.5 border-b border-line ${clean ? 'bg-paper' : 'bg-bg'}`}>
            <span className="w-6 h-6 rounded-[7px] bg-ink grid place-items-center shrink-0"><ChefHat size={13} className="text-gold" /></span>
            {/* min width so the wrapping header sends the controls to the next
                row instead of stacking this meta line one word per line */}
            <div className="flex-1 min-w-[180px]">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold tracking-[-0.015em] text-ink">Prep list</span>
                <span className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] px-[7px] py-0.5 rounded-full ${clean ? 'bg-green-soft text-green-text' : 'bg-ink text-paper'}`}>
                  {post ? (post.dirty ? 'UNPOSTED CHANGES' : 'POSTED') : 'DRAFT'}
                </span>
              </div>
              <div className="font-mono text-[9px] text-ink-4">
                {draft.length} ITEMS · {fmtMins(mins).toUpperCase()} HANDS-ON · {openCount} UNASSIGNED{wont ? <span className="text-red-text font-bold">{` · ${wont} WON'T FIT`}</span> : ''}
              </div>
            </div>
            <div className="flex items-center gap-1 bg-bg border border-line rounded-full p-0.5 shrink-0">
              {([['urgency', 'STEP'], ['station', 'STATION']] as const).map(([k, l]) => (
                <button key={k} type="button" onClick={() => setGroupBy(k)}
                  className={`font-mono text-[9.5px] font-bold uppercase tracking-[0.05em] rounded-full px-2.5 py-1 ${groupBy === k ? 'bg-ink text-paper' : 'text-ink-3'}`}>
                  {l}
                </button>
              ))}
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

          <LoadStrip draft={draft} cooks={cooks} ctx={ctx} />

          <div className="flex-1 overflow-y-auto px-3.5 pb-3.5 pt-0.5 min-h-0">
            {!draft.length && (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-4">
                <Package size={26} className="text-line-2" />
                <span className="text-[13px] text-ink-3">Nothing on today&apos;s list yet</span>
                <span className="font-mono text-[10px]">ADD FROM SUGGESTIONS ON THE LEFT</span>
              </div>
            )}
            {planGroups(draft, groupBy, groupOpts).map(g => (
              <div key={g.key}>
                <GroupHead g={g} count={g.rows.length} mins={g.rows.reduce((a, t) => a + activeOf(t), 0)} warn={warn === g.key} />
                <div className="flex flex-col gap-1.5">
                  {g.rows.map(t => (
                    <DraftRow key={t.id} item={t} cooks={cooks} locked={locked}
                      ctx={ctx} slot={sched.get(t.id) ?? null} batchMode={isBatchMode(t, batchToggles)}
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
          <div className="shrink-0 border-t border-line px-3.5 py-3 bg-paper">
            {locked ? (
              <div className="flex items-center gap-2 bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <Lock size={14} className="text-ink-3" />
                <span className="text-[12.5px] text-ink-2">Cooks claim, start and finish. Adding, removing and moving steps is the chef&apos;s.</span>
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
        <PostDialog draft={draft} cooks={cooks} stations={stations} ctx={ctx} reposting={!!post}
          onClose={() => setDlg(false)} onConfirm={() => { handlers.onPost(); setDlg(false) }} />
      )}
    </div>
  )
}
