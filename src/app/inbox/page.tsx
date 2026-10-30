'use client'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { InboxList } from '@/components/inbox/InboxList'
import { InboxFilters } from '@/components/inbox/InboxFilters'
import { TagChips } from '@/components/inbox/TagChips'
import { call, type Result } from '@/components/inbox/api'
import { ItemPane, ItemSheet, type ItemDetailProps } from '@/components/inbox/ItemSheet'
import {
  applyFilter, countByTag, peopleOf, placesOf,
  type InboxAction, type InboxDetail, type InboxItem, type InboxList as InboxListData, type InboxView,
} from '@/components/inbox/format'

// /inbox — LEAD+: everything waiting on a manager for the kitchen picked in the
// top bar. One page, both layouts mounted (phone md:hidden, desktop md:grid);
// the item opens as a bottom sheet on the phone and a pane on desktop, from
// the one shared selection below.

const POLL_MS = 30_000

const isPhone = () => typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches

function emptyText(view: InboxView, filtered: boolean): string {
  if (view === 'done') return filtered ? 'Nothing fixed for this pick in the last 14 days.' : 'Nothing fixed in the last 14 days.'
  if (filtered) return 'Nothing open for this tag.'
  if (view === 'snoozed') return 'Nothing is back from a snooze.'
  if (view === 'waiting') return 'Nothing is waiting on someone.'
  return 'Nothing open. All clear.'
}

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">{children}</div>
)

