'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Flag } from 'lucide-react'
import { useToast } from '@/components/Toast'
import { ReportSheet } from '@/components/inbox/ReportSheet'
import { call, type Result } from '@/components/inbox/api'
import { ItemPane, ItemSheet, type ItemDetailProps } from '@/components/inbox/ItemSheet'
import { TagDot } from '@/components/inbox/TagChips'
import { SEVERITY_PILL, whenLabel, type InboxAction, type InboxDetail, type InboxItem } from '@/components/inbox/format'
import { subscribeInboxCount, refreshInboxCount } from '@/lib/inbox-count-feed'
import type { TagLite } from '@/lib/inbox/rules'
import { ctaLabel, dayPart, passLede, readyForDoors, stationTile, type PassRow, type PassStation } from '@/lib/pass'
import { formatCurrency } from '@/lib/utils'
import { personName, scoreRows } from './parts'
import type { StartData } from './useStartData'

// Pieces the phone Pass (StartMobile) and the desktop Pass (StartDesktop) share:
// the lede, the item sheet for Inbox items with no link of their own, the item
// CTA, the station tile, last night's notes and the numbers. Rules in src/lib/pass.ts.

const WHOLE_KITCHEN_DOT = '#71717a'

// ── lede ───────────────────────────────────────────────────────────────────

export function Lede({ d, nowCount }: { d: StartData; nowCount: number }) {
  if (!d.isRc) return <>Pick a kitchen in the top bar to see what needs you.</>
  if (d.inboxError && !d.inbox) return <>Couldn&apos;t load the Inbox. Try again below.</>
  if (!d.loaded || !d.inbox) return <>Loading…</>
  const l = passLede(d.status, nowCount)
  return (
    <>
      {l.doors && <>Doors in <b className="font-mono font-semibold">{l.doors}</b>. </>}
      {l.on && <>{l.on} is on. </>}
      {l.things && <b className="font-semibold text-red-text">{l.things}</b>}
      {l.rest}
    </>
  )
}

// ── the Inbox count (the shared 30 s feed the bell already runs) ────────────

export function useInboxCount(rcId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    setCount(null)
    if (!rcId) return
    return subscribeInboxCount(rcId, setCount)
  }, [rcId])
  return count
}

// ── an Inbox item with no link opens here ──────────────────────────────────

/**
 * The Inbox page's item controller, cut down for the Pass: open one item,
 * load its history, act on it, and tell the page to reload its list.
 */
