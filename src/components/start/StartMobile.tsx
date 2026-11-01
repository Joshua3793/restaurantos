'use client'
import Link from 'next/link'
import { useUser } from '@/contexts/UserContext'
import { clockText } from '@/lib/start-page'
import { PHONE_TOP, countNow, itemMeta, moreCount, stationsDone, topItems } from '@/lib/pass'
import type { InboxItem } from '@/components/inbox/format'
import { useStartData, type StartData } from './useStartData'
import { greetingFor, crumbDate } from './parts'
import { ChecklistCard } from './ChecklistCard'
import {
  Lede, LastNight, PassItemDialog, StationTileSmall, ItemCta, TagLine, VALUE_TONE,
  ReportButton, numberRows, usePassItem,
} from './PassParts'

// The phone Pass (/today) for LEAD+, and LEAD's /today on desktop too (in a
// narrow column). Follows the PassMobile mockup: greeting + lede, what needs
// you right now (the top of the Inbox), the stations, service + prep, last
// night's notes, and the numbers (MANAGER only — a LEAD sees no money).
export function StartMobile() {
  const { user } = useUser()
  const d = useStartData()
  const firstName = (user?.name || user?.email?.split('@')[0] || 'there').split(' ')[0]
  const now = new Date()
  const items = d.inbox?.items ?? []
  const top = topItems(items, PHONE_TOP)
  const nowN = countNow(items)
  const item = usePassItem(d.inbox?.tags ?? [], d.rcId, d.loadInbox)
  const greet = greetingFor(now)

  return (
    <div className="flex flex-col gap-4 pt-2">
      <header className="flex flex-col gap-1.5">
        <div className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
          {crumbDate(now)}{d.rcName && <> · {d.rcName.toUpperCase()}</>}
        </div>
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] leading-[1.1]">
          {greet === 'morning' ? 'Morning' : greet === 'afternoon' ? 'Afternoon' : 'Evening'},{' '}
          <em className="font-fraunces italic font-medium text-gold-2">{firstName}</em>.
        </h1>
        <p className="text-[15px] leading-[1.45] text-ink-2">
          <Lede d={d} nowCount={nowN} />
        </p>
        <ReportButton d={d} className="self-start mt-1.5" />
      </header>

      {!d.isManager && <ChecklistCard rcId={d.rcId} phase={d.phase} pickedOnly label="Your station" />}

      <RightNow d={d} top={top} nowN={nowN} more={moreCount(items, top.length)} onOpen={item.open} />

      <Stations d={d} now={now} />

      <ServiceCard d={d} />

      <LastNight d={d} now={now} />

      {d.isManager && <Numbers d={d} />}

      <PassItemDialog props={item.props} onClose={item.close} />
    </div>
  )
}

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 py-4 text-[14px] text-ink-3">{children}</div>
)

function RightNow({ d, top, nowN, more, onOpen }: {
  d: StartData
  top: InboxItem[]
  nowN: number
  more: number
  onOpen: (item: InboxItem) => void
}) {
  if (!d.isRc) return null
  const right = nowN > 0
    ? `${nowN} ${d.status.kind === 'upcoming' ? 'BEFORE DOORS' : 'NOW'}`
    : top.length > 0 ? `${top.length} TODAY` : null
  return (
    <section aria-label="Right now" className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className="flex justify-between items-baseline px-4 py-3 border-b border-line">
        <h2 className="text-[13.5px] font-semibold">Right now</h2>
        {right && <span className={`font-mono text-[10.5px] ${nowN > 0 ? 'text-red-text' : 'text-gold-2'}`}>{right}</span>}
      </div>
      {!d.loaded || (!d.inbox && !d.inboxError) ? (
        <Panel>Loading…</Panel>
      ) : d.inboxError && !d.inbox ? (
        <div className="px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-[14px] text-ink-3">Could not load the Inbox.</span>
          <button type="button" onClick={() => d.loadInbox()} className="min-h-[44px] px-3.5 rounded-full border border-line-2 font-mono text-[11px]">Try again</button>
        </div>
      ) : top.length === 0 ? (
        <Panel>Nothing needs you right now — go cook.</Panel>
      ) : (
        top.map((n, i) => (
          <div key={n.id} className={`flex gap-3 px-4 py-[13px] items-start ${i > 0 ? 'border-t border-bg-2' : ''}`}>
            <span className={`flex-none w-2.5 h-2.5 rounded-full mt-[5px] ${n.severity === 'NOW' ? 'bg-red' : 'bg-gold'}`} aria-hidden />
            <span className="flex-1 min-w-0 flex flex-col gap-1">
              <TagLine item={n} />
              <span className="text-[15px] font-semibold tracking-[-0.015em] leading-[1.3] text-ink">{n.title}</span>
              <span className="font-mono text-[10.5px] text-ink-3">{itemMeta(n)}</span>
            </span>
            <ItemCta item={n} gold={i === 0} onOpen={onOpen} className="self-center" />
          </div>
        ))
      )}
      <Link href="/inbox" className="flex justify-between items-center px-4 min-h-[48px] border-t border-line text-[13.5px] font-medium text-ink-2">
        <span>{more > 0 ? `${more} more in the Inbox` : 'Everything else is in the Inbox'}</span>
        <span className="font-mono text-[11px] text-gold-2">Open Inbox →</span>
      </Link>
    </section>
  )
}

function Stations({ d, now }: { d: StartData; now: Date }) {
  if (d.stations.length === 0) return null
  const { done, of } = stationsDone(d.stations)
  return (
    <section aria-label="Stations" className="bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-3">
      <div className="flex justify-between items-baseline">
        <h2 className="text-[13.5px] font-semibold">{d.phase === 'OPEN' ? 'Opening' : 'Closing'} · stations</h2>
        <span className="font-mono text-[10.5px] text-ink-3">{done} OF {of} DONE</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {d.stations.map(s => <StationTileSmall key={s.id} s={s} now={now} />)}
      </div>
      <Link href="/checklist/today" className="font-mono text-[11px] text-gold-2 min-h-[44px] flex items-center self-start">Station board →</Link>
    </section>
  )
}

/** Service clock + prep done — unchanged from the old start page. */
function ServiceCard({ d }: { d: StartData }) {
  const clock = clockText(d.status, d.nowMin)
  const { posted, done } = d.progress
  return (
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
  )
}

function Numbers({ d }: { d: StartData }) {
  const rows = numberRows(d, { foodCost: true })
  if (rows.length === 0) return null
  return (
    <section aria-label="How we're doing" className="bg-paper border border-line rounded-[14px] px-4 py-1">
      {rows.map((r, i) => {
        const inner = (
          <>
            <span className="text-ink-2">{r.label}</span>
            <span className={`font-mono font-semibold tabular-nums ${VALUE_TONE(r.tone)}`}>{r.value}</span>
          </>
        )
        const cls = `flex justify-between items-center min-h-[44px] py-2 text-[14px] ${i > 0 ? 'border-t border-bg-2' : ''}`
        return r.href
          ? <Link key={r.label} href={r.href} className={cls}>{inner}</Link>
          : <div key={r.label} className={cls}>{inner}</div>
      })}
    </section>
  )
}
