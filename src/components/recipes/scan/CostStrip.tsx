'use client'
// Recipe Scan — where the scan stands (design: CostSummary). How many lines
// are costed, a strip of matched / check / no match, the batch cost "so far"
// (every line priced live from its item — nothing stored) per yield unit, and
// the method's time. Collapses to one quiet line once everything is costed.
import type { CostSummary, TimeSummary } from '@/lib/recipe-scan/review'
import { formatMinutes } from '@/lib/recipe-scan/review'

interface Props {
  cost: CostSummary
  time: TimeSummary
  yieldUnit: string | null
  /** Scrolls to the first line that needs the chef; null when none does. */
  onNextToFix: (() => void) | null
}

const money = (n: number) => `$${n.toFixed(2)}`
const pct = (n: number, of: number) => `${of > 0 ? (n / of) * 100 : 0}%`

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-[7px] h-[7px] rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

export function CostStrip({ cost, time, yieldUnit, onNextToFix }: Props) {
  if (cost.total > 0 && cost.complete) {
    return (
      <div className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 px-1">
        <span className="text-green-text font-semibold">All costed</span> · {cost.total} lines · {money(cost.batch)} batch
        {cost.perYield !== null && yieldUnit && <> · {money(cost.perYield)} per {yieldUnit}</>}
        {cost.unpriced > 0 && <> · {cost.unpriced} with no price yet</>}
        {time.handsOn + time.wait > 0 && <> · {formatMinutes(time.handsOn)} hands-on</>}
      </div>
    )
  }

  const notIn = cost.missing
  return (
    <section className="bg-paper border border-line rounded-lg grid grid-cols-2 md:grid-cols-[minmax(0,1fr)_200px_200px]">
      <div className="p-4 min-w-0 col-span-2 md:col-span-1 border-b md:border-b-0 md:border-r border-line">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="ui-label">Costed</div>
            <div className="text-[26px] font-semibold tracking-[-0.03em] text-ink leading-none mt-1">
              {cost.costed}<span className="text-[14px] font-medium text-ink-3"> / {cost.total} lines</span>
            </div>
          </div>
          {onNextToFix && (
            <button type="button" onClick={onNextToFix} className="text-[12.5px] font-medium text-ink-2 hover:text-ink whitespace-nowrap">
              Next to fix →
            </button>
          )}
        </div>
        <div className="flex h-[8px] gap-[2px] rounded-full overflow-hidden bg-bg-2 mt-3" aria-hidden>
          {cost.matched > 0 && <i style={{ width: pct(cost.matched, cost.total), background: '#16a34a' }} />}
          {cost.check > 0 && <i style={{ width: pct(cost.check, cost.total), background: '#d97706' }} />}
          {cost.noMatch > 0 && <i style={{ width: pct(cost.noMatch, cost.total), background: '#dc2626' }} />}
          {cost.kept > 0 && <i style={{ width: pct(cost.kept, cost.total), background: '#a1a1aa' }} />}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 font-mono text-[10.5px] text-ink-3">
          <Legend color="#16a34a" label={`${cost.matched} matched`} />
          {cost.check > 0 && <Legend color="#d97706" label={`${cost.check} check`} />}
          {cost.noMatch > 0 && <Legend color="#dc2626" label={`${cost.noMatch} no match`} />}
          {cost.kept > 0 && <Legend color="#a1a1aa" label={`${cost.kept} kept uncosted`} />}
          {cost.noAmount > 0 && <Legend color="#d4d4d8" label={`${cost.noAmount} no amount`} />}
        </div>
      </div>

      <div className="p-4 min-w-0 border-r border-line">
        <div className="ui-label">Batch cost{cost.complete ? '' : ' · so far'}</div>
        <div className="text-[22px] font-semibold tracking-[-0.03em] text-ink leading-none mt-1 font-mono">{money(cost.batch)}</div>
        <p className="text-[12px] text-ink-3 mt-1.5 leading-snug">
          {cost.perYield !== null && yieldUnit
            ? <><b className="text-ink-2">{money(cost.perYield)}</b> per {yieldUnit}</>
            : 'Add the yield for a per-unit cost'}
          {notIn > 0 && <> · <b className="text-red-text">{notIn} {notIn === 1 ? 'line' : 'lines'}</b> not in it yet</>}
          {cost.unpriced > 0 && <> · {cost.unpriced} with no price yet</>}
        </p>
      </div>

      <div className="p-4 min-w-0">
        <div className="ui-label">Time</div>
        <div className="text-[22px] font-semibold tracking-[-0.03em] text-ink leading-none mt-1 font-mono">
          {time.handsOn}<span className="text-[12px] font-medium text-ink-3 font-sans"> min hands-on</span>
        </div>
        <p className="text-[12px] text-ink-3 mt-1.5 leading-snug">
          {time.wait > 0 ? <>+ <b className="text-ink-2">{formatMinutes(time.wait)}</b> waiting</> : 'No waits'}
          {time.guessed > 0 && <> · {time.guessed} {time.guessed === 1 ? 'time' : 'times'} guessed</>}
        </p>
      </div>
    </section>
  )
}