export function usePassItem(tags: TagLite[], rcId: string | null, onChanged: () => void) {
  const toast = useToast()
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [note, setNote] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const openId = useRef<string | null>(null)
  const seq = useRef(0)
  const lock = useRef(false)

  const close = useCallback(() => {
    seq.current++
    openId.current = null
    setSelected(null); setDetail(null); setFailed(false); setNote('')
  }, [])

  const changed = useCallback(() => {
    onChanged()
    if (rcId) void refreshInboxCount(rcId)
  }, [onChanged, rcId])

  const loadDetail = useCallback(async (id: string) => {
    const s = ++seq.current
    setFailed(false)
    const r = await call<InboxDetail>(`/api/inbox/${id}`)
    if (s !== seq.current || openId.current !== id) return
    if (!r.ok) {
      toast.show({ type: 'error', title: r.status === 404 ? 'That item is gone.' : r.error })
      if (r.status === 404) { close(); changed() } else setFailed(true)
      return
    }
    setDetail(r.data)
    setSelected(r.data.item)
  }, [toast, close, changed])

  // A new kitchen: the old kitchen's item must not stay open.
  useEffect(() => { close() }, [rcId, close])

  const open = (item: InboxItem) => {
    if (openId.current === item.id) { if (failed) loadDetail(item.id); return }
    openId.current = item.id
    setSelected(item); setDetail(null); setNote('')
    loadDetail(item.id)
  }

  const act = async (action: InboxAction) => {
    const item = selected
    if (!item || lock.current) return
    lock.current = true
    setBusy(true)
    const text = note.trim()
    const send = (a: InboxAction) =>
      call<{ item: InboxItem }>(`/api/inbox/${item.id}`, { method: 'PATCH', body: JSON.stringify(a) })
    let r: Result<{ item: InboxItem }>
    let noteSaved = false
    if (text && (action.kind === 'wait' || action.kind === 'done')) {
      r = await send({ ...action, note: text }); noteSaved = r.ok
    } else if (text && (action.kind === 'snooze' || action.kind === 'reopen')) {
      r = await send({ kind: 'note', note: text })
      if (r.ok) { noteSaved = true; r = await send(action) }
    } else {
      r = await send(action); noteSaved = r.ok && action.kind === 'note'
    }
    if (noteSaved && openId.current === item.id) setNote(cur => (cur.trim() === text ? '' : cur))

    if (!r.ok) toast.show({ type: 'error', title: r.error })
    // Fixed or snoozed: it leaves the Pass list, so the sheet closes with it.
    const leaves = r.ok && (action.kind === 'snooze' || action.kind === 'done')
    if (leaves) close()
    else if (r.ok && openId.current === item.id) setSelected(r.data.item)
    changed()
    if (!leaves && openId.current === item.id) await loadDetail(item.id)
    setBusy(false)
    lock.current = false
  }

  const props: ItemDetailProps | null = selected && {
    item: selected,
    events: detail?.events ?? [],
    loading: !detail,
    loadFailed: failed,
    onRetry: () => { if (selected) loadDetail(selected.id) },
    limited: !!detail?.limited,
    tags,
    canRetag: true,
    busy,
    note,
    onNote: setNote,
    onAct: act,
    now: new Date(),
  }
  return { open, close, props }
}

/** The item: a bottom sheet on the phone, a centred pane on desktop. Never blurred. */
export function PassItemDialog({ props, onClose }: { props: ItemDetailProps | null; onClose: () => void }) {
  if (!props) return null
  return (
    <>
      <ItemSheet {...props} onClose={onClose} />
      <div className="hidden md:flex fixed inset-0 z-[60] items-center justify-center p-6" role="presentation">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
        <div role="dialog" aria-modal="true" aria-label={props.item.title} className="relative w-full max-w-[520px] max-h-[90vh] overflow-y-auto">
          <ItemPane {...props} onClose={onClose} />
        </div>
      </div>
    </>
  )
}

// ── one row's button ───────────────────────────────────────────────────────

export function ItemCta({ item, gold, onOpen, className = '' }: {
  item: InboxItem
  gold: boolean
  onOpen: (item: InboxItem) => void
  className?: string
}) {
  const cls = `shrink-0 inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-full font-mono text-[11px] font-medium whitespace-nowrap ${
    gold ? 'bg-gold text-ink hover:bg-gold-2 hover:text-paper' : 'bg-paper text-ink border border-line-2 hover:border-ink-3'
  } ${className}`
  const label = ctaLabel(item.href)
  if (item.href) return <Link href={item.href} className={cls}>{label}</Link>
  return <button type="button" onClick={() => onOpen(item)} className={cls}>{label}</button>
}

/** Tag dot + tag name, the line above an item's title. */
export function TagLine({ item }: { item: InboxItem }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-3 uppercase">
      <TagDot color={item.tag.color} />{item.tag.name}
    </span>
  )
}

export function WhenPill({ item }: { item: InboxItem }) {
  return (
    <span className={`justify-self-start font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full ${SEVERITY_PILL[item.severity]}`}>
      {item.severity}
    </span>
  )
}

// ── a Pass row: one alert, or a family of repeats folded into one line ─────

/** The line above a row's title: tag dot + tag name (an alert's, or its family's). */
export function RowTag({ row }: { row: PassRow<InboxItem> }) {
  const tag = row.type === 'group' ? row.tag : row.item.tag
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-3 uppercase">
      <TagDot color={tag.color} />{tag.name}
      {row.type === 'group' && <span className="text-ink-4">· {row.items.length} alerts</span>}
    </span>
  )
}

