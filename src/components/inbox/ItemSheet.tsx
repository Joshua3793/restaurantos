'use client'
import { useEffect } from 'react'
import Link from 'next/link'
import { Check, X } from 'lucide-react'
import type { TagLite } from '@/lib/inbox/rules'
import {
  SEVERITY_PILL, eventBy, eventText, extraBody, goToLabel, whenLabel,
  type InboxAction, type InboxEvent, type InboxItem,
} from './format'
import { TagDot } from './TagChips'

// One Inbox item: tag (retag) + severity, what it is, what happened, a note,
// and what to do about it. The same content is the phone's bottom sheet and
// the desktop's detail pane.

export const NOTE_MAX = 500

export type ItemDetailProps = {
  item: InboxItem
  events: InboxEvent[]
  /** Still fetching the history (the row's own data shows meanwhile). */
  loading: boolean
  /** The viewer raised it but it has since moved somewhere only a manager sees. */
  limited: boolean
  tags: TagLite[]
  canRetag: boolean
  busy: boolean
  note: string
  onNote: (note: string) => void
  /** The page adds the typed note: Wait / Mark fixed carry it, Snooze / Reopen save it first. */
  onAct: (action: InboxAction) => void
  now: Date
}

const PILL = 'inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] rounded-full px-[9px] py-[3px]'

