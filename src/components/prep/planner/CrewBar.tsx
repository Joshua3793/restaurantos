'use client'
// Smart Prep — "Who's on today": tick the cooks on shift. The plan then knows
// how many hands there are until close; with nobody ticked it says nothing
// about timing at all (no "won't fit" guesses).
import { useState } from 'react'
import { Check } from 'lucide-react'
import type { Cook } from '@/components/prep/runsheet/assignee'
import type { PlanDayContext } from '@/lib/prep-plan'
import { fmtClock } from '@/lib/prep-runsheet'
import { fmtDur } from '@/lib/prep-steps'
import { deadlineInWords, type CrewCapacity } from '@/lib/prep-smart'

const VISIBLE = 6

function Chip({ cook, on, locked, onToggle, compact }: { cook: Cook; on: boolean; locked: boolean; onToggle: () => void; compact?: boolean }) {
  return (
    <button type="button" disabled={locked} onClick={onToggle} aria-pressed={on}
      className={`inline-flex items-center gap-2 shrink-0 whitespace-nowrap ${compact ? 'min-h-[44px]' : 'min-h-[40px]'} pl-1.5 pr-3 rounded-full border text-[13px] font-medium ${on ? 'bg-ink border-ink text-paper' : 'bg-paper border-line text-ink-2'} ${locked ? 'cursor-default' : 'cursor-pointer'}`}>
      <span className={`w-7 h-7 rounded-full grid place-items-center font-mono text-[11px] font-semibold ${on ? 'bg-gold text-ink' : 'bg-bg-2 text-ink-2'}`}>{cook.initials}</span>
      {cook.name.split(' ')[0]}
    </button>
  )
}

export function capacityText(cap: CrewCapacity | null, ctx: PlanDayContext | null): { text: string; tone: 'ok' | 'bad' | 'none' } {
  if (!ctx) return { text: 'No service today — timing not checked', tone: 'none' }
  if (!cap) return { text: 'Tick who’s on to check timing', tone: 'none' }
  const head = `${fmtDur(cap.hands)} of hands until ${deadlineInWords(ctx.close, fmtClock)} · list needs ${fmtDur(cap.needs)}`
  return cap.fits
    ? { text: `${head} — fits`, tone: 'ok' }
    : { text: `${head} — ${fmtDur(cap.needs - cap.hands)} short`, tone: 'bad' }
}

export function CrewBar({ cooks, crewIds, onCrewChange, capacity, ctx, locked, compact = false }: {
  cooks: Cook[]
  crewIds: string[]
  onCrewChange: (ids: string[]) => void
  capacity: CrewCapacity | null
  ctx: PlanDayContext | null
  locked: boolean
  compact?: boolean
}) {
  const [all, setAll] = useState(false)
  const crew = new Set(crewIds)
  const toggle = (id: string) => onCrewChange(crew.has(id) ? crewIds.filter(x => x !== id) : [...crewIds, id])
  const ordered = [...cooks.filter(c => crew.has(c.id)), ...cooks.filter(c => !crew.has(c.id))]
  const shown = compact ? ordered.filter(c => crew.has(c.id)) : ordered.slice(0, Math.max(VISIBLE, crewIds.length))
  const rest = cooks.length - shown.length
  const cap = capacityText(capacity, ctx)
  const toneCls = cap.tone === 'ok' ? 'text-green-text' : cap.tone === 'bad' ? 'text-red-text' : 'text-ink-3'
  return (
    <div className="bg-paper border border-line rounded-[14px] px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-[13.5px] font-semibold text-ink shrink-0">{compact ? 'Today' : 'Who’s on today'}</span>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        {shown.map(c => <Chip key={c.id} cook={c} on={crew.has(c.id)} locked={locked} compact={compact} onToggle={() => toggle(c.id)} />)}
        {cooks.length > 0 && (rest > 0 || compact) && (
          <span className="relative">
            <button type="button" onClick={() => setAll(v => !v)} disabled={locked}
              className="inline-flex items-center min-h-[44px] px-3 rounded-full border border-dashed border-line-2 text-[13px] font-medium text-ink-2 whitespace-nowrap">
              {compact ? (crewIds.length ? 'Change' : '+ Who’s on') : `+ ${rest} more`}
            </button>
            {all && (
              <>
                <span className="fixed inset-0 z-40" onClick={() => setAll(false)} />
                <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-60 max-h-[320px] overflow-y-auto bg-paper border border-line-2 rounded-xl shadow-[0_14px_34px_-10px_rgba(9,9,11,0.28)] p-1.5">
                  {cooks.map(c => (
                    <button key={c.id} type="button" onClick={() => toggle(c.id)}
                      className="flex items-center gap-2 w-full min-h-[44px] text-left rounded-lg px-2.5 text-[13px] font-medium text-ink-2 hover:bg-bg-2">
                      <span className={`w-5 h-5 rounded grid place-items-center border ${crew.has(c.id) ? 'bg-ink border-ink' : 'border-line-2'}`}>
                        {crew.has(c.id) && <Check size={12} className="text-paper" strokeWidth={3} />}
                      </span>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </span>
        )}
        {cooks.length === 0 && <span className="text-[12.5px] text-ink-3">No cooks yet — add them in Setup.</span>}
      </div>
      <span className={`ml-auto text-[13px] font-medium ${toneCls}`}>{cap.text}</span>
    </div>
  )
}
