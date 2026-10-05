'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Activity, Clock, Moon, RefreshCw, ArrowRight } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { formatCurrency } from '@/lib/utils'
import { clockText, dayTimeline, type NeedItem } from '@/lib/start-page'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'
import { useStartData, type StartData } from './useStartData'
import { NEED_ICON, Headline, greetingFor, crumbDate, scoreRows, signedOff } from './parts'

// The desktop start page (/pass, MANAGER+). One question per block, in the order
// a chef asks them on arrival: how long until doors, what needs me, how did we do.
// The deeper numbers (three food-cost views, stock value, waste, counts history)
// live in Reports — this page only carries what changes the next hour.
export function StartDesktop() {
  const { user } = useUser()
  const d = useStartData()
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'
  const now = new Date()

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift', icon: <Activity size={14} /> },
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-[1120px] mx-auto w-full">
        <PageHead
          crumbs={<><Clock size={12} /> {crumbDate(now)}{d.rcName && <> · {d.rcName.toUpperCase()}</>}</>}
          title={<>Good {greetingFor(now)}, <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.</>}
          sub={d.loaded ? <span className="text-[15px] text-ink-2"><Headline status={d.status} needs={d.needs} /></span> : 'Loading…'}
        />

        <ServiceBand d={d} />

        <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] mt-5 items-start">
          <NeedsPanel d={d} />
          <aside className="space-y-4 min-w-0">
            {d.lastClose && <CloseNote close={d.lastClose} />}
            <Scoreboard d={d} />
            {d.hasOrders && <RunningLow d={d} />}
          </aside>
        </div>
      </div>
    </>
  )
}

