// Prep run-sheet — the pulsing "NOW · HH:MM" divider line.
// Ported from shared.jsx's PTNowLine. No custom pulse keyframe exists in this
// repo, so the red dot uses Tailwind's built-in `animate-pulse`.
import { fmtClock } from '@/lib/prep-runsheet'

export function NowLine({ nowMin }: { nowMin: number }) {
  return (
    <div className="flex items-center gap-[9px] my-1">
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold text-red tracking-[0.04em] whitespace-nowrap">
        <span className="w-2 h-2 rounded-full bg-red animate-pulse" />
        NOW · {fmtClock(nowMin)}
      </span>
      <span className="flex-1 h-[1.5px] bg-gradient-to-r from-red to-red/10" />
    </div>
  )
}
