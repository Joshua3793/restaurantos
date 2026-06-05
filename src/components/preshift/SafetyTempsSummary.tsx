'use client'
import { Thermometer, ArrowRight } from 'lucide-react'

// Read-only mirror of the Temps page for pre-shift. Shows today's temp-unit
// rollup and deep-links to /temps to log. `blocking` = not every unit logged
// or something out of range.
export function SafetyTempsSummary({
  logged, total, flagged, blocking, onLogTemps,
}: {
  logged: number
  total: number
  flagged: number
  blocking: boolean
  onLogTemps: () => void
}) {
  return (
    <div
      className="flex items-center gap-3 px-[18px] py-[13px] border-b border-line"
      style={blocking ? { boxShadow: 'inset 3px 0 0 #dc2626' } : undefined}
    >
      <span className={`w-[22px] h-[22px] rounded-[6px] grid place-items-center shrink-0 ${
        total > 0 && logged === total && flagged === 0 ? 'bg-green text-white' : 'bg-blue-soft text-blue-text'
      }`}>
        <Thermometer size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium tracking-[-0.01em] text-ink">Temperatures</div>
        <div className="font-mono text-[10.5px] mt-[3px] tracking-[0]">
          <span className={flagged > 0 ? 'text-red-text font-semibold' : 'text-ink-3'}>
            {logged}/{total} logged{flagged > 0 ? ` · ${flagged} out of range` : ''}
          </span>
        </div>
      </div>
      <button
        onClick={onLogTemps}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-gold-2 bg-bg-2 border border-line rounded-full px-3 py-1.5 hover:border-ink-3 transition-colors shrink-0"
      >
        Log temps <ArrowRight size={12} />
      </button>
    </div>
  )
}
