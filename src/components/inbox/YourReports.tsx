'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { call } from './api'
import {
  ageLabel, eventText, extraBody, reportState, whenLabel,
  type InboxDetail, type InboxEvent, type InboxItem, type ReportState,
} from './format'
import { TagDot } from './TagChips'

// "Your reports" — what this cook sent in the last 14 days and whether each
// one has been fixed. Tapping a row opens it (which clears the cook's bell).

export type MineItem = InboxItem & { fixedSinceSeen?: boolean }

const PILL_TONE: Record<ReportState, string> = {
  OPEN: 'bg-gold-soft text-gold-2',
  FIXED: 'bg-green-soft text-green-text',
  CLEARED: 'bg-bg-2 text-ink-3',
}
const PILL_TEXT: Record<ReportState, string> = { OPEN: 'OPEN', FIXED: 'FIXED', CLEARED: 'CLEARED' }
const PILL = 'flex-none inline-flex items-center font-mono text-[10px] font-medium tracking-[0.06em] rounded-full px-[9px] py-[3px]'

/** "Fixed by Josh · 9:12", "Cleared · 9:12", or how long ago it was sent. */
function statusLine(item: InboxItem, now: Date): string {
  const state = reportState(item)
  if (state === 'FIXED') {
    const at = item.doneAt ? ` · ${whenLabel(item.doneAt, now)}` : ''
    return `Fixed by ${item.doneByName?.trim()}${at}`
  }
  if (state === 'CLEARED') {
    const at = item.doneAt ?? item.clearedAt
    return `Cleared${at ? ` · ${whenLabel(at, now)}` : ''}`
  }
  return `Sent ${ageLabel(item.createdAt, now)}`
}

function Row({ item, now, fresh, onOpen }: { item: MineItem; now: Date; fresh: boolean; onOpen: () => void }) {
  const state = reportState(item)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full text-left flex flex-col gap-1.5 min-h-[64px] px-3.5 py-3 rounded-xl border border-line bg-paper"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0 text-[15px] font-semibold tracking-[-0.015em] text-ink break-words">{item.title}</span>
        <span className="flex-none flex items-center gap-1.5">
          {fresh && <span className="w-2 h-2 rounded-full bg-gold" aria-label="New" />}
          <span className={`${PILL} ${PILL_TONE[state]}`}>{PILL_TEXT[state]}</span>
        </span>
      </span>
      <span className="flex items-center gap-2 font-mono text-[10.5px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><TagDot color={item.tag.color} />{item.tag.name}</span>
        <span>·</span>
        <span className="min-w-0 truncate">{statusLine(item, now)}</span>
      </span>
    </button>
  )
}

