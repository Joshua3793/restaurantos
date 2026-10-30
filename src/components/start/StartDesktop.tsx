'use client'
import { useState } from 'react'
import Link from 'next/link'
import { Activity, Clock, RefreshCw, ArrowRight, ListChecks } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { clockText, dayTimeline } from '@/lib/start-page'
import { whenLabel, type InboxItem } from '@/components/inbox/format'
import { TagDot } from '@/components/inbox/TagChips'
import { DESKTOP_TOP, countNow, itemMeta, moreCount, stationsDone, tagRows, topItems } from '@/lib/pass'
import { SubNav } from '@/components/layout/SubNav'
import { PageHead } from '@/components/layout/PageHead'
import { useStartData, type StartData } from './useStartData'
import { greetingFor, crumbDate, personName } from './parts'
import {
  Lede, LastNight, PassItemDialog, StationTileWide, ItemCta, TagLine, WhenPill, VALUE_TONE,
  numberRows, useInboxCount, usePassItem,
} from './PassParts'

// The desktop Pass (/pass, MANAGER+). Follows the PassDesktop mockup: the
// header with the Inbox, the service band, then what needs you first (the top
// of the Inbox, NOW then TODAY) and the stations on the left; the Inbox by tag,
// last night's notes and the numbers on the right. The deeper numbers live in
// Reports — this page only carries what changes the next hour.
export function StartDesktop() {
  const { user } = useUser()
  const d = useStartData()
  const firstName = user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'there'
  const now = new Date()
  const items = d.inbox?.items ?? []
  const top = topItems(items, DESKTOP_TOP)
  const nowN = countNow(items)
  const laterToday = moreCount(items, nowN)
  const feedCount = useInboxCount(d.rcId)
  const inboxCount = feedCount ?? (d.inbox ? items.filter(i => i.severity !== 'FYI').length : null)
  const item = usePassItem(d.inbox?.tags ?? [], d.rcId, d.loadInbox)

  return (
    <>
      <SubNav
        tabs={[
          { href: '/pass', label: 'Pass' },
          { href: '/preshift', label: 'Pre-shift', icon: <Activity size={14} /> },
          // The manager's view of the station checklists is the board, not the cook screen.
          { href: '/checklist/today', label: 'Open & close', icon: <ListChecks size={14} /> },
          { href: '/end-of-day', label: 'End-of-day', icon: <Clock size={14} /> },
        ]}
      />
      <div className="p-4 md:p-6 md:px-8 max-w-[1240px] mx-auto w-full">
        <PageHead
          crumbs={<><Clock size={12} /> PASS · {crumbDate(now)}{d.rcName && <> · {d.rcName.toUpperCase()}</>}</>}
          title={<>Good {greetingFor(now)}, <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.</>}
          sub={
            <span className="text-[15px] text-ink-2">
              <Lede d={d} nowCount={nowN} />
              {d.loaded && d.isRc && laterToday > 0 && <> {laterToday} more today in the Inbox.</>}
            </span>
          }
          actions={d.isRc && (
            <Link
              href="/inbox"
              className="inline-flex items-center gap-2 min-h-[40px] px-3.5 rounded-[9px] bg-ink text-paper text-[13px] font-medium hover:bg-ink-2"
            >
              Open Inbox
              {inboxCount != null && inboxCount > 0 && (
                <span className="font-mono text-[10.5px] bg-red text-paper rounded-full px-[7px] py-px">{inboxCount}</span>
              )}
              <span className="text-gold" aria-hidden>→</span>
            </Link>
          )}
        />

        <ServiceBand d={d} />

        <div className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] mt-5 items-start">
          <div className="flex flex-col gap-5 min-w-0">
            <NeedsFirst d={d} top={top} onOpen={item.open} now={now} />
            <Stations d={d} now={now} />
          </div>
          <aside className="flex flex-col gap-5 min-w-0">
            <InboxByTag d={d} />
            <LastNight d={d} now={now} compact right={closedLine(d, now)} />
            {d.isManager && <Scoreboard d={d} />}
          </aside>
        </div>
      </div>
      <PassItemDialog props={item.props} onClose={item.close} />
    </>
  )
}

/** "CLOSED 22:48 · LEO" for the whole-kitchen close; the note count otherwise. */
function closedLine(d: StartData, now: Date): string | undefined {
  const c = d.lastClose
  if (!c?.signedOffAt) return undefined
  const by = personName(c.signedOffByName)
  return [`CLOSED ${whenLabel(c.signedOffAt, now)}`, by?.toUpperCase()].filter(Boolean).join(' · ')
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

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="px-[18px] py-10 text-center text-[14px] text-ink-3">{children}</p>
)