function ServiceBand({ d }: { d: StartData }) {
  const clock = clockText(d.status, d.nowMin)
  const line = dayTimeline(d.services, d.nowMin)
  const { posted, done, doing } = d.progress
  const pct = posted > 0 ? Math.round((done / posted) * 100) : 0
  return (
    <section aria-label="Service and prep" className="bg-ink text-paper rounded-[14px] px-6 py-5 flex flex-wrap lg:flex-nowrap items-center gap-x-7 gap-y-5">
      {clock && (
        <div className="shrink-0">
          <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-ink-4">{clock.label}</div>
          <div className="text-[46px] font-semibold tracking-[-0.04em] leading-none mt-1 tabular-nums">{clock.big}</div>
          <div className="text-[12.5px] text-ink-4 mt-1.5">{clock.sub}</div>
        </div>
      )}
      {line && (
        <div className="flex-1 basis-[320px] min-w-0">
          <div className="relative h-3 rounded-full bg-ink-2 overflow-hidden">
            {line.bands.map(b => (
              <div key={b.id} className="absolute inset-y-0 bg-gold/30" style={{ left: `${b.startPct}%`, width: `${b.endPct - b.startPct}%` }} />
            ))}
            <div className="absolute inset-y-0 left-0 bg-gold" style={{ width: `${line.nowPct}%` }} />
          </div>
          <div className="relative h-4 mt-2 font-mono text-[10.5px] text-ink-4">
            {line.ticks.map((t, i) => (
              <span
                key={`${t.label}-${i}`}
                className="absolute whitespace-nowrap uppercase"
                style={i === 0 ? { left: 0 } : i === line.ticks.length - 1 ? { right: 0 } : { left: `${t.pct}%`, transform: 'translateX(-50%)' }}
              >
                {t.label}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className={`shrink-0 w-[220px] ${clock || line ? 'lg:border-l lg:border-ink-2 lg:pl-7' : ''}`}>
        <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-ink-4">Prep · To Do</div>
        {!d.loaded ? (
          <div className="text-[18px] font-semibold tracking-[-0.02em] mt-1.5 text-ink-4">—</div>
        ) : posted > 0 ? (
          <>
            <div className="text-[26px] font-semibold tracking-[-0.03em] mt-1">
              {done} <span className="text-[15px] font-medium text-ink-4">of {posted} done</span>
            </div>
            <div className="h-1.5 rounded-full bg-ink-2 overflow-hidden mt-2">
              <div className="h-full bg-green" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-[12.5px] text-ink-4 mt-1.5">{doing > 0 ? `${doing} cooking now` : done === posted ? 'All done' : 'Nobody cooking yet'}</div>
          </>
        ) : (
          <>
            <div className="text-[18px] font-semibold tracking-[-0.02em] mt-1.5">Not posted yet</div>
            <Link href="/prep" className="inline-flex items-center gap-1 text-[12.5px] text-gold mt-1.5 hover:text-paper">
              Plan prep <ArrowRight size={12} />
            </Link>
          </>
        )}
      </div>
    </section>
  )
}

function NeedsPanel({ d }: { d: StartData }) {
  const now = d.needs.filter(n => n.when === 'now')
  const later = d.needs.filter(n => n.when === 'today')
  return (
    <section aria-label="Needs you" className="bg-paper border border-line rounded-[14px] overflow-hidden min-w-0">
      <header className="flex items-center justify-between px-5 py-3.5 border-b border-line">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Needs you</h2>
        {d.needs.length > 0 && <span className="font-mono text-[11px] text-ink-3">{d.needs.length} · most urgent first</span>}
      </header>
      {!d.loaded ? (
        <p className="px-5 py-10 text-center text-[13px] text-ink-3">Loading…</p>
      ) : d.needs.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
          <p className="text-[14px] text-ink-3 mt-1.5">Nothing needs you right now — go cook.</p>
        </div>
      ) : (
        <>
          {now.length > 0 && (
            <>
              <GroupLabel tone="bad">{d.status.kind === 'upcoming' ? 'Before doors' : 'Now'}</GroupLabel>
              {now.map(n => <NeedRow key={n.id} n={n} />)}
            </>
          )}
          {later.length > 0 && (
            <>
              <GroupLabel tone="warn">Later today</GroupLabel>
              {later.map(n => <NeedRow key={n.id} n={n} />)}
            </>
          )}
        </>
      )}
    </section>
  )
}

function GroupLabel({ tone, children }: { tone: 'bad' | 'warn'; children: React.ReactNode }) {
  return (
    <div className={`px-5 pt-3.5 pb-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] ${tone === 'bad' ? 'text-red-text' : 'text-gold-2'}`}>
      {children}
    </div>
  )
}

function NeedRow({ n }: { n: NeedItem }) {
  const Icon = NEED_ICON[n.kind]
  const urgent = n.when === 'now'
  return (
    <div className="flex items-center gap-3.5 px-5 py-3.5 border-b border-bg-2 last:border-0">
      <span className={`w-[38px] h-[38px] shrink-0 rounded-[10px] grid place-items-center ${urgent ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
        <Icon size={18} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{n.title}</div>
        <div className="text-[13px] text-ink-3 mt-0.5">{n.detail}</div>
      </div>
      <Link
        href={n.href}
        className={`shrink-0 inline-flex items-center min-h-[40px] px-4 rounded-[9px] text-[13px] font-medium transition-colors ${
          urgent ? 'bg-ink text-paper hover:bg-ink-2' : 'border border-line-2 text-ink-2 hover:border-ink-3'
        }`}
      >
        {n.cta}
      </Link>
    </div>
  )
}

function CloseNote({ close }: { close: NonNullable<StartData['lastClose']> }) {
  const note = close.handoverNote?.trim()
  return (
    <section aria-label="From last night's close" className="bg-paper border border-line rounded-[14px] p-5">
      <div className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
        <Moon size={12} /> From last night&apos;s close
      </div>
      <p className={`mt-2.5 text-[15px] leading-[1.5] whitespace-pre-wrap ${note ? 'font-medium text-ink' : 'text-ink-3'}`}>
        {note ? `“${note}”` : 'No note left.'}
      </p>
      <div className="text-[12.5px] text-ink-3 mt-2">{signedOff(close)}</div>
    </section>
  )
}

function Scoreboard({ d }: { d: StartData }) {
  const rows = scoreRows(d, formatCurrency)
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // On-demand Toast pull for today. Idempotent server-side, so repeated clicks
  // just refresh the figures. Kept from the old Pass header.
  const syncSales = async () => {
    setSyncing(true); setNote(null)
    try {
      const res = await fetch('/api/toast/sync-sales', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      const r = data.result
      if (!res.ok || r?.status === 'error') setNote({ ok: false, text: data.error || r?.error || 'Sync failed' })
      else if (r?.status === 'skipped' || (r?.ordersPulled ?? 0) === 0) setNote({ ok: true, text: 'No sales yet today' })
      else setNote({ ok: true, text: `Pulled ${r.ordersPulled} ${r.ordersPulled === 1 ? 'order' : 'orders'}` })
      d.reload()
    } catch {
      setNote({ ok: false, text: 'Request failed' })
    } finally {
      setSyncing(false)
      setTimeout(() => setNote(null), 6000)
    }
  }

  if (rows.length === 0) return null
  return (
    <section aria-label="How we're doing" className="bg-paper border border-line rounded-[14px] p-5">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">How we&apos;re doing</div>
        <button
          onClick={syncSales}
          disabled={syncing}
          title="Pull today's sales from Toast now"
          className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink disabled:opacity-60"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Pulling…' : 'Update sales'}
        </button>
      </div>
      {note && <div className={`text-[12px] mt-1.5 ${note.ok ? 'text-ink-3' : 'text-red-text'}`}>{note.text}</div>}
      <table className="w-full mt-2 text-[14px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.label} className={i > 0 ? 'border-t border-bg-2' : ''}>
              <td className={`py-[7px] ${r.tone === 'muted' ? 'text-ink-3' : 'text-ink-2'}`}>{r.label}</td>
              <td className={`py-[7px] text-right tabular-nums ${
                r.tone === 'bad' ? 'font-semibold text-red-text' : r.tone === 'ok' ? 'font-semibold text-green-text' : r.tone === 'muted' ? 'text-ink-3' : 'font-semibold text-ink'
              }`}>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Link href="/reports" className="inline-block text-[12.5px] text-gold-2 mt-2 hover:text-ink">All the numbers →</Link>
    </section>
  )
}

function RunningLow({ d }: { d: StartData }) {
  return (
    <section aria-label="Running low" className="bg-paper border border-line rounded-[14px] p-5">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">Running low</div>
        <Link href="/inventory" className="text-[12.5px] text-gold-2 hover:text-ink">Order list</Link>
      </div>
      {d.low.top.length === 0 ? (
        <p className="text-[13.5px] text-ink-3 mt-2.5">Nothing below par.</p>
      ) : (
        <div className="flex flex-wrap gap-2 mt-3">
          {d.low.top.map(l => (
            <span key={l.id} className={`text-[13px] font-medium px-[11px] py-1.5 rounded-full ${l.out ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
              {l.name} · {l.label}
            </span>
          ))}
          {d.low.more > 0 && <span className="text-[13px] text-ink-3 px-1 py-1.5">+{d.low.more} more below par</span>}
        </div>
      )}
    </section>
  )
}
