'use client'
import type { MyPayout, MyPayoutDay } from '@/lib/tips/me'
import { money, hoursLabel } from './kit'

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })

function DayRow({ day }: { day: MyPayoutDay }) {
  const worked = day.rawHours > 0
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-line last:border-b-0 text-[13px]">
      <span className="w-16 text-ink-3 shrink-0">{day.label}</span>
      <span className={`w-16 font-mono text-[12px] shrink-0 ${worked ? 'text-ink' : 'text-ink-4'}`}>
        {worked ? hoursLabel(day.hours) : 'off'}
      </span>
      <span className="flex gap-1 flex-wrap min-w-0">
        {day.boost > 1 && (
          <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-gold-soft text-gold-2">
            ×{day.boost}
          </span>
        )}
        {day.capped && (
          <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-red-soft text-red-text">
            capped {day.rawHours}
          </span>
        )}
        {day.edited && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-bg-2 text-ink-3">adjusted</span>
        )}
      </span>
      <span className={`ml-auto font-mono text-[12.5px] font-semibold shrink-0 ${worked ? 'text-ink' : 'text-ink-4'}`}>
        {worked ? money(day.amount) : '—'}
      </span>
    </div>
  )
}

export function MyPayoutDetail({ payout }: { payout: MyPayout }) {
  return (
    <div>
      {payout.status === 'BEING_CORRECTED' && (
        <div className="mb-4 rounded-lg border border-gold bg-gold-soft px-3 py-2 text-[12.5px] text-gold-2">
          This payout is being corrected — the amount may still change.
        </div>
      )}

      <div className="text-center py-4">
        <div className="text-[38px] font-semibold tracking-[-0.03em] leading-none text-ink">
          {money(payout.envelopeCents / 100)}
        </div>
        <div className="text-[12px] text-ink-3 mt-1.5">
          {payout.startDate} – {payout.endDate}
          {payout.paidAt ? ` · paid ${dateLabel(payout.paidAt)}` : ''}
          {payout.paidByName ? ` by ${payout.paidByName}` : ''}
        </div>
      </div>

      <div className="flex border border-line rounded-lg overflow-hidden my-4">
        {[
          { v: hoursLabel(payout.hoursTotal), l: 'hours' },
          { v: money(payout.perHour), l: 'per hour' },
          { v: money(payout.tip), l: 'earned' },
        ].map(s => (
          <div key={s.l} className="flex-1 py-2 text-center border-r border-line last:border-r-0">
            <b className="block text-[14px] font-semibold text-ink">{s.v}</b>
            <span className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">{s.l}</span>
          </div>
        ))}
      </div>

      <div className="font-mono text-[10.5px] uppercase tracking-[0.02em] text-ink-3 mb-1">
        Your days
      </div>
      {payout.days.map((d, i) => <DayRow key={i} day={d} />)}

      <p className="mt-4 text-[11.5px] text-ink-3 leading-relaxed">
        <b className="text-ink font-medium">Earned</b> is the exact amount your hours came to.
        <b className="text-ink font-medium"> {money(payout.envelopeCents / 100)}</b> is the cash
        that was actually counted out, rounded to whole notes. The difference is rounding, not a deduction.
        {payout.dailyHourCap != null && ` Your contracted shift is ${payout.dailyHourCap} h — hours past it on a single day aren't tipped.`}
      </p>
    </div>
  )
}
