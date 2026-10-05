'use client'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { clockText } from '@/lib/start-page'
import { useStartData } from './useStartData'
import { Headline, greetingFor, crumbDate, scoreRows, personName } from './parts'

// The phone start page for MANAGER+ (/today). Same data and order as the
// desktop Pass, stacked: clock + prep, what needs you, last night's note,
// yesterday + food cost, running low. Every row is one tap to where it's fixed.
export function StartMobile() {
  const { user } = useUser()
  const d = useStartData()
  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(' ')[0]
  const now = new Date()
  const clock = clockText(d.status, d.nowMin)
  const { posted, done } = d.progress
  const rows = scoreRows(d, formatCurrency)
  const note = d.lastClose?.handoverNote?.trim()

  return (
    <div className="flex flex-col gap-4 pt-2">
      <header>
        <div className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">{crumbDate(now)}</div>
        <h1 className="mt-1.5 text-[28px] font-semibold tracking-[-0.03em] leading-[1.1]">
          {greetingFor(now) === 'morning' ? 'Morning' : greetingFor(now) === 'afternoon' ? 'Afternoon' : 'Evening'},{' '}
          <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.
        </h1>
        <p className="mt-1.5 text-[15px] leading-[1.45] text-ink-2 [&_b]:font-semibold">
          {d.loaded ? <Headline status={d.status} needs={d.needs} /> : 'Loading…'}
        </p>
      </header>

      <Link href="/prep" className="block bg-ink text-paper rounded-2xl p-[18px]">
        <div className="flex justify-between items-end gap-3">
          {clock ? (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">{clock.label}</div>
              <div className="text-[40px] font-semibold tracking-[-0.04em] leading-none mt-1 tabular-nums">{clock.big}</div>
            </div>
          ) : <div />}
          <div className="text-right">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">Prep done</div>
            {!d.loaded
              ? <div className="text-[15px] font-semibold mt-1.5 text-ink-4">—</div>
              : posted > 0
              ? <div className="text-[24px] font-semibold tracking-[-0.03em] mt-1">{done}<span className="text-[14px] font-medium text-ink-4"> / {posted}</span></div>
              : <div className="text-[15px] font-semibold mt-1.5">Not posted</div>}
          </div>
        </div>
        {posted > 0 && (
          <div className="h-1.5 rounded-full bg-ink-2 overflow-hidden mt-3.5">
            <div className="h-full bg-green" style={{ width: `${Math.round((done / posted) * 100)}%` }} />
          </div>
        )}
        {clock && <div className="text-[12.5px] text-ink-4 mt-3">{clock.sub}</div>}
      </Link>

      <section aria-label="Needs you">
        <div className="flex items-baseline justify-between px-0.5 mb-2">
          <h2 className="text-[15px] font-semibold">Needs you</h2>
          {d.needs.length > 0 && <span className="font-mono text-[10.5px] text-ink-3">{d.needs.length}</span>}
        </div>
        {!d.loaded ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Loading…</div>
        ) : d.needs.length === 0 ? (
          <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">Nothing needs you right now — go cook.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {d.needs.map(n => (
              <Link
                key={n.id}
                href={n.href}
                className={`flex items-center gap-3 bg-paper rounded-[14px] p-3.5 min-h-[64px] border ${n.when === 'now' ? 'border-red-soft' : 'border-line'}`}
              >
                <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${n.when === 'now' ? 'bg-red' : 'bg-gold'}`} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[15px] font-semibold text-ink">{n.title}</span>
                  <span className="block text-[12.5px] text-ink-3 mt-0.5">{n.detail}</span>
                </span>
                <ChevronRight size={17} className="text-ink-4 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </section>

      {d.lastClose && (
        <section aria-label="From last night" className="bg-paper border border-line rounded-[14px] p-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            From last night{d.lastClose.signedOffByName ? ` · ${personName(d.lastClose.signedOffByName)}` : ''}
          </div>
          <p className={`mt-2 text-[14.5px] leading-[1.5] whitespace-pre-wrap ${note ? 'font-medium text-ink' : 'text-ink-3'}`}>
            {note ? `“${note}”` : 'No note left.'}
          </p>
        </section>
      )}

      {rows.length > 0 && (
        <section aria-label="How we're doing" className="bg-paper border border-line rounded-[14px] px-4 py-1.5">
          <table className="w-full text-[14px]">
            <tbody>
              {rows.filter(r => r.label !== 'Target').map((r, i) => (
                <tr key={r.label} className={i > 0 ? 'border-t border-bg-2' : ''}>
                  <td className="py-[11px] text-ink-2">{r.label}</td>
                  <td className={`py-[11px] text-right font-semibold tabular-nums ${r.tone === 'bad' ? 'text-red-text' : r.tone === 'ok' ? 'text-green-text' : 'text-ink'}`}>
                    {r.value}
                    {r.label === 'Food cost this week' && d.foodCost && (
                      <span className="font-normal text-ink-3"> / {d.foodCost.target.toFixed(1)}%</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {d.hasOrders && d.low.top.length > 0 && (
        <section aria-label="Running low">
          <div className="flex items-baseline justify-between px-0.5 mb-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Running low</div>
            <Link href="/inventory" className="text-[12.5px] text-gold-2">Order list</Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.low.top.map(l => (
              <span key={l.id} className={`text-[13px] font-medium px-3 py-[7px] rounded-full ${l.out ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                {l.name} · {l.label}
              </span>
            ))}
            {d.low.more > 0 && <span className="text-[13px] text-ink-3 px-1 py-[7px]">+{d.low.more} more</span>}
          </div>
        </section>
      )}
    </div>
  )
}