function TagPill({ item, tags, canRetag, busy, onAct }: Pick<ItemDetailProps, 'item' | 'tags' | 'canRetag' | 'busy' | 'onAct'>) {
  const face = (
    <span className={`${PILL} text-ink-2 border border-line`}>
      <TagDot color={item.tag.color} />
      {item.tag.name.toUpperCase()}{canRetag ? ' ▾' : ''}
    </span>
  )
  if (!canRetag) return face
  // The current tag may be one this viewer cannot pick (archived): show it, disabled.
  const known = tags.some(t => t.id === item.tagId)
  return (
    <label className="relative inline-flex items-center min-h-[44px] -my-2.5">
      {face}
      <select
        aria-label="Move to another tag"
        value={item.tagId}
        disabled={busy}
        onChange={e => { if (e.target.value !== item.tagId) onAct({ kind: 'retag', tagId: e.target.value }) }}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
      >
        {!known && <option value={item.tagId} disabled>{item.tag.name}</option>}
        {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  )
}

function Timeline({ events, source, now, compact }: { events: InboxEvent[]; source: InboxItem['source']; now: Date; compact: boolean }) {
  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <div className="px-3.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-ink-3 border-b border-line">WHAT HAPPENED</div>
      {events.map((e, i) => {
        const by = eventBy(e)
        return (
          <div key={`${e.at}-${e.kind}-${i}`} className="grid grid-cols-[minmax(44px,auto)_minmax(0,1fr)] gap-2.5 px-3.5 py-[9px] border-t border-bg-2 first-of-type:border-t-0">
            <span className="font-mono text-[11px] font-semibold text-ink-2 whitespace-nowrap">{whenLabel(e.at, now)}</span>
            <span className={`${compact ? 'text-[13px]' : 'text-[13.5px]'} text-ink break-words`}>
              {eventText(e, source)}
              {by && <span className="font-mono text-[10.5px] text-ink-3"> · {by}</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function ItemDetail(p: ItemDetailProps & { variant: 'sheet' | 'pane' }) {
  const { item, events, loading, limited, now, variant } = p
  const pane = variant === 'pane'
  const body = extraBody(item)
  const done = item.status === 'DONE'
  const origin = [item.raisedByName, item.place, whenLabel(item.createdAt, now)].filter(Boolean).join(' · ')
  const noteText = p.note.trim()
  const btn = pane ? 'min-h-[44px] rounded-[9px] text-[13px]' : 'min-h-[50px] rounded-xl text-[14px]'

  return (
    <>
      <div className={`flex flex-col gap-2 ${pane ? 'pr-8' : ''}`}>
        <div className="flex flex-wrap gap-1.5 items-center">
          <TagPill item={item} tags={p.tags} canRetag={p.canRetag && !limited} busy={p.busy} onAct={p.onAct} />
          <span className={`${PILL} font-medium ${SEVERITY_PILL[item.severity]}`}>{item.severity}</span>
          {item.status === 'WAITING' && <span className={`${PILL} font-medium bg-bg-2 text-ink-2`}>WAITING</span>}
        </div>
        <h2 className="m-0 text-[20px] leading-[1.2] font-semibold tracking-[-0.03em]">{item.title}</h2>
        {body && (
          <p className="m-0 text-[14px] leading-[1.5] text-ink-2 whitespace-pre-line break-words">
            {item.source === 'REPORT' ? `“${body}”` : body}
          </p>
        )}
        {origin && <span className="font-mono text-[10.5px] text-ink-3">{origin}</span>}
        {done && (
          <span className="font-mono text-[11px] text-green-text">
            {item.doneByName ? `FIXED BY ${item.doneByName.toUpperCase()}` : item.clearedAt ? 'CLEARED ITSELF' : 'FIXED'}
            {(item.doneAt ?? item.clearedAt) ? ` · ${whenLabel(item.doneAt ?? item.clearedAt, now)}` : ''}
          </span>
        )}
        {item.href && !limited && (
          <Link href={item.href} className="self-start font-mono text-[11px] text-gold-2 min-h-[44px] -my-2.5 inline-flex items-center">
            {goToLabel(item.href)} →
          </Link>
        )}
      </div>

      {limited ? (
        <p className="m-0 text-[14px] text-ink-3">A manager is looking after this one.</p>
      ) : (
        <>
          {loading && events.length === 0 ? (
            <div className="border border-line rounded-xl px-3.5 py-3 font-mono text-[11px] text-ink-3">Loading…</div>
          ) : events.length > 0 ? (
            <Timeline events={events} source={item.source} now={now} compact={pane} />
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3">ADD A NOTE (OPTIONAL)</span>
            <textarea
              rows={2}
              maxLength={NOTE_MAX}
              value={p.note}
              onChange={e => p.onNote(e.target.value)}
              className="border border-line-2 rounded-[9px] px-3 py-2.5 text-[14px] leading-[1.45] text-ink resize-none bg-paper"
            />
          </label>
          {noteText && (
            <button
              type="button"
              disabled={p.busy}
              onClick={() => p.onAct({ kind: 'note', note: noteText })}
              className="self-end -mt-2 min-h-[44px] px-3 font-mono text-[11px] text-gold-2 disabled:opacity-50"
            >
              Save note →
            </button>
          )}

          <div className="flex-1" />
          {done ? (
            <button
              type="button"
              disabled={p.busy}
              onClick={() => p.onAct({ kind: 'reopen' })}
              className={`${btn} border border-line-2 bg-paper font-medium text-ink-2 disabled:opacity-50`}
            >
              Reopen
            </button>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={p.busy}
                  onClick={() => p.onAct({ kind: 'snooze' })}
                  className={`${btn} border border-line-2 bg-paper font-medium text-ink-2 disabled:opacity-50`}
                >
                  Snooze till tomorrow
                </button>
                <button
                  type="button"
                  disabled={p.busy || (item.status === 'WAITING' && !noteText)}
                  aria-pressed={item.status === 'WAITING'}
                  onClick={() => p.onAct({ kind: 'wait' })}
                  className={`${btn} border font-medium disabled:opacity-50 ${
                    item.status === 'WAITING' ? 'border-ink bg-bg-2 text-ink' : 'border-line-2 bg-paper text-ink-2'
                  }`}
                >
                  Waiting on someone
                </button>
              </div>
              <button
                type="button"
                disabled={p.busy}
                onClick={() => p.onAct({ kind: 'done' })}
                className={`${btn} ${pane ? 'min-h-[46px]' : ''} bg-ink text-paper font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-60`}
              >
                Mark fixed <Check size={16} strokeWidth={3} className="text-gold" aria-hidden />
              </button>
              {item.source === 'REPORT' && item.raisedByName && (
                <span className="text-center font-mono text-[10.5px] text-ink-3">
                  {item.raisedByName.toUpperCase()} SEES IT’S FIXED ON THEIR PHONE
                </span>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}

/** Phone: the item as a bottom sheet over the list. */
export function ItemSheet({ onClose, ...p }: ItemDetailProps & { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:hidden" role="presentation">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={p.item.title}
        className="relative w-full max-w-[480px] bg-paper rounded-t-[22px] px-4 pt-2.5 pb-[calc(20px+env(safe-area-inset-bottom))] flex flex-col gap-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="self-center w-10 h-1 rounded-full bg-line-2" />
        <ItemDetail {...p} variant="sheet" />
      </section>
    </div>
  )
}

/** Desktop: the item inline, beside the list. */
export function ItemPane({ onClose, ...p }: ItemDetailProps & { onClose: () => void }) {
  return (
    <section aria-label="Selected item" className="relative bg-paper border border-line rounded-xl p-[18px] flex flex-col gap-3.5">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-2 right-2 w-11 h-11 grid place-items-center rounded-lg text-ink-3 hover:bg-bg-2"
      >
        <X size={16} aria-hidden />
      </button>
      <ItemDetail {...p} variant="pane" />
    </section>
  )
}
