import { ShiftSummary, PrepCountdown } from '@/lib/prep-utils'
import { IcClock } from '@/components/prep/icons'

interface PrepShiftBandProps {
  summary: ShiftSummary
  countdown: PrepCountdown | null
  workloadLabel: string
}

const CHIP_BASE =
  'inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 bg-bg border border-line px-2.5 py-[5px] rounded-full shrink-0 whitespace-nowrap'

function CriticalChip({ count }: { count: number }) {
  return (
    <span className={`${CHIP_BASE} bg-red-soft border-[#fca5a5] text-red-text`}>
      <span className="font-mono font-semibold">{count}</span> critical
    </span>
  )
}

function BlockedChip({ count }: { count: number }) {
  return (
    <span className={`${CHIP_BASE} bg-gold-soft border-[#fcd34d] text-gold-2`}>
      <span className="font-mono font-semibold">{count}</span> blocked on stock
    </span>
  )
}

function StartByChip({ countdown }: { countdown: PrepCountdown }) {
  const urgent = countdown.minsToService < 45
  const colors = urgent
    ? 'bg-red-soft border-[#fca5a5] text-red-text'
    : 'bg-gold-soft border-[#fcd34d] text-gold-2'
  return (
    <span className={`${CHIP_BASE} ${colors}`}>
      <IcClock className="w-3 h-3" /> start by{' '}
      <b className="font-semibold">{countdown.startByHHMM}</b>
    </span>
  )
}

function OnParChip({ count }: { count: number }) {
  return (
    <span className={CHIP_BASE}>
      <span className="w-[7px] h-[7px] rounded-full bg-green" />
      <span className="font-mono font-semibold">{count}</span> on par
    </span>
  )
}

export default function PrepShiftBand({ summary, countdown, workloadLabel }: PrepShiftBandProps) {
  const donePct = summary.total ? (summary.done / summary.total) * 100 : 0
  const progPct = summary.total ? (summary.inProgress / summary.total) * 100 : 0

  return (
    <div className="bg-paper border border-line rounded-[13px] mb-3 sm:mb-[18px] flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2 sm:gap-[22px] px-3.5 sm:px-5 py-2.5 sm:py-[13px]">
      <div className="flex flex-col gap-[3px] shrink-0">
        <div className="text-[20px] sm:text-[25px] font-semibold tracking-[-0.04em] leading-none">
          {summary.done}
          <em className="not-italic text-ink-4 font-medium"> / {summary.total}</em>
        </div>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">
          Tasks done
        </div>
      </div>

      <div className="basis-full sm:basis-auto flex-1 flex flex-col gap-[9px] min-w-0">
        <div className="h-2 min-h-[8px] rounded-full bg-bg-2 overflow-hidden flex">
          <div className="bg-green" style={{ width: `${donePct}%` }} />
          <div className="bg-gold" style={{ width: `${progPct}%` }} />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 flex-nowrap sm:flex-wrap overflow-x-auto sm:overflow-visible -mx-0.5 px-0.5 [&::-webkit-scrollbar]:hidden">
          {summary.critical > 0 && <CriticalChip count={summary.critical} />}
          {summary.blocked > 0 && <BlockedChip count={summary.blocked} />}
          {countdown && <StartByChip countdown={countdown} />}
          <span className={CHIP_BASE}>
            <span className="font-mono font-semibold">{workloadLabel}</span> left
          </span>
          <OnParChip count={summary.onPar} />
        </div>
      </div>
    </div>
  )
}