export function RowTitle({ row }: { row: PassRow<InboxItem> }) {
  return <>{row.type === 'group' ? row.title : row.item.title}</>
}

/** A family lists its names; one alert shows who · where · when. */
export function rowMeta(row: PassRow<InboxItem>, now: Date, meta: (i: InboxItem, now: Date) => string): string {
  return row.type === 'group' ? row.detail : meta(row.item, now)
}

export function RowPill({ row }: { row: PassRow<InboxItem> }) {
  return (
    <span className={`justify-self-start font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full ${SEVERITY_PILL[row.severity]}`}>
      {row.severity}
    </span>
  )
}

/** A family goes where it is dealt with (Prep, Invoices, the board); else "See all". One alert keeps its own button. */
export function RowCta({ row, gold, onOpen, className = '' }: {
  row: PassRow<InboxItem>
  gold: boolean
  onOpen: (item: InboxItem) => void
  className?: string
}) {
  if (row.type === 'item') return <ItemCta item={row.item} gold={gold} onOpen={onOpen} className={className} />
  const cls = `shrink-0 inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-full font-mono text-[11px] font-medium whitespace-nowrap ${
    gold ? 'bg-gold text-ink hover:bg-gold-2 hover:text-paper' : 'bg-paper text-ink border border-line-2 hover:border-ink-3'
  } ${className}`
  return <Link href={row.href ?? SEE_ALL_HREF} className={cls}>{row.href ? ctaLabel(row.href) : 'See all'}</Link>
}

/** The full list of alerts (Open / Waiting / Snoozed / Done) — the Pass's "See all". */
export const SEE_ALL_HREF = '/inbox'

/** All alerts, showing only one tag's. */
export const tagHref = (tagId: string) => `${SEE_ALL_HREF}?tag=${encodeURIComponent(tagId)}`

// ── where the day is, and how ready the kitchen is for doors ───────────────

const PARTS = [['before', 'Before doors'], ['service', 'Service'], ['closing', 'Closing']] as const

/** Before doors · Service · Closing, the current one lit. Nothing with no service hours set. */
export function DayPartPill({ d }: { d: StartData }) {
  const part = d.isRc ? dayPart(d.status) : null
  if (!part) return null
  return (
    <span className="inline-flex bg-bg-2 rounded-full p-[3px]" aria-label="Part of the day">
      {PARTS.map(([k, label]) => (
        <span
          key={k}
          aria-current={k === part ? 'true' : undefined}
          className={`font-mono text-[10.5px] px-2.5 py-1 rounded-full whitespace-nowrap ${k === part ? 'bg-paper text-ink font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'}`}
        >
          {label}
        </span>
      ))}
    </span>
  )
}

/**
 * Before doors only: how ready the kitchen is, read from the station lists and
 * the prep list (it replaced the Pre-shift page — nothing to tick here).
 */
export function ReadyForDoors({ d, compact = false }: { d: StartData; compact?: boolean }) {
  if (!d.isRc || !d.loaded || dayPart(d.status) !== 'before' || d.phase !== 'OPEN') return null
  const r = readyForDoors(d.stations, d.prep)
  if (r.gauges.length === 0) return null
  const tone = r.pct >= 100 ? 'bg-green' : 'bg-gold'
  const hrefFor = (k: string) => (k === 'prep' ? '/prep' : '/checklist/today?phase=OPEN')
  return (
    <section aria-label="Ready for doors" className={`bg-paper border border-line rounded-[14px] overflow-hidden ${compact ? '' : 'mt-5'}`}>
      <div className={`grid ${compact ? 'grid-cols-1' : 'grid-cols-[220px_repeat(3,minmax(0,1fr))]'}`}>
        <div className={`flex items-center gap-3 ${compact ? 'px-4 pt-3.5 pb-2' : 'px-[18px] py-4'}`}>
          <span className="font-mono text-[22px] font-semibold tracking-[-0.03em]">{r.pct}%</span>
          <span className="flex flex-col">
            <span className="text-[14px] font-semibold">Ready for doors</span>
            <span className="font-mono text-[10.5px] text-ink-3">{r.pct >= 100 ? 'ALL SET' : 'FROM THE LISTS'}</span>
          </span>
        </div>
        {r.gauges.map(g => (
          <Link
            key={g.key}
            href={hrefFor(g.key)}
            className={`flex flex-col gap-1.5 hover:bg-bg ${compact ? 'px-4 py-2.5 border-t border-bg-2' : 'px-[18px] py-4 border-l border-line'}`}
          >
            <span className="flex justify-between items-baseline gap-2">
              <span className="font-mono text-[10px] tracking-[0.08em] uppercase text-ink-3">{g.label}</span>
              <span className="font-mono text-[13px] font-semibold">{g.done}<span className="text-ink-4">/{g.of}</span></span>
            </span>
            <span className="block h-1.5 rounded-full bg-bg-2 overflow-hidden">
              <span className={`block h-full ${g.done >= g.of ? 'bg-green' : tone}`} style={{ width: `${Math.round((g.done / g.of) * 100)}%` }} />
            </span>
          </Link>
        ))}
      </div>
    </section>
  )
}

