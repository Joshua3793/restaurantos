'use client'
// Prep run-sheet — mobile "next up" hero card.
// Ported from mobile.jsx's MHero. Dark full-width card leading the station
// queue: start-by countdown, name, make/hands-on/ready-for line, then either
// a gold Start-now button or a BLOCKED notice, plus a Recipe/scale-batch link.
import { AlertTriangle, Zap, BookOpen, ArrowRight, Hourglass } from 'lucide-react'
import { draftQty, fmtDeadline } from '@/lib/prep-plan'
import type { PrepItemRich } from '@/components/prep/types'
import { fmtClock, fmtStartBy, fmtMins, fmtQty, runState, minutesBetween } from '@/lib/prep-runsheet'
import { stageLabel } from '@/lib/prep-stages'

// A staged job resting in an unattended stage can sort first for a cook: the
// hero then leads with READY AT (not start-by), reads "ready" in green once the
// timer is out (red only past the grace), and its button moves the job to its
// next hands-on stage — it never advances on its own.
function RestHero({ item, nowMin, nowMs, onStage, onOpenRecipe }: {
  item: PrepItemRich
  nowMin: number
  nowMs: number
  onStage: (item: PrepItemRich, stageIndex: number) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const rest = item.rest!
  const entered = item.todayLog?.stageEnteredAt
  const elapsed = entered ? minutesBetween(new Date(entered).getTime(), nowMs) : 0
  const delta = rest.readyAtMin - nowMin
  const nextName = rest.next?.stage.name ?? 'Next stage'
  return (
    <div className="bg-ink text-paper rounded-2xl px-[17px] py-4 mt-3.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="font-mono text-[9.5px] text-[#a1a1aa] tracking-[0.06em]">NEXT UP · READY AT</span>
        {rest.state === 'overdue' ? (
          <span className="font-mono text-[9.5px] font-bold bg-red text-white px-2 py-0.5 rounded-full tracking-[0.03em]">{fmtMins(-delta)} PAST READY</span>
        ) : rest.state === 'ready' ? (
          <span className="font-mono text-[9.5px] font-bold bg-green text-white px-2 py-0.5 rounded-full tracking-[0.03em]">READY</span>
        ) : (
          <span className="font-mono text-[9.5px] text-[#a1a1aa]">in {fmtMins(delta)}</span>
        )}
      </div>
      <div className="flex items-end gap-3 mt-2">
        <span className={`font-mono text-[34px] font-semibold tracking-[-0.03em] leading-none ${
          rest.state === 'overdue' ? 'text-[#fca5a5]' : rest.state === 'ready' ? 'text-[#86efac]' : 'text-paper'
        }`}>
          {fmtStartBy(rest.readyAtMin)}
        </span>
        <span className="min-w-0 pb-px">
          <span className="block text-[17px] font-semibold tracking-[-0.02em] break-words">{nextName} · {item.name}</span>
        </span>
      </div>
      <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-[9px] leading-[1.5] flex items-center gap-1.5 flex-wrap">
        <Hourglass size={11} className="text-[#a1a1aa]" />
        {stageLabel(rest.index, rest.total, rest.stage)} · {rest.state === 'resting' ? `resting ${fmtMins(elapsed)} of ${fmtMins(rest.stage.minutes)}` : `rested ${fmtMins(elapsed)}`}
        {rest.stage.note ? ` · ${rest.stage.note}` : ''}
        {item.deadlineMinutes != null ? ` · by ${fmtDeadline(item.deadlineMinutes, fmtClock)}` : ''}
      </div>
      {rest.next && (
        <button
          onClick={() => onStage(item, rest.next!.index)}
          className={`flex items-center justify-center gap-2 w-full border-none rounded-[11px] py-[13px] mt-[13px] text-[15px] font-semibold tracking-[-0.01em] cursor-pointer ${
            rest.state === 'resting' ? 'bg-[#27272a] text-paper' : 'bg-gold text-ink'
          }`}
        >
          Next: {nextName} <ArrowRight size={15} />
        </button>
      )}
      <button
        onClick={() => onOpenRecipe(item)}
        className="flex items-center justify-center gap-[7px] w-full bg-transparent text-[#e4e4e7] border border-[#3f3f46] rounded-[11px] py-[11px] mt-2 text-[13px] font-medium tracking-[-0.01em] cursor-pointer"
      >
        <BookOpen size={14} className="text-gold" /> Recipe · stages
      </button>
    </div>
  )
}

export function NextUpHero({
  item,
  nowMin,
  nowMs,
  onStart,
  onStage,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMin: number
  nowMs?: number
  onStart: (item: PrepItemRich) => void
  onStage?: (item: PrepItemRich, stageIndex: number) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  if (item.rest && onStage) {
    return <RestHero item={item} nowMin={nowMin} nowMs={nowMs ?? Date.now()} onStage={onStage} onOpenRecipe={onOpenRecipe} />
  }
  const sb = item.startByMinutes
  const blocked = item.isBlocked || !!item.blockedReason
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const overdue = state === 'overdue'
  const late = sb != null ? nowMin - sb : 0
  const qty = draftQty(item) || (item.targetToday ?? item.parLevel)
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  return (
    <div className="bg-ink text-paper rounded-2xl px-[17px] py-4 mt-3.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="font-mono text-[9.5px] text-[#a1a1aa] tracking-[0.06em]">NEXT UP · START BY</span>
        {overdue ? (
          <span className="font-mono text-[9.5px] font-bold bg-red text-white px-2 py-0.5 rounded-full tracking-[0.03em]">
            {fmtMins(late)} LATE
          </span>
        ) : (
          <span className="font-mono text-[9.5px] text-[#a1a1aa]">{sb != null ? `in ${fmtMins(-late)}` : '—'}</span>
        )}
      </div>

      <div className="flex items-end gap-3 mt-2">
        <span
          className={`font-mono text-[34px] font-semibold tracking-[-0.03em] leading-none ${
            overdue ? 'text-[#fca5a5]' : 'text-paper'
          }`}
        >
          {sb != null ? fmtStartBy(sb) : '—'}
        </span>
        <span className="min-w-0 pb-px">
          <span className="block text-[17px] font-semibold tracking-[-0.02em] break-words">
            {item.name}
          </span>
        </span>
      </div>

      <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-[9px] leading-[1.5]">
        make <b className="text-gold font-semibold">{fmtQty(qty, item.unit)}</b> · {fmtMins(active)} hands-on
        {passive > 0 ? ` + ${fmtMins(passive)} ${item.passiveNote || 'rest'}` : ''}
        {item.service ? ` · ready for ${item.service.name} ${fmtClock(item.service.timeMinutes)}` : ''}
        {item.deadlineMinutes != null ? ` · by ${fmtDeadline(item.deadlineMinutes, fmtClock)}` : ''}
      </div>

      {/* Low-stock is advisory, not a blocker — surface the warning but still let the
          cook start (they may have uncounted stock, or be prepping toward a restock). */}
      {blocked && (
        <div className="flex items-center gap-2 bg-[#18181b] rounded-[10px] px-[13px] py-[11px] mt-3 font-mono text-[10.5px] text-gold">
          <AlertTriangle size={13} className="text-gold" /> {item.blockedReason ?? 'Low stock'}
        </div>
      )}
      <button
        onClick={() => onStart(item)}
        className="flex items-center justify-center gap-2 w-full bg-gold text-ink border-none rounded-[11px] py-[13px] mt-[13px] text-[15px] font-semibold tracking-[-0.01em] cursor-pointer"
      >
        <Zap size={15} className="text-ink" /> Start now
      </button>

      <button
        onClick={() => onOpenRecipe(item)}
        className="flex items-center justify-center gap-[7px] w-full bg-transparent text-[#e4e4e7] border border-[#3f3f46] rounded-[11px] py-[11px] mt-2 text-[13px] font-medium tracking-[-0.01em] cursor-pointer"
      >
        <BookOpen size={14} className="text-gold" /> Recipe · scale batch
      </button>
    </div>
  )
}
