'use client'
import type { Denom, SplitResult } from '@/lib/tips/types'
import { breakdown } from '@/lib/tips/engine'
import { money } from './kit'

/** Denomination chip colouring — mirrors `.d100/.d50/.d20/.d10/.d5/.dcoin`. */
function chipClass(cents: number): string {
  if (cents === 10000) return 'bg-[#f3e8dc] text-[#7c4a1e]'
  if (cents === 5000) return 'bg-red-soft text-red-text'
  if (cents === 2000) return 'bg-green-soft text-green-text'
  if (cents === 1000) return 'bg-[#ede9fe] text-[#6d28d9]'
  if (cents === 500) return 'bg-blue-soft text-blue-text'
  return 'bg-bg-2 text-ink-2 border border-line'
}

const STEPS: Array<{ cents: number; label: string }> = [
  { cents: 5, label: '5¢' },
  { cents: 100, label: '$1' },
  { cents: 500, label: '$5' },
]

export function CashTab({
  split, denoms, roundingStepCents, readOnly, onDenomToggle, onRoundingChange,
}: {
  split: SplitResult
  denoms: Denom[]
  roundingStepCents: number
  readOnly: boolean
  onDenomToggle: (index: number) => void
  onRoundingChange: (cents: number) => void
}) {
  const withEnvelopes = split.people.filter(p => p.envelopeCents > 0)

  // Bank order — every envelope's breakdown, summed by denomination.
  const bank = new Map<string, number>()
  const envelopes = withEnvelopes.map(p => {
    const bd = breakdown(p.envelopeCents, denoms)
    bd.parts.forEach(part => bank.set(part.l, (bank.get(part.l) ?? 0) + part.n))
    return { person: p, bd }
  })
  const pieces = [...bank.values()].reduce((a, b) => a + b, 0)
  // distributedTotal, not poolTotal: the money actually owed to people is what
  // envelope rounding targets (see SplitResult.distributedTotal / engine.ts's
  // assignEnvelopes) — poolTotal can include a day pool nobody was on shift to
  // earn, which would read as permanently "under" here even when rounding is
  // exact.
  const drift = split.envelopeTotalCents / 100 - split.distributedTotal

  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_auto] gap-2.5 items-center mb-3.5">
        <div className="font-mono text-[10.5px] text-ink-3">ENVELOPES · ROUNDED FOR CASH · NO PENNIES (CAD)</div>
        <span className="font-mono text-[11px] text-ink-3">ROUND TO</span>
        <div className="flex bg-paper border border-line rounded p-[3px]">
          {STEPS.map(s => (
            <button
              key={s.cents}
              disabled={readOnly}
              onClick={() => onRoundingChange(s.cents)}
              className={`px-2.5 py-1 font-mono text-[11px] rounded-md ${roundingStepCents === s.cents ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink'}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-5 items-start">
        <div className="grid grid-cols-2 gap-3">
          {envelopes.map(({ person, bd }) => (
            <div key={person.cookId} className="bg-paper border border-line rounded-xl px-4 py-3.5">
              <div className="flex justify-between items-baseline mb-[9px]">
                <span className="font-semibold text-[13.5px] tracking-[-0.01em]">{person.name}</span>
                <span className="font-mono text-[16px] font-semibold tracking-[-0.01em]">{money(person.envelopeCents / 100)}</span>
              </div>
              <div className="flex flex-wrap gap-[5px]">
                {bd.parts.map(part => (
                  <span key={part.l} className={`font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold ${chipClass(part.v)}`}>
                    <b className="font-normal opacity-65 mr-px">{part.n}×</b>{part.l}
                  </span>
                ))}
                {bd.remainder > 0 && (
                  <span className="font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold bg-red-soft text-red-text">
                    {(bd.remainder / 100).toFixed(2)} short — enable smaller coins
                  </span>
                )}
              </div>
            </div>
          ))}
          {!envelopes.length && (
            <div className="col-span-2 bg-paper border border-line rounded-xl py-12 text-center font-mono text-[10.5px] text-ink-3">
              NO ENVELOPES YET — IMPORT THE CLOCKS WORKBOOK
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3.5">
          <div className="bg-paper border border-line rounded-xl p-5">
            <h3 className="text-[15px] font-semibold tracking-[-0.015em] mb-0.5">Bank order</h3>
            <p className="font-mono text-[10.5px] text-ink-3 mb-3.5">what to withdraw to fill every envelope</p>
            <div className="flex flex-col gap-0.5 pb-3.5 border-b border-line mb-3">
              <span className="text-[30px] font-semibold tracking-[-0.035em]">{money(split.envelopeTotalCents / 100)}</span>
              <span className="font-mono text-[10.5px] text-ink-3">{pieces} pieces · {envelopes.length} envelopes</span>
            </div>
            {denoms.map((d, i) => {
              const n = d.on ? (bank.get(d.l) ?? 0) : 0
              return (
                <div key={d.l} className={`grid grid-cols-[34px_1fr_auto_auto] items-center gap-2.5 py-1.5 text-[13px] ${d.on ? '' : 'opacity-40'}`}>
                  <span className={`font-mono text-[10.5px] px-2 py-[3px] rounded-md font-semibold text-center ${chipClass(d.v)}`}>{d.l}</span>
                  <button
                    disabled={readOnly}
                    onClick={() => onDenomToggle(i)}
                    className={`w-[30px] h-[18px] rounded-full relative shrink-0 ${d.on ? 'bg-green' : 'bg-line-2'}`}
                    aria-label={`${d.on ? 'Disable' : 'Enable'} ${d.l}`}
                  >
                    <span className={`absolute top-0.5 w-3.5 h-3.5 bg-paper rounded-full shadow-sm transition-all ${d.on ? 'left-3.5' : 'left-0.5'}`} />
                  </button>
                  <span className="font-mono text-[12.5px] text-right text-ink">{d.on ? `×${n}` : '—'}</span>
                  <span className="font-mono text-[11px] text-ink-3 text-right min-w-[70px]">{d.on && n ? money((n * d.v) / 100) : ''}</span>
                </div>
              )
            })}
            <div className="mt-3 px-3 py-2.5 rounded bg-bg-2 font-mono text-[10.5px] text-ink-3 leading-[1.6] [&_b]:text-ink [&_b]:font-semibold">
              Envelopes total <b>{money(split.envelopeTotalCents / 100)}</b> vs <b>{money(split.distributedTotal)}</b> owed<br />
              {Math.abs(drift) < 0.005
                ? 'Exact to the cent — nothing carried.'
                : drift > 0
                  ? <><b>{money(drift)}</b> over — rounded up, covered by the float.</>
                  : <><b>{money(-drift)}</b> under — remainder carries into next period&rsquo;s pool.</>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
