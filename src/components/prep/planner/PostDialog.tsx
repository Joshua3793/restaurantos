'use client'
// Smart Prep v2 — post confirmation dialog (design PPPostDialog). Shows what
// goes live on the kitchen's To Do before the chef commits.
import { Zap, Check, AlertTriangle } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { PrepPriority } from '@/lib/prep-utils'
import { PLAN_PRIO_META, PLAN_PRIORITY_ORDER, effectivePriority } from '@/lib/prep-plan'
import { fmtClock, fmtMins } from '@/lib/prep-runsheet'

const activeOf = (i: PrepItemRich) => i.activeMinutes ?? i.estimatedPrepTime ?? 0

export function PostDialog({ draft, cooks, stations, reposting, onClose, onConfirm }: {
  draft: PrepItemRich[]
  cooks: Cook[]
  stations: string[]
  reposting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const byPrio = PLAN_PRIORITY_ORDER
    .map(p => [p, draft.filter(t => effectivePriority(t) === p).length] as [PrepPriority, number])
    .filter(([, n]) => n > 0)
  const stationKeys = [...stations, 'Unassigned']
  const byStation = stationKeys
    .map(s => [s, draft.filter(t => (t.station || 'Unassigned') === s)] as [string, PrepItemRich[]])
    .filter(([, rows]) => rows.length > 0)
  const open = draft.filter(t => !t.todayLog?.assignedTo).length
  const mins = draft.reduce((a, t) => a + activeOf(t), 0)
  const first = draft.filter(t => t.startByMinutes != null).sort((a, b) => a.startByMinutes! - b.startByMinutes!)[0]

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-3">
      <div onClick={onClose} className="absolute inset-0 bg-[rgba(9,9,11,0.45)]" />
      <div className="relative w-full max-w-[456px] max-h-[92vh] flex flex-col bg-paper rounded-2xl shadow-2xl overflow-hidden">
        {/* header */}
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-3.5 border-b border-line">
          <span className="w-[30px] h-[30px] rounded-[9px] bg-ink grid place-items-center shrink-0"><Zap size={15} className="text-gold" /></span>
          <div>
            <div className="text-[16.5px] font-semibold tracking-[-0.02em] text-ink">{reposting ? 'Update the To Do list' : 'Post today’s prep list'}</div>
            <div className="font-mono text-[9.5px] font-medium uppercase tracking-[0.05em] text-ink-3">{reposting ? 'Replaces what the kitchen sees now' : 'Goes live on every cook’s To Do'}</div>
          </div>
        </div>
        {/* body */}
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-1">
          <div className="flex gap-2">
            {([['Items', String(draft.length)], ['Hands-on', fmtMins(mins)], ['First start', first?.startByMinutes != null ? fmtClock(first.startByMinutes) : '—']] as const).map(([l, v]) => (
              <div key={l} className="flex-1 bg-bg border border-line rounded-[11px] px-3 py-2.5">
                <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em] text-ink-3 mb-1">{l}</div>
                <div className="text-[20px] font-semibold tracking-[-0.03em] font-mono text-ink">{v}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-3">
            {byPrio.map(([p, n]) => (
              <span key={p} className={`inline-flex items-center gap-1.5 ${PLAN_PRIO_META[p].softClass} ${PLAN_PRIO_META[p].textClass} rounded-full px-2.5 py-1 font-mono text-[10px] font-bold`}>
                <span className={`w-[5px] h-[5px] rounded-full ${PLAN_PRIO_META[p].dotClass}`} />{n} {PLAN_PRIO_META[p].label.toUpperCase()}
              </span>
            ))}
          </div>
          <div className="mt-3.5 border-t border-line pt-3">
            {byStation.map(([s, rows]) => (
              <div key={s} className="flex items-center gap-2 py-1.5">
                <span className="text-[12.5px] font-medium text-ink-2 w-[92px] truncate">{s}</span>
                <span className="font-mono text-[10.5px] text-ink-3 w-[58px]">{rows.length} item{rows.length !== 1 ? 's' : ''}</span>
                <span className="font-mono text-[10.5px] text-ink-3 w-[52px]">{fmtMins(rows.reduce((a, r) => a + activeOf(r), 0))}</span>
                <span className="flex gap-1 ml-auto">
                  {[...new Set(rows.map(r => r.todayLog?.assignedTo ?? null))].map(id => {
                    const c = id ? cooks.find(x => x.id === id) : null
                    return (
                      <span key={id ?? 'open'} className={`font-mono text-[9px] font-bold rounded-full px-2 py-0.5 ${c ? 'bg-ink text-paper' : 'bg-paper text-ink-4 border border-dashed border-line-2'}`}>
                        {c ? c.initials : 'OPEN'}
                      </span>
                    )
                  })}
                </span>
              </div>
            ))}
          </div>
          {open > 0 && (
            <div className="flex items-center gap-2 bg-gold-soft border border-gold-soft rounded-[10px] px-3 py-2 mt-3">
              <AlertTriangle size={14} className="text-gold-2 shrink-0" />
              <span className="text-[12px] text-gold-2 font-medium"><b>{open}</b> item{open > 1 ? 's' : ''} unassigned — cooks can claim them from the run sheet.</span>
            </div>
          )}
        </div>
        {/* footer */}
        <div className="shrink-0 flex items-center gap-2 px-5 py-4">
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-[9px] border border-line-2 bg-paper text-ink-2 text-[12.5px] font-semibold">Keep editing</button>
          <button type="button" onClick={onConfirm} className="inline-flex items-center gap-2 bg-ink text-paper rounded-[10px] px-[18px] py-[11px] text-[13.5px] font-semibold">
            <Check size={14} className="text-gold" /> {reposting ? 'Update To Do' : `Post ${draft.length} item${draft.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
