'use client'
// Prep run-sheet — mobile "next up" hero card.
// Ported from mobile.jsx's MHero. Dark full-width card leading the station
// queue: start-by countdown, name, make/hands-on/ready-for line, then either
// a gold Start-now button or a BLOCKED notice, plus a Recipe/scale-batch link.
import { Lock, Zap, BookOpen } from 'lucide-react'
import type { PrepItemRich } from '@/components/prep/types'
import { fmtClock, fmtDuration, runState } from '@/lib/prep-runsheet'

// Local port of the prototype's `ptFmtQ` — same rule as RunRowMobile.tsx /
// RunRow.tsx / InProgressRail.tsx.
function fmtQty(q: number, u: string): string {
  const v = (u === 'kg' || u === 'L') && q % 1 !== 0 ? q.toFixed(1) : Math.round(q)
  return `${v} ${u}`
}

export function NextUpHero({
  item,
  nowMin,
  onStart,
  onOpenRecipe,
}: {
  item: PrepItemRich
  nowMin: number
  onStart: (item: PrepItemRich) => void
  onOpenRecipe: (item: PrepItemRich) => void
}) {
  const sb = item.startByMinutes
  const blocked = item.isBlocked || !!item.blockedReason
  const state = runState({ startBy: sb, blockedReason: item.blockedReason }, nowMin)
  const overdue = state === 'overdue'
  const late = sb != null ? nowMin - sb : 0
  const qty = item.suggestedQty ?? item.targetToday ?? item.parLevel
  const active = item.activeMinutes ?? 0
  const passive = item.passiveMinutes ?? 0

  return (
    <div className="bg-ink text-paper rounded-2xl px-[17px] py-4 mt-3.5">
      <div className="flex items-baseline justify-between gap-2.5">
        <span className="font-mono text-[9.5px] text-[#a1a1aa] tracking-[0.06em]">NEXT UP · START BY</span>
        {overdue ? (
          <span className="font-mono text-[9.5px] font-bold bg-red text-white px-2 py-0.5 rounded-full tracking-[0.03em]">
            {fmtDuration(late)} LATE
          </span>
        ) : (
          <span className="font-mono text-[9.5px] text-[#a1a1aa]">{sb != null ? `in ${fmtDuration(-late)}` : '—'}</span>
        )}
      </div>

      <div className="flex items-end gap-3 mt-2">
        <span
          className={`font-mono text-[34px] font-semibold tracking-[-0.03em] leading-none ${
            overdue ? 'text-[#fca5a5]' : 'text-paper'
          }`}
        >
          {sb != null ? fmtClock(sb) : '—'}
        </span>
        <span className="min-w-0 pb-px">
          <span className="block text-[17px] font-semibold tracking-[-0.02em] whitespace-nowrap overflow-hidden text-ellipsis">
            {item.name}
          </span>
        </span>
      </div>

      <div className="font-mono text-[10.5px] text-[#a1a1aa] mt-[9px] leading-[1.5]">
        make <b className="text-gold font-semibold">{fmtQty(qty, item.unit)}</b> · {fmtDuration(active)} hands-on
        {passive > 0 ? ` + ${fmtDuration(passive)} ${item.passiveNote || 'rest'}` : ''}
        {item.service ? ` · ready for ${item.service.name} ${fmtClock(item.service.timeMinutes)}` : ''}
      </div>

      {blocked ? (
        <div className="flex items-center gap-2 bg-[#18181b] rounded-[10px] px-[13px] py-[11px] mt-3 font-mono text-[10.5px] text-gold">
          <Lock size={13} className="text-gold" /> BLOCKED · {item.blockedReason ?? 'stock'}
        </div>
      ) : (
        <button
          onClick={() => onStart(item)}
          className="flex items-center justify-center gap-2 w-full bg-gold text-ink border-none rounded-[11px] py-[13px] mt-[13px] text-[15px] font-semibold tracking-[-0.01em] cursor-pointer"
        >
          <Zap size={15} className="text-ink" /> Start now
        </button>
      )}

      <button
        onClick={() => onOpenRecipe(item)}
        className="flex items-center justify-center gap-[7px] w-full bg-transparent text-[#e4e4e7] border border-[#3f3f46] rounded-[11px] py-[11px] mt-2 text-[13px] font-medium tracking-[-0.01em] cursor-pointer"
      >
        <BookOpen size={14} className="text-gold" /> Recipe · scale batch
      </button>
    </div>
  )
}