function NeedsFirst({ d, top, onOpen, now }: { d: StartData; top: InboxItem[]; onOpen: (i: InboxItem) => void; now: Date }) {
  return (
    <section aria-label="Needs you first" className="bg-paper border border-line rounded-xl overflow-hidden min-w-0">
      <div className="flex justify-between items-baseline px-[18px] py-3.5 border-b border-line">
        <h2 className="text-[13.5px] font-semibold">Needs you first</h2>
        <span className="font-mono text-[10.5px] text-ink-3">NOW + TODAY · RANKED</span>
      </div>
      {!d.isRc ? (
        <Empty>Pick a kitchen in the top bar to see what needs you.</Empty>
      ) : !d.loaded || (!d.inbox && !d.inboxError) ? (
        <Empty>Loading…</Empty>
      ) : d.inboxError && !d.inbox ? (
        <div className="px-[18px] py-8 flex items-center justify-center gap-3">
          <span className="text-[14px] text-ink-3">Could not load the Inbox.</span>
          <button type="button" onClick={() => d.loadInbox()} className="min-h-[40px] px-3.5 rounded-full border border-line-2 font-mono text-[11px] hover:border-ink-3">Try again</button>
        </div>
      ) : top.length === 0 ? (
        <div className="px-[18px] py-10 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
          <p className="text-[14px] text-ink-3 mt-1.5">Nothing needs you right now — go cook.</p>
        </div>
      ) : (
        top.map((n, i) => (
          <div key={n.id} className={`grid grid-cols-[24px_minmax(0,1fr)_64px_auto] gap-3 items-center px-[18px] py-3 ${i > 0 ? 'border-t border-bg-2' : ''}`}>
            <span className="font-mono text-[11px] text-ink-4">{String(i + 1).padStart(2, '0')}</span>
            <span className="flex flex-col gap-[3px] min-w-0">
              <TagLine item={n} />
              <span className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">{n.title}</span>
              <span className="font-mono text-[10.5px] text-ink-3 truncate">{itemMeta(n, now)}</span>
            </span>
            <WhenPill item={n} />
            <ItemCta item={n} gold={i === 0} onOpen={onOpen} />
          </div>
        ))
      )}
    </section>
  )
}

function Stations({ d, now }: { d: StartData; now: Date }) {
  if (d.stations.length === 0) return null
  const { done, of } = stationsDone(d.stations)
  return (
    <section aria-label="Stations" className="bg-paper border border-line rounded-xl px-[18px] py-4 flex flex-col gap-3">
      <div className="flex justify-between items-center gap-4">
        <h2 className="text-[13.5px] font-semibold">Stations · {d.phase === 'OPEN' ? 'opening' : 'closing'}</h2>
        <div className="flex gap-4 items-center">
          <span className="font-mono text-[10.5px] text-ink-3">{done} OF {of} DONE</span>
          <Link href="/checklist/today" className="font-mono text-[11px] text-gold-2 hover:text-ink">Station board →</Link>
        </div>
      </div>
      <div className="grid grid-cols-3 xl:grid-cols-6 gap-2.5">
        {d.stations.map(s => <StationTileWide key={s.id} s={s} now={now} />)}
      </div>
    </section>
  )
}

function InboxByTag({ d }: { d: StartData }) {
  if (!d.inbox) return null
  const rows = tagRows(d.inbox.tags, d.inbox.counts.byTag, d.inbox.items)
  return (
    <section aria-label="Inbox by tag" className="bg-paper border border-line rounded-xl px-[18px] py-4 flex flex-col gap-2.5">
      <div className="flex justify-between items-baseline">
        <h2 className="text-[13.5px] font-semibold">Inbox by tag</h2>
        <span className="font-mono text-[10.5px] text-ink-3">{d.inbox.counts.open} OPEN</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-ink-3">Nothing open. All clear.</p>
      ) : rows.map(r => (
        <Link key={r.tag.id} href="/inbox" className="grid grid-cols-[12px_minmax(0,1fr)_32px_64px] gap-2.5 items-center min-h-[34px] text-ink hover:text-gold-2">
          <TagDot color={r.tag.color} />
          <span className="text-[13.5px] truncate">{r.tag.name}</span>
          <span className="font-mono text-[12px] font-semibold text-right tabular-nums">{r.count}</span>
          {r.now > 0
            ? <span className="justify-self-end font-mono text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-soft text-red-text">{r.now} NOW</span>
            : <span />}
        </Link>
      ))}
    </section>
  )
}

function Scoreboard({ d }: { d: StartData }) {
  const rows = numberRows(d, { foodCost: true })
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
    <section aria-label="How we're doing" className="bg-paper border border-line rounded-xl px-[18px] pt-3 pb-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">How we&apos;re doing</div>
        <button
          onClick={syncSales}
          disabled={syncing}
          title="Pull today's sales from Toast now"
          className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink disabled:opacity-60 min-h-[32px]"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Pulling…' : 'Update sales'}
        </button>
      </div>
      {note && <div className={`text-[12px] mt-1 ${note.ok ? 'text-ink-3' : 'text-red-text'}`}>{note.text}</div>}
      <div className="mt-1">
        {rows.map((r, i) => {
          const inner = (
            <>
              <span className="text-ink-2">{r.label}</span>
              <span className={`font-mono font-semibold tabular-nums ${VALUE_TONE(r.tone)}`}>{r.value}</span>
            </>
          )
          const cls = `flex justify-between py-2.5 text-[13.5px] ${i > 0 ? 'border-t border-bg-2' : ''}`
          return r.href
            ? <Link key={r.label} href={r.href} className={`${cls} hover:text-gold-2`}>{inner}</Link>
            : <div key={r.label} className={cls}>{inner}</div>
        })}
      </div>
      <Link href="/reports" className="inline-block text-[12.5px] text-gold-2 mt-1 hover:text-ink">All the numbers →</Link>
    </section>
  )
}
