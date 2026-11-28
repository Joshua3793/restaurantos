'use client'
// Smart Prep — review before posting. Says exactly what changes for the cooks
// (added / taken off since the last post, unchanged, jobs on the go), then the
// checks worth a look: timing with today's crew, jobs with no cook, wrong pars.
import { Check } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import type { Cook } from '@/components/prep/runsheet/assignee'
import {
  effectiveUrgency, urgencyDeadline, fmtDeadline, draftQty, batchYield, batchCount,
  draftListOrder as draftOrd,
  type PlanDayContext,
} from '@/lib/prep-plan'
import { fmtClock } from '@/lib/prep-runsheet'
import { fmtAmount } from '@/lib/prep-amount'
import { planChanges, crewCapacity, crewSchedule, parFlag, deadlineInWords } from '@/lib/prep-smart'
import { capacityText } from './CrewBar'
import { batchWords } from './PrepRow'
import { useBackDismiss } from '@/lib/back-stack'

/** What the post stamps on each item's live log: the step deadline the chef saw. */
export interface PostDue { prepItemId: string; dueTime: string | null }

const STEP_WORD = { PASS: 'Critical', MID: 'Mid-service', CLOSE: 'Before close', TMRW: 'Tomorrow' } as const

function amount(t: PrepItemRich): string {
  const q = draftQty(t)
  const nb = batchYield(t) != null ? batchCount(t, q) : null
  return nb != null && nb > 0 ? `${batchWords(nb)} · ${fmtAmount(q, t.unit)}` : fmtAmount(q, t.unit)
}

function Change({ sign, tone, name, sub, tag }: { sign: string; tone: string; name: string; sub: string; tag?: { text: string; cls: string } }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 py-2.5 border-t border-line">
      <span className={`font-mono text-[15px] font-bold text-center ${tone}`}>{sign}</span>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-ink break-words">{name}</div>
        <div className="text-[12.5px] text-ink-3 mt-0.5">{sub}</div>
      </div>
      {tag ? <span className={`text-[12px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${tag.cls}`}>{tag.text}</span> : <span />}
    </div>
  )
}

