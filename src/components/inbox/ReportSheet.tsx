'use client'
import { useEffect, useRef, useState } from 'react'
import type { TagLite } from '@/lib/inbox/rules'
import { useToast } from '@/components/Toast'
import { defaultPhase } from '@/lib/checklists/rules'
import { call } from './api'
import { TagDot } from './TagChips'

// "Report something" — any cook sends the managers a tagged note. A bottom
// sheet on the phone, centred at 480 px on a desktop. Mockup: ReportSheet.

const TEXT_MIN = 3
const TEXT_MAX = 500
const NOT_SURE = ''
/** Places that are not a station but are worth naming. */
const FIXED_PLACES = ['Walk-in', 'Dry store', 'Dish pit', 'Front of house']

const LABEL = 'font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3'

type StationLite = { name: string; isShared: boolean }

export type ReportSheetProps = {
  open: boolean
  onClose: () => void
  /** The kitchen the report goes to; null shows "Pick a kitchen in the top bar first." */
  rcId: string | null
  /** The cook's current station: pre-selected in Where. */
  defaultPlace?: string | null
  /** Called after a report was sent (a page reloads its list from it). */
  onSent?: () => void
}

/** The Where options: stations first, then the fixed places, each name once. */
function placeOptions(stations: string[], extra: string | null | undefined): string[] {
  const out: string[] = []
  const add = (n: string) => {
    const name = n.trim()
    if (name && !out.some(o => o.toLowerCase() === name.toLowerCase())) out.push(name)
  }
  stations.forEach(add)
  FIXED_PLACES.forEach(add)
  if (extra) add(extra)
  return out
}

export function ReportSheet({ open, onClose, rcId, defaultPlace, onSent }: ReportSheetProps) {
  const toast = useToast()
  const [tags, setTags] = useState<TagLite[] | null>(null)
  const [tagsFailed, setTagsFailed] = useState(false)
  const [tagId, setTagId] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [place, setPlace] = useState(NOT_SURE)
  const [urgent, setUrgent] = useState(false)
  const [stations, setStations] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  // A double tap must not send twice.
  const sendLock = useRef(false)
  const [loadTick, setLoadTick] = useState(0)

  // Opening starts a clean report.
  useEffect(() => {
    if (!open) return
    setText('')
    setUrgent(false)
    setPlace(defaultPlace?.trim() || NOT_SURE)
    setSending(false)
    sendLock.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // The tags this person may pick (first one pre-selected).
  useEffect(() => {
    if (!open) return
    let stale = false
    setTagsFailed(false)
    call<{ tags: TagLite[] }>('/api/inbox/tags').then(r => {
      if (stale) return
      if (!r.ok) { setTagsFailed(true); return }
      setTags(r.data.tags)
      setTagId(cur => (cur && r.data.tags.some(t => t.id === cur) ? cur : r.data.tags[0]?.id ?? null))
    })
    return () => { stale = true }
  }, [open, loadTick])

  // The kitchen's stations for Where; a failure only leaves the fixed places.
  useEffect(() => {
    if (!open || !rcId) { setStations([]); return }
    let stale = false
    call<{ stations: StationLite[] }>(`/api/checklists?${new URLSearchParams({ rcId, phase: defaultPhase() })}`).then(r => {
      if (stale) return
      setStations(r.ok ? (r.data.stations ?? []).filter(s => !s.isShared).map(s => s.name) : [])
    })
    return () => { stale = true }
  }, [open, rcId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const options = placeOptions(stations, defaultPlace)
  // Match the pick to an option regardless of case; anything else reads "Not sure".
  const placeValue = options.find(o => o.toLowerCase() === place.toLowerCase()) ?? NOT_SURE
  const ready = !!rcId && !!tagId && text.trim().length >= TEXT_MIN && !sending

  const send = async () => {
    if (sendLock.current || !ready || !rcId || !tagId) return
    sendLock.current = true
    setSending(true)
    const r = await call<unknown>('/api/inbox/report', {
      method: 'POST',
      body: JSON.stringify({ rcId, tagId, text: text.trim(), place: placeValue || undefined, urgent }),
    })
    if (!r.ok) {
      toast.show({ type: 'error', title: r.error })
      sendLock.current = false
      setSending(false)
      return
    }
    toast.show({ type: 'success', title: 'Sent — you’ll see here when it’s fixed' })
    onSent?.()
    onClose()
    setText('')
    setUrgent(false)
    sendLock.current = false
    setSending(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Report something"
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2" />
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">Report something</h2>
          <p className="m-0 text-[14px] leading-[1.45] text-ink-3">Anything a manager should know — not tied to a job on your list.</p>
        </div>

        {!rcId && <p className="m-0 text-[14px] text-red-text">Pick a kitchen in the top bar first.</p>}

        <fieldset className="border-0 m-0 p-0 flex flex-col gap-2">
          <legend className={`${LABEL} p-0 mb-2`}>WHAT KIND</legend>
          {tagsFailed && !tags ? (
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-red-text">Couldn’t load the tags.</span>
              <button type="button" onClick={() => setLoadTick(n => n + 1)} className="min-h-[44px] px-2 font-mono text-[11px] text-gold-2">Retry</button>
            </div>
          ) : !tags ? (
            <span className="font-mono text-[11px] text-ink-3">Loading…</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tags.map(t => {
                const on = tagId === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTagId(t.id)}
                    className={`flex items-center gap-1.5 min-h-[44px] px-3.5 rounded-full text-[13.5px] font-medium border ${
                      on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'
                    }`}
                  >
                    <TagDot color={t.color} />
                    {t.name}
                  </button>
                )
              })}
            </div>
          )}
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>WHAT’S GOING ON</span>
          <textarea
            rows={3}
            maxLength={TEXT_MAX}
            value={text}
            onChange={e => setText(e.target.value)}
            className="border border-line-2 rounded-[9px] px-3 py-2.5 text-[15px] leading-[1.45] text-ink resize-none bg-paper"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>WHERE</span>
          <select
            value={placeValue}
            onChange={e => setPlace(e.target.value)}
            className="min-h-[48px] rounded-xl border border-line-2 bg-paper px-3 text-[14px] text-ink-2"
          >
            <option value={NOT_SURE}>Not sure</option>
            {options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-3 border border-line rounded-xl px-3.5 py-3">
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[14.5px] font-semibold">Urgent — needs someone now</span>
            <span className="text-[12.5px] text-ink-3">Puts it at the top of the manager’s Pass</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={urgent}
            aria-label="Urgent"
            onClick={() => setUrgent(u => !u)}
            className="flex-none w-[52px] h-[44px] grid place-items-center"
          >
            <span className={`relative block w-[52px] h-8 rounded-full transition-colors ${urgent ? 'bg-green' : 'bg-line-2'}`}>
              <span className={`absolute top-[3px] w-[26px] h-[26px] rounded-full bg-paper transition-all ${urgent ? 'right-[3px]' : 'left-[3px]'}`} />
            </span>
          </button>
        </div>

        <button
          type="button"
          disabled={!ready}
          onClick={send}
          className="min-h-[50px] rounded-xl bg-ink text-paper text-[14px] font-medium disabled:bg-bg-2 disabled:text-ink-3"
        >
          {sending ? 'Sending…' : <>Send to the managers <span className="text-gold">→</span></>}
        </button>
        <span className="text-center font-mono text-[10.5px] text-ink-3">YOU’LL SEE IT HERE WHEN IT’S FIXED</span>
      </section>
    </div>
  )
}
