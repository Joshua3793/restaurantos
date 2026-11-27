'use client'
import { useState } from 'react'
import { CloudOff, RotateCcw, Trash2 } from 'lucide-react'
import type { PendingScanSummary } from '@/lib/pending-scans'

const pagesWord = (n: number) => `${n} page${n === 1 ? '' : 's'}`

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** One saved scan, with its own inline "throw away?" confirm (no window.confirm in the app shell). */
function PendingRow({ scan, disabled, onDiscard }: {
  scan: PendingScanSummary
  disabled: boolean
  onDiscard: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="flex items-center gap-2 py-1.5 border-t border-line first:border-t-0">
      <div className="flex-1 min-w-0 font-mono text-[11px] text-ink-3 truncate">
        Scanned {fmtTime(scan.createdAt)} · {pagesWord(scan.pageCount)}
        {scan.stuck && <span className="text-red-text"> · Couldn&apos;t send — Send again or Discard</span>}
        {scan.lastError && scan.lastError !== 'No signal' ? ` · ${scan.lastError}` : ''}
      </div>
      {confirming ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[12px] text-ink-2">Throw away {pagesWord(scan.pageCount)}?</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="font-mono text-[10.5px] px-2 py-1 rounded-full border border-line text-ink-2 active:bg-bg-2"
          >
            Keep
          </button>
          <button
            type="button"
            onClick={() => { setConfirming(false); onDiscard(scan.id) }}
            className="font-mono text-[10.5px] px-2 py-1 rounded-full bg-red-soft text-red-text font-semibold"
          >
            Throw away
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-3 px-2 py-1 rounded-full border border-line active:bg-red-soft active:text-red-text disabled:opacity-40 shrink-0"
        >
          <Trash2 size={11} /> Discard
        </button>
      )}
    </div>
  )
}

/**
 * Scans saved on this phone that have not reached the server yet:
 * "1 invoice waiting to send · 4 pages — Send now / Discard".
 */
export function PendingScansBanner({ pending, sending, progress, onSendNow, onDiscard }: {
  pending: PendingScanSummary[]
  sending: boolean
  progress: string | null
  onSendNow: () => void
  onDiscard: (id: string) => void
}) {
  if (!pending.length) return null
  const pages = pending.reduce((n, p) => n + p.pageCount, 0)
  // Every scan is waiting on a person: nothing will send by itself.
  const allStuck = pending.every(p => p.stuck)
  return (
    <div
      className="mb-3 bg-paper border border-line rounded-xl px-3 py-2.5"
      style={{ borderLeftWidth: 3, borderLeftColor: '#d97706' }}
    >
      <div className="flex items-center gap-2.5">
        <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 bg-gold-soft">
          <CloudOff size={16} className="text-gold-2" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-ink tracking-[-0.01em]">
            {pending.length} {pending.length === 1 ? 'invoice' : 'invoices'} waiting to send · {pagesWord(pages)}
          </div>
          <div className="font-mono text-[10.5px] text-ink-3 mt-0.5">
            {sending ? (progress ?? 'Sending…')
              : allStuck ? 'Couldn\u2019t send — saved on this phone. Send again, or Discard.'
              : 'Saved on this phone — sends by itself when there is signal.'}
          </div>
        </div>
        <button
          type="button"
          disabled={sending}
          onClick={onSendNow}
          className="inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-ink text-paper text-[13px] font-medium active:bg-ink-2 disabled:opacity-60 shrink-0"
        >
          <RotateCcw size={14} className={`text-gold ${sending ? 'animate-spin' : ''}`} />
          {sending ? 'Sending' : allStuck ? 'Send again' : 'Send now'}
        </button>
      </div>
      <div className="mt-2">
        {pending.map(p => <PendingRow key={p.id} scan={p} disabled={sending} onDiscard={onDiscard} />)}
      </div>
    </div>
  )
}