export default function InboxPage() {
  const { activeRcId, activeRc, ready } = useRc()
  const { role } = useUser()
  const toast = useToast()

  const allowed = !role || atLeast(role as Role, 'LEAD')
  const isManager = !!role && atLeast(role as Role, 'MANAGER')

  // ── list + filters ───────────────────────────────────────────────────────
  const [view, setView] = useState<InboxView>('open')
  const status: 'open' | 'done' = view === 'done' ? 'done' : 'open'
  const [tagId, setTagId] = useState<string | null>(null)
  const [place, setPlace] = useState<string | null>(null)
  const [from, setFrom] = useState<{ id: string; name: string } | null>(null)
  const [list, setList] = useState<InboxListData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  // Snoozed / Waiting counts come from the last open list, so they hold while Done is showing.
  const [slices, setSlices] = useState({ snoozed: 0, waiting: 0 })
  // Items opened here: their gold dot goes at once, before the next poll says so.
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set())

  // ── the open item ────────────────────────────────────────────────────────
  // `selected` paints the sheet from the row at once; `detail` adds the history.
  const [selected, setSelected] = useState<InboxItem | null>(null)
  const [detail, setDetail] = useState<InboxDetail | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Only the latest request may land: a slow reply for an older kitchen / tab / poll is dropped.
  const latestKey = useRef({ rc: activeRcId, status })
  latestKey.current = { rc: activeRcId, status }
  const listSeq = useRef(0)
  const detailSeq = useRef(0)
  // The item open right now, for replies that land after the cook moved on.
  const openId = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!activeRcId) return
    const seq = ++listSeq.current
    const r = await call<InboxListData>(`/api/inbox?${new URLSearchParams({ rcId: activeRcId, status })}`)
    if (seq !== listSeq.current || activeRcId !== latestKey.current.rc || status !== latestKey.current.status) return
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setNow(new Date())
    setList(r.data)
    if (status === 'open') {
      setSlices({
        snoozed: r.data.items.filter(i => i.status === 'SNOOZED').length,
        waiting: r.data.items.filter(i => i.status === 'WAITING').length,
      })
    }
  }, [activeRcId, status])

  const closeItem = useCallback(() => {
    detailSeq.current++
    openId.current = null
    setSelected(null)
    setDetail(null)
    setNote('')
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeq.current
    const r = await call<InboxDetail>(`/api/inbox/${id}`)
    if (seq !== detailSeq.current || openId.current !== id) return
    if (!r.ok) {
      toast.show({ type: 'error', title: r.status === 404 ? 'That item is gone.' : r.error })
      if (r.status === 404) { closeItem(); load() }
      return
    }
    setDetail(r.data)
    setSelected(r.data.item)
    setReadIds(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [toast, closeItem, load])

  // A new kitchen: nothing from the old one may stay open or filtered.
  useEffect(() => {
    closeItem()
    setPlace(null)
    setFrom(null)
  }, [activeRcId, closeItem])

  useEffect(() => {
    if (!ready || !allowed) return
    setList(null)
    setLoadError(null)
    if (!activeRcId) return
    load()
    const tick = () => { if (document.visibilityState === 'visible') load() }
    const id = setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [ready, allowed, activeRcId, load])

  const openItem = (item: InboxItem) => {
    if (openId.current === item.id) return
    openId.current = item.id
    setSelected(item)
    setDetail(null)
    setNote('')
    loadDetail(item.id)
  }

  const act = async (action: InboxAction) => {
    const item = selected
    if (!item || busy) return
    const text = note.trim()
    const send = (a: InboxAction) =>
      call<{ item: InboxItem }>(`/api/inbox/${item.id}`, { method: 'PATCH', body: JSON.stringify(a) })

    setBusy(true)
    let r: Result<{ item: InboxItem }>
    let noteSaved = false
    if (text && (action.kind === 'wait' || action.kind === 'done')) {
      // Wait / Mark fixed carry the typed note.
      r = await send({ ...action, note: text })
      noteSaved = r.ok
    } else if (text && (action.kind === 'snooze' || action.kind === 'reopen')) {
      // Snooze / Reopen take no note: save it first, then act.
      r = await send({ kind: 'note', note: text })
      if (r.ok) { noteSaved = true; r = await send(action) }
    } else {
      r = await send(action)
      noteSaved = r.ok && action.kind === 'note'
    }
    if (noteSaved && openId.current === item.id) setNote('')

    if (!r.ok) {
      toast.show({ type: 'error', title: r.error })
    } else if (isPhone() && (action.kind === 'snooze' || action.kind === 'done')) {
      // On the phone the job is finished: back to the list.
      closeItem()
      setBusy(false)
      await load()
      return
    } else if (openId.current === item.id) {
      setSelected(r.data.item)
    }
    // Error or not, show what the server now holds.
    await Promise.all([load(), openId.current === item.id ? loadDetail(item.id) : null])
    setBusy(false)
  }

  // ── derived ──────────────────────────────────────────────────────────────
  const items = list?.items ?? []
  const tags = list?.tags ?? []
  const counts = list?.counts ?? { byTag: {}, open: 0, done: 0 }
  const filter = { view, tagId, place, from: from?.id ?? null }
  const shown = applyFilter(items, filter)
  const filtered = !!(tagId || place || from)
  const isUnread = (i: InboxItem) => i.unread && !readIds.has(i.id)

  // The API's chip counts are open counts; on Done, count the done list itself.
  const tagCounts = status === 'open' ? counts.byTag : countByTag(items)
  const tagTotal = status === 'open' ? counts.open : items.length
  const statusCounts: Record<InboxView, number> = { open: counts.open, done: counts.done, ...slices }

  const places = placesOf(items)
  if (place && !places.includes(place)) places.push(place)
  const people = peopleOf(items)
  if (from && !people.some(p => p.id === from.id)) people.push(from)

  const sev = { NOW: 0, TODAY: 0, FYI: 0 }
  if (status === 'open') for (const i of items) sev[i.severity]++
  const lede: React.ReactNode[] = []
  if (sev.NOW) lede.push(<b key="now" className="font-semibold text-red-text">{sev.NOW} now</b>)
  if (sev.TODAY) lede.push(`${sev.TODAY} today`)
  if (sev.FYI) lede.push(`${sev.FYI} for your info`)

  const detailProps: ItemDetailProps | null = selected && {
    item: selected,
    events: detail?.events ?? [],
    loading: !detail,
    limited: !!detail?.limited,
    tags,
    canRetag: allowed,
    busy,
    note,
    onNote: setNote,
    onAct: act,
    now,
  }

  const gate = !allowed ? <Panel>The Inbox is for leads and managers.</Panel>
    : !ready ? <Panel>Loading…</Panel>
    : !activeRcId ? <Panel>Pick a kitchen in the top bar to see its Inbox.</Panel>
    : !list && !loadError ? <Panel>Loading…</Panel>
    : !list ? (
      <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
        <p className="m-0 text-[14px] text-red-text">{loadError}</p>
        <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
      </div>
    )
    : null

  const manageTags = isManager && (
    <Link href="/inbox/tags" className="self-start font-mono text-[11px] text-gold-2 min-h-[44px] inline-flex items-center">
      Manage tags →
    </Link>
  )

  return (
    <>
      {/* ── Phone ─────────────────────────────────────────────────────── */}
      <div className="md:hidden max-w-[640px] mx-auto w-full flex flex-col gap-3.5">
        <header className="flex items-center justify-between gap-3">
          <Link href="/today" className="text-[13px] text-ink-3 min-h-[44px] inline-flex items-center">
            ‹ {isManager ? 'Pass' : 'Today'}
          </Link>
          <div className="flex bg-bg-2 rounded-full p-[3px]" role="group" aria-label="Open or done">
            {(['open', 'done'] as const).map(s => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setView(s)}
                className={`rounded-full font-mono text-[11px] font-medium px-3.5 min-h-[44px] ${
                  status === s ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'
                }`}
              >
                {s === 'open' ? `Open${list ? ` · ${counts.open}` : ''}` : 'Done'}
              </button>
            ))}
          </div>
        </header>

        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Inbox</h1>
        <p className="m-0 text-[14px] leading-[1.45] text-ink-2">
          Everything waiting on a manager: cooks’ flags and notes, readings, prep, stock, money and the team.
        </p>

        {gate ?? (
          <>
            <TagChips tags={tags} counts={tagCounts} total={tagTotal} tagId={tagId} onPick={setTagId} />
            {manageTags}
            <InboxList
              variant="phone"
              items={shown}
              isUnread={isUnread}
              now={now}
              selectedId={selected?.id ?? null}
              onOpen={openItem}
              empty={emptyText(view, filtered)}
            />
          </>
        )}
      </div>

      {/* ── Desktop ───────────────────────────────────────────────────── */}
      <div className="hidden md:grid gap-5">
        <header className="flex justify-between items-end gap-4">
          <div className="flex flex-col gap-2 min-w-0">
            <div className="font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
              {[isManager ? 'PASS / INBOX' : 'INBOX', activeRc?.name.toUpperCase()].filter(Boolean).join(' · ')}
            </div>
            <h1 className="m-0 text-[36px] leading-none font-semibold tracking-[-0.04em]">Inbox</h1>
            {list && (
              <p className="m-0 text-[15px] text-ink-2">
                {status === 'done' ? (
                  <>{counts.done} fixed in the last 14 days.</>
                ) : lede.length === 0 ? (
                  <>Nothing open. All clear.</>
                ) : (
                  <>{lede.map((part, i) => <Fragment key={i}>{i > 0 && ', '}{part}</Fragment>)}.</>
                )}
              </p>
            )}
          </div>
          {isManager && (
            <Link href="/inbox/tags" className="flex-none font-mono text-[11px] text-gold-2 min-h-[44px] inline-flex items-center">
              Manage tags →
            </Link>
          )}
        </header>

        {gate ?? (
          <div className="grid gap-4 xl:gap-5 items-start grid-cols-[190px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_400px]">
            <div className="col-start-1 row-start-1 row-span-2 xl:row-span-1">
              <InboxFilters
                view={view}
                statusCounts={statusCounts}
                onView={setView}
                tags={tags}
                tagCounts={tagCounts}
                tagTotal={tagTotal}
                tagId={tagId}
                onTag={setTagId}
                places={places}
                place={place}
                onPlace={setPlace}
                people={people}
                from={from?.id ?? null}
                onFrom={id => setFrom(id ? people.find(p => p.id === id) ?? null : null)}
              />
            </div>

            {/* Below xl the pane sits above the list; at xl it is the third column. */}
            <div className={`col-start-2 xl:row-start-1 min-w-0 ${detailProps ? 'row-start-2' : 'row-start-1'}`}>
              <InboxList
                variant="desktop"
                items={shown}
                isUnread={isUnread}
                now={now}
                selectedId={selected?.id ?? null}
                onOpen={openItem}
                empty={emptyText(view, filtered)}
              />
            </div>

            {detailProps ? (
              <div className="col-start-2 row-start-1 xl:col-start-3 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto min-w-0">
                <ItemPane {...detailProps} onClose={closeItem} />
              </div>
            ) : (
              <div className="hidden xl:block col-start-3 row-start-1 border border-dashed border-line-2 rounded-xl p-[18px] font-mono text-[11px] text-ink-3">
                Pick something on the list to see what happened.
              </div>
            )}
          </div>
        )}
      </div>

      {detailProps && <ItemSheet {...detailProps} onClose={closeItem} />}
    </>
  )
}