// ── station tile ───────────────────────────────────────────────────────────

const STAT_TONE = { red: 'text-red-text', green: 'text-green-text', gold: 'text-gold-2', grey: 'text-ink-2' } as const
const BAR_TONE = { red: 'bg-red', green: 'bg-green', gold: 'bg-gold', grey: 'bg-gold' } as const

/** A tile opens its own station on the board, not the bare board. */
const stationHref = (s: PassStation) => `/checklist/today?station=${encodeURIComponent(s.id)}`

/** The phone's compact tile: name, then one stat line. */
export function StationTileSmall({ s, now }: { s: PassStation; now: Date }) {
  const t = stationTile(s, now)
  const bg = t.tone === 'red' ? 'bg-red-soft' : t.tone === 'green' ? 'bg-green-soft' : 'bg-bg-2'
  const stat = t.tone === 'grey' && t.who && s.status.label === 'IN PROGRESS' ? `${t.stat} · ${t.who.toUpperCase()}` : t.stat
  return (
    <Link href={stationHref(s)} className={`flex flex-col gap-1 p-2.5 min-h-[56px] rounded-[10px] min-w-0 ${bg}`}>
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink min-w-0">
        <TagDot color={s.color} /><span className="truncate">{s.name}</span>
      </span>
      <span className={`font-mono text-[10.5px] font-medium ${STAT_TONE[t.tone]}`}>{stat}</span>
    </Link>
  )
}

/** The desktop tile: name, who, a progress bar and the stat. */
export function StationTileWide({ s, now }: { s: PassStation; now: Date }) {
  const t = stationTile(s, now)
  return (
    <Link href={stationHref(s)} className={`flex flex-col gap-1.5 p-3 rounded-[10px] border min-w-0 hover:border-ink-3 ${t.tone === 'red' ? 'border-red' : 'border-line'}`}>
      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink min-w-0">
        <TagDot color={s.color} /><span className="truncate">{s.name}</span>
      </span>
      <span className="font-mono text-[10.5px] text-ink-3 truncate">{t.who ?? '—'}</span>
      <span className="block h-1 rounded-full bg-bg-2 overflow-hidden">
        <span className={`block h-full ${BAR_TONE[t.tone]}`} style={{ width: `${t.pct}%` }} />
      </span>
      <span className={`font-mono text-[10.5px] font-medium ${STAT_TONE[t.tone]}`}>{t.stat}</span>
    </Link>
  )
}

// ── from last night ────────────────────────────────────────────────────────

type NoteRow = { key: string; where: string; color: string; text: string }