function Detail({ item, events, loading, failed, limited, now, onBack, onRetry }: {
  item: MineItem
  events: InboxEvent[]
  loading: boolean
  failed: boolean
  limited: boolean
  now: Date
  onBack: () => void
  onRetry: () => void
}) {
  const body = extraBody(item)
  const state = reportState(item)
  return (
    <>
      <button type="button" onClick={onBack} className="self-start -ml-1 min-h-[44px] inline-flex items-center gap-0.5 text-[13px] text-ink-3">
        <ChevronLeft size={16} aria-hidden /> Your reports
      </button>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-ink-2 border border-line rounded-full px-[9px] py-[3px]">
            <TagDot color={item.tag.color} />{item.tag.name.toUpperCase()}
          </span>
          <span className={`${PILL} ${PILL_TONE[state]}`}>{PILL_TEXT[state]}</span>
        </div>
        <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em] break-words">{item.title}</h2>
        {body && <p className="m-0 text-[14px] leading-[1.5] text-ink-2 whitespace-pre-line break-words">“{body}”</p>}
        <span className="font-mono text-[10.5px] text-ink-3">
          {[item.place, whenLabel(item.createdAt, now)].filter(Boolean).join(' · ')}
        </span>
        <span className={`font-mono text-[11px] ${state === 'FIXED' ? 'text-green-text' : 'text-ink-3'}`}>{statusLine(item, now)}</span>
      </div>

      {limited ? (
        <p className="m-0 text-[14px] text-ink-3">A manager is looking after this one.</p>
      ) : failed && events.length === 0 ? (
        <div className="border border-line rounded-xl px-3.5 py-1.5 flex items-center justify-between gap-3">
          <span className="font-mono text-[11px] text-red-text">Couldn’t load —</span>
          <button type="button" onClick={onRetry} className="min-h-[44px] px-2 font-mono text-[11px] text-gold-2">Retry</button>
        </div>
      ) : loading && events.length === 0 ? (
        <div className="border border-line rounded-xl px-3.5 py-3 font-mono text-[11px] text-ink-3">Loading…</div>
      ) : events.length > 0 ? (
        <div className="border border-line rounded-xl overflow-hidden">
          <div className="px-3.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-ink-3 border-b border-line">WHAT HAPPENED</div>
          <div className="divide-y divide-bg-2">
            {events.map((e, i) => (
              <div key={`${e.at}-${e.kind}-${i}`} className="grid grid-cols-[minmax(44px,auto)_minmax(0,1fr)] gap-2.5 px-3.5 py-[9px]">
                <span className="font-mono text-[11px] font-semibold text-ink-2 whitespace-nowrap">{whenLabel(e.at, now)}</span>
                <span className="text-[13px] text-ink break-words">{eventText(e, item.source)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}

export function YourReports({ open, onClose, onChanged }: {
  open: boolean
  onClose: () => void
  /** Called after a report was opened (it was marked seen), so counts can refresh. */
  onChanged?: () => void
}) {
  const [items, setItems] = useState<MineItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [selected, setSelected] = useState<MineItem | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [detailFailed, setDetailFailed] = useState(false)
  // Opened here: the "new" dot goes at once.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())
  const seq = useRef(0)
  const openId = useRef<string | null>(null)

  const load = useCallback(async () => {
    const r = await call<{ items: MineItem[] }>('/api/inbox/mine')
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setNow(new Date())
    setItems(r.data.items)
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const mine = ++seq.current
    setDetailFailed(false)
    const r = await call<InboxDetail>(`/api/inbox/${id}`)
    if (mine !== seq.current || openId.current !== id) return
    if (!r.ok) {
      if (r.status === 404) { openId.current = null; setSelected(null); setDetail(null); load() } else setDetailFailed(true)
      return
    }
    setDetail(r.data)
    setSelected(cur => (cur ? { ...cur, ...r.data.item } : cur))
    setSeen(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
    onChanged?.()
  }, [load, onChanged])

  useEffect(() => {
    if (!open) return
    setSelected(null)
    setDetail(null)
    openId.current = null
    seq.current++
    load()
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const openRow = (item: MineItem) => {
    openId.current = item.id
    setSelected(item)
    setDetail(null)
    loadDetail(item.id)
  }
  const back = () => {
    seq.current++
    openId.current = null
    setSelected(null)
    setDetail(null)
    setDetailFailed(false)
    load()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Your reports"
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-3.5 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2" />
        {selected ? (
          <Detail
            item={selected}
            events={detail?.events ?? []}
            loading={!detail}
            failed={detailFailed}
            limited={!!detail?.limited}
            now={now}
            onBack={back}
            onRetry={() => loadDetail(selected.id)}
          />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">Your reports</h2>
              <p className="m-0 text-[14px] leading-[1.45] text-ink-3">What you sent the managers in the last 14 days.</p>
            </div>
            {loadError && !items ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-[14px] text-red-text">{loadError}</p>
                <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
              </div>
            ) : !items ? (
              <div className="border border-line rounded-xl px-3.5 py-3 font-mono text-[11px] text-ink-3">Loading…</div>
            ) : items.length === 0 ? (
              <p className="m-0 text-[14px] text-ink-3">You haven’t sent anything in the last 14 days.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map(i => (
                  <Row key={i.id} item={i} now={now} fresh={!!i.fixedSinceSeen && !seen.has(i.id)} onOpen={() => openRow(i)} />
                ))}
              </div>
            )}
          </>
        )}
        <button type="button" onClick={onClose} className="min-h-[50px] rounded-xl border border-line-2 bg-paper text-[14px] font-medium text-ink-2">
          Close
        </button>
      </section>
    </div>
  )
}
