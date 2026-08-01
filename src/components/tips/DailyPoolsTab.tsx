'use client'
import type { SplitResult } from '@/lib/tips/types'
import { money, money0 } from './kit'

export function DailyPoolsTab({
  split, sales, tips, dayLabels, overriddenDays, missingDays, salesMissingDays, basisLabel, onTips,
}: {
  split: SplitResult
  sales: number[]
  /** Customer tips per day; `null` where the app has no tip data for that day. */
  tips: Array<number | null>
  dayLabels: string[]
  overriddenDays: number[]
  /** Days with no usable BASIS figure — red-bordered, they pay nobody. */
  missingDays: number[]
  /**
   * Days the app has no SALES row for at all — distinct from a day that
   * genuinely took $0. `sales[d]` reads 0 either way (see foldDailyTotals),
   * so this is the only signal that tells the two apart when sales isn't the
   * active basis (where `missingDays` already covers it).
   */
  salesMissingDays: number[]
  basisLabel: string
  onTips: boolean
}) {
  const peak = split.pools.indexOf(Math.max(...split.pools))

  return (
    <div>
      <div className="grid grid-cols-7 gap-2.5 mb-2.5">
        {dayLabels.map((label, d) => {
          const missing = missingDays.includes(d)
          const overridden = overriddenDays.includes(d)
          const noSalesData = salesMissingDays.includes(d)
          return (
            <div
              key={d}
              className={`bg-paper border rounded-md px-[13px] py-3 flex flex-col gap-2 ${
                missing ? 'border-red' : d === peak ? 'border-gold shadow-[0_0_0_1px_var(--tw-shadow-color)] shadow-gold' : 'border-line'
              }`}
            >
              <span className="font-mono text-[10px] text-ink-3 tracking-[0.02em] uppercase flex justify-between">
                <span>{label}</span>
                <span className={missing ? 'text-red-text font-semibold' : d === peak ? 'text-gold-2 font-semibold' : ''}>
                  {missing ? 'NO DATA' : overridden ? 'FILE' : d === peak ? 'PEAK' : ''}
                </span>
              </span>
              <span className="text-[19px] font-semibold tracking-[-0.03em]">{money(split.pools[d])}</span>
              <span className="font-mono text-[10px] text-ink-3 leading-[1.5]">
                {/* The basis line is emphasised; the other figure is shown for
                    context so the two are always comparable on the same card.
                    Both sales and tips independently distinguish "no data" from
                    a genuine $0 — sales via its own missing-days list (its array
                    always reads 0 for a missing day), tips via `null`. */}
                <b className={onTips ? 'text-ink-4' : 'text-ink-2'}>{noSalesData ? '—' : money0(sales[d])}</b> sales
                {' · '}
                <b className={onTips ? 'text-ink-2' : 'text-ink-4'}>
                  {tips[d] == null ? '—' : money0(tips[d]!)}
                </b> tips<br />
                {split.crewByDay[d]} on shift · {split.weightedByDay[d].toFixed(1)} wh<br />
                <b className="text-ink-2">{split.weightedByDay[d] > 0 ? money(split.pools[d] / split.weightedByDay[d]) : '—'}</b> / weighted h
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-[18px] font-mono text-[10.5px] text-ink-3 flex justify-between">
        <span>Pool per day = {basisLabel} × pool rate · rate/h = day pool ÷ weighted hours on shift</span>
        <span>TOTAL POOL {money(split.poolTotal)}</span>
      </div>
    </div>
  )
}