/** The whole-kitchen close note (MANAGER, already only loaded for them) then each station's. */
export function lastNightRows(d: Pick<StartData, 'lastClose' | 'handovers'>, now: Date): NoteRow[] {
  const rows: NoteRow[] = []
  const eod = d.lastClose?.handoverNote?.trim()
  if (d.lastClose && eod) {
    const by = personName(d.lastClose.signedOffByName)
    const at = d.lastClose.signedOffAt ? whenLabel(d.lastClose.signedOffAt, now) : null
    rows.push({ key: 'eod', where: ['WHOLE KITCHEN', by?.toUpperCase(), at].filter(Boolean).join(' · '), color: WHOLE_KITCHEN_DOT, text: eod })
  }
  for (const n of d.handovers) {
    const by = personName(n.byName)?.split(' ')[0]
    rows.push({
      key: `st-${n.stationName}`,
      where: [n.stationName.toUpperCase(), by?.toUpperCase()].filter(Boolean).join(' · '),
      color: n.color,
      text: n.note,
    })
  }
  return rows
}

export function LastNight({ d, now, right, compact = false }: {
  d: StartData
  now: Date
  /** The mono note on the right of the heading. */
  right?: string
  compact?: boolean
}) {
  const rows = lastNightRows(d, now)
  if (rows.length === 0) return null
  return (
    <section aria-label="From last night" className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className={`flex justify-between items-baseline gap-3 border-b border-line ${compact ? 'px-[18px] py-3.5' : 'px-4 py-3'}`}>
        <h2 className="text-[13.5px] font-semibold">From last night</h2>
        <span className="font-mono text-[10.5px] text-ink-3">{right ?? `${rows.length} ${rows.length === 1 ? 'NOTE' : 'NOTES'}`}</span>
      </div>
      {rows.map((r, i) => (
        <div key={r.key} className={`flex flex-col gap-1 ${compact ? 'px-[18px] py-[11px]' : 'px-4 py-3'} ${i > 0 ? 'border-t border-bg-2' : ''}`}>
          <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-3"><TagDot color={r.color} />{r.where}</span>
          <span className={`${compact ? 'text-[13.5px]' : 'text-[14px]'} leading-[1.45] text-ink whitespace-pre-wrap`}>“{r.text}”</span>
        </div>
      ))}
    </section>
  )
}

// ── numbers (MANAGER) ──────────────────────────────────────────────────────

export type NumberRow = { label: string; value: string; tone?: 'bad' | 'ok' | 'muted'; href?: string }

/** Sales, covers, food cost (with its target) and how many items are below par. */
export function numberRows(d: Pick<StartData, 'yesterday' | 'foodCost' | 'hasOrders' | 'low'>, opts: { foodCost: boolean }): NumberRow[] {
  const rows: NumberRow[] = scoreRows(d, formatCurrency)
    .filter(r => r.label !== 'Target' && (opts.foodCost || r.label !== 'Food cost this week'))
    .map(r => (r.label === 'Food cost this week' && d.foodCost && d.foodCost.pct != null
      ? { ...r, value: `${r.value} / ${d.foodCost.target.toFixed(1)}%` }
      : r))
  if (d.hasOrders) {
    const n = d.low.top.length + d.low.more
    rows.push({ label: 'Running low', value: n === 0 ? 'Nothing' : `${n} ${n === 1 ? 'item' : 'items'}`, href: '/inventory' })
  }
  return rows
}

export const VALUE_TONE = (t?: NumberRow['tone']) =>
  t === 'bad' ? 'text-red-text' : t === 'ok' ? 'text-green-text' : t === 'muted' ? 'text-ink-3' : 'text-ink'

// ── report something (LEAD+; the Pass replaced the cook screen for leads) ───

/** The "Report something" button and its sheet. A sent report lands in the list at once. */
export function ReportButton({ d, className = '' }: { d: StartData; className?: string }) {
  const [open, setOpen] = useState(false)
  const sent = () => {
    void d.loadInbox()
    if (d.rcId) void refreshInboxCount(d.rcId)
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`min-h-[44px] px-4 inline-flex items-center gap-2 rounded-full border border-line bg-paper text-[13.5px] font-medium text-ink-2 hover:border-ink-3 ${className}`}
      >
        <Flag size={14} aria-hidden /> Report something
      </button>
      <ReportSheet open={open} onClose={() => setOpen(false)} rcId={d.rcId} onSent={sent} />
    </>
  )
}