export function PostDialog({ all, onList, cooks, crewIds, ctx, nowMin, reposting, onClose, onConfirm }: {
  all: PrepItemRich[]
  onList: PrepItemRich[]
  cooks: Cook[]
  crewIds: string[]
  ctx: PlanDayContext | null
  nowMin: number
  reposting: boolean
  onClose: () => void
  onConfirm: (dues: PostDue[]) => void
}) {
  useBackDismiss(true, onClose)
  // The deadline label per row goes to the kitchen as PrepLog.dueTime so the To
  // Do can show what was posted even if the live step moves later.
  const dues: PostDue[] = onList.map(t => ({
    prepItemId: t.id,
    dueTime: ctx ? fmtDeadline(urgencyDeadline(effectiveUrgency(t), ctx), fmtClock) : null,
  }))
  const ch = planChanges(all)
  const changeCount = ch.added.length + ch.removed.length
  const cookName = (id: string | null | undefined) => (id ? cooks.find(c => c.id === id)?.name.split(' ')[0] ?? 'a cook' : 'open')
  const when = (t: PrepItemRich) => {
    const step = STEP_WORD[effectiveUrgency(t)]
    if (!ctx) return step
    const dl = urgencyDeadline(effectiveUrgency(t), ctx)
    return dl <= nowMin ? `${step}, now` : `${step}, ${deadlineInWords(dl, fmtClock)}`
  }
  const unchangedNames = onList.filter(t => !t.pipeline && t.todayLog?.postedAt).map(t => t.name)

  const cap = crewCapacity(onList, crewIds.length, ctx)
  const capText = capacityText(cap, ctx)
  const sched = crewSchedule(onList, crewIds.length, ctx, nowMin, draftOrd)
  const wont = onList.filter(t => sched.get(t.id) && !sched.get(t.id)!.fits)
  const open = onList.filter(t => !t.pipeline && !t.todayLog?.assignedTo).length
  const wrong = all.filter(t => t.prepEnabled !== false && !t.pipeline && !t.isOnList && parFlag(t) === 'WRONG')
  const wrongListed = onList.filter(t => !t.pipeline && parFlag(t) === 'WRONG')

  const label = !reposting
    ? `Post ${onList.length} ${onList.length === 1 ? 'item' : 'items'}`
    : changeCount > 0 ? `Post ${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : 'Update To Do'

  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center sm:p-3">
      <div onClick={onClose} className="absolute inset-0 bg-[rgba(9,9,11,0.45)]" />
      <div role="dialog" aria-label="Review before posting"
        className="relative w-full sm:max-w-[480px] max-h-[92vh] flex flex-col bg-paper rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <div className="text-[19px] font-semibold tracking-[-0.025em] text-ink">Post to the To Do</div>
          <div className="text-[13.5px] text-ink-3 mt-0.5">Cooks see these changes right away.</div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pt-3 pb-2 flex flex-col gap-4">
          <section>
            <div className="text-[12px] font-semibold text-ink-3 mb-0.5">What changes · {changeCount}</div>
            {ch.added.map(t => (
              <Change key={t.id} sign="+" tone="text-green-text" name={t.name}
                sub={`${amount(t)} · ${when(t)} · ${cookName(t.todayLog?.assignedTo)}`}
                tag={{ text: 'Added', cls: 'bg-green-soft text-green-text' }} />
            ))}
            {ch.removed.map(t => (
              <Change key={t.id} sign="−" tone="text-red-text" name={t.name} sub="comes off the cooks' To Do"
                tag={{ text: 'Taken off', cls: 'bg-red-soft text-red-text' }} />
            ))}
            {changeCount === 0 && (
              <Change sign="·" tone="text-ink-3" name={reposting ? 'Nothing added or taken off' : 'A new list'}
                sub={reposting ? 'Steps, order or cooks changed' : `${onList.length} items go live`} />
            )}
            {reposting && unchangedNames.length > 0 && (
              <Change sign="=" tone="text-ink-3" name={`${unchangedNames.length} unchanged`}
                sub={unchangedNames.slice(0, 3).join(', ') + (unchangedNames.length > 3 ? '…' : '')} />
            )}
            {ch.cooking.length > 0 && (
              <Change sign="●" tone="text-gold-2" name={`${ch.cooking.length} ${ch.cooking.length === 1 ? 'job' : 'jobs'} on the go`}
                sub="stay exactly as the cooks left them" />
            )}
          </section>

          <section className="flex flex-col gap-2">
            <div className="text-[12px] font-semibold text-ink-3">Before you post</div>
            {/* Enough hands overall but some jobs late is NOT green: say both. */}
            <div className={`rounded-[10px] px-3 py-2.5 text-[13px] leading-snug ${capText.tone === 'bad' ? 'bg-red-soft text-red-text' : capText.tone === 'ok' && wont.length ? 'bg-gold-soft text-gold-2' : capText.tone === 'ok' ? 'bg-green-soft text-green-text' : 'bg-bg-2 text-ink-2'}`}>
              {cap
                ? <><b>{!cap.fits ? 'Short of hands' : wont.length ? 'Enough hands overall' : 'Fits'}</b> with {crewIds.length} {crewIds.length === 1 ? 'cook' : 'cooks'} — {capText.text}</>
                : capText.text}
              {wont.length > 0 && <div className="mt-1"><b>{wont.length}</b> {wont.length === 1 ? 'job won’t' : 'jobs won’t'} be ready in time: {wont.map(t => t.name).join(', ')}</div>}
            </div>
            {open > 0 && (
              <div className="rounded-[10px] px-3 py-2.5 text-[13px] leading-snug bg-gold-soft text-gold-2">
                <b>{open} {open === 1 ? 'job has' : 'jobs have'} no cook</b> — anyone can claim them from the To Do.
              </div>
            )}
            {wrong.length > 0 && (
              <div className="rounded-[10px] px-3 py-2.5 text-[13px] leading-snug bg-red-soft text-red-text">
                <b>{wrong.length} {wrong.length === 1 ? 'par looks' : 'pars look'} wrong</b> ({wrong.map(t => t.name).join(', ')}) — {wrong.length === 1 ? 'it stays' : 'they stay'} off the list until fixed.
              </div>
            )}
            {wrongListed.length > 0 && (
              <div className="rounded-[10px] px-3 py-2.5 text-[13px] leading-snug bg-red-soft text-red-text">
                <b>{wrongListed.map(t => t.name).join(', ')}</b> {wrongListed.length === 1 ? 'is' : 'are'} on your list with a par that looks wrong — check the amount before posting.
              </div>
            )}
            <div className="text-[12.5px] text-ink-3">Quantity and note changes already show on the To Do.</div>
          </section>
        </div>

        {/* Bottom padding clears the phone's home bar (0 on desktop). */}
        <div className="shrink-0 flex flex-col sm:flex-row-reverse gap-2 px-5 py-4 border-t border-line" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
          <button type="button" onClick={() => onConfirm(dues)}
            className="inline-flex items-center justify-center gap-2 bg-ink text-paper rounded-[11px] px-[18px] min-h-[48px] text-[14.5px] font-semibold">
            <Check size={15} className="text-gold" /> {label}
          </button>
          <button type="button" onClick={onClose}
            className="inline-flex items-center justify-center rounded-[11px] border border-line-2 bg-paper text-ink-2 min-h-[48px] px-4 text-[14px] font-semibold">
            Keep editing
          </button>
        </div>
      </div>
    </div>
  )
}
