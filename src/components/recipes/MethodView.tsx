'use client'
// Read-only rendering of a recipe's Method (with waits): numbered prose grouped
// under its phase labels, each wait as a muted hourglass line after the step
// it follows. Used by the print view and the read-only recipe card; the
// cook-along has its own tickable rendering.
import { Hourglass } from 'lucide-react'
import type { MethodStep } from '@/lib/recipe-method'
import { fmtMins } from '@/lib/prep-runsheet'

export function MethodView({ method, compact = false }: { method: MethodStep[]; compact?: boolean }) {
  let phase: string | undefined
  return (
    <ol className={`m-0 p-0 list-none flex flex-col ${compact ? 'gap-1.5' : 'gap-2.5'}`}>
      {method.map((s, i) => {
        const newPhase = s.phase && s.phase !== phase ? s.phase : null
        if (s.phase) phase = s.phase
        return (
          <li key={s.key}>
            {newPhase && (
              <div className={`font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 ${i === 0 ? '' : 'mt-2'} mb-1`}>{newPhase}</div>
            )}
            <div className="flex gap-2.5 items-start">
              <span className="font-mono text-[11px] font-semibold text-gold-2 bg-gold-soft w-[22px] h-[22px] rounded-[7px] grid place-items-center shrink-0">{i + 1}</span>
              <span className={`flex-1 min-w-0 ${compact ? 'text-[13px]' : 'text-sm'} text-ink-2 leading-relaxed whitespace-pre-wrap`}>
                {s.text}
                {s.minutes ? <span className="font-mono text-[10.5px] text-ink-4 ml-2 whitespace-nowrap">{fmtMins(s.minutes)} hands-on</span> : null}
              </span>
            </div>
            {s.wait && (
              <div className="flex items-center gap-1.5 ml-[32px] mt-1 font-mono text-[10.5px] text-blue-text italic">
                <Hourglass size={11} /> wait {fmtMins(s.wait.minutes)}{s.wait.note ? ` · ${s.wait.note}` : ''}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
