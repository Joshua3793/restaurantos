'use client'
import { useEffect, useState } from 'react'
import { FileText, AlertTriangle, ChevronRight, Layers, Trash2, RotateCcw, Loader2 } from 'lucide-react'
import { InboxItem, fmtAge, canDiscardFromInbox, isStillReading, UPLOAD_NEVER_FINISHED, STILL_READING_NOTE } from '@/lib/invoices/inbox-items'
import type { SessionSummary } from '@/components/invoices/types'

const TONE: Record<string, { border: string; iconBg: string; icon: string; badge: string; cta: string }> = {
  gold: { border: '#d97706', iconBg: 'bg-gold-soft', icon: 'text-gold-2',    badge: 'bg-gold-soft text-gold-2',    cta: 'text-gold-2 bg-gold-soft' },
  red:  { border: '#dc2626', iconBg: 'bg-red-soft',  icon: 'text-red-text',  badge: 'bg-red-soft text-red-text',   cta: 'text-red-text bg-red-soft' },
  // A batch is not money waiting for approval — it never competes with the gold rows.
  blue: { border: '#2563eb', iconBg: 'bg-blue-soft', icon: 'text-blue-text', badge: 'bg-blue-soft text-blue-text', cta: 'text-blue-text bg-blue-soft' },
}

export function InboxInvoiceCard({ item, onOpen, onDiscardBatch, onRetry }: {
  item: InboxItem
  onOpen: (sessionId: string) => void
  /** Present when the viewer may throw an unscanned session (a batch, a failed
   *  or dead upload) away from the card. */
  onDiscardBatch?: (sessionId: string) => void
  /** Run a failed scan through OCR again — the "Retry" chip calls it. */
  onRetry?: (sessionId: string) => void
}) {
  const s = item.raw as SessionSummary
  const t = TONE[item.tone] ?? TONE.gold
  const isBatch = item.kind === 'batch'
  const discardable = !!onDiscardBatch && canDiscardFromInbox(s)
  // An upload whose photos never arrived has nothing to open or retry.
  const isDeadUpload = (s.status === 'UPLOADING' || s.status === 'ERROR') && s.files.length === 0
  // Still being read: no lines yet, so a tap explains instead of opening an
  // empty review with an Approve button.
  const reading = !isDeadUpload && isStillReading(s)
  const [note, setNote] = useState(false)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(false), 3000)
    return () => clearTimeout(t)
  }, [note])
  const open = () => {
    if (isDeadUpload) return
    if (reading) { setNote(true); return }
    onOpen(s.id)
  }
  const actionLabel = isBatch ? 'Sort photos' : s.status === 'ERROR' ? 'Retry' : 'Review'
  // A failed scan with its photos: the chip retries in place, as on desktop.
  const canRetry = !!onRetry && !isBatch && s.status === 'ERROR' && !isDeadUpload
  const discardButton = discardable ? (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); onDiscardBatch!(s.id) }}
      className="inline-flex items-center gap-1.5 font-mono text-[11.5px] text-ink-3 px-3.5 min-h-[44px] rounded-full border border-line active:bg-red-soft active:text-red-text md:min-h-0 md:px-2 md:py-1 md:text-[10.5px] md:gap-1"
      aria-label={isBatch ? 'Discard this batch' : 'Delete this upload'}
    >
      <Trash2 size={13} /> {isBatch ? 'Discard' : 'Delete'}
    </button>
  ) : null
  const Icon = reading ? Loader2 : item.icon === 'exception' ? AlertTriangle : item.icon === 'batch' ? Layers : FileText
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') open() }}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: t.border }}
    >
      <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${t.iconBg}`}>
        <Icon size={16} className={`${t.icon} ${reading ? 'animate-spin' : ''}`} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
        {reading && note && (
          <div className="text-[12px] text-ink-2 mt-1" role="status">{STILL_READING_NOTE}</div>
        )}
        {isDeadUpload && discardable && (
          <div className="font-mono text-[10.5px] text-red-text mt-0.5">{UPLOAD_NEVER_FINISHED}</div>
        )}
        {((item.needsAction && !isDeadUpload) || canRetry || discardButton) && (
          <div className="flex items-center gap-2 mt-2">
            {canRetry ? (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onRetry!(s.id) }}
                className={`inline-flex items-center gap-1.5 font-mono text-[11.5px] font-semibold px-3.5 min-h-[44px] rounded-full md:min-h-0 md:px-2 md:py-1 md:text-[10.5px] md:gap-1 ${t.cta}`}
              >
                <RotateCcw size={13} /> Retry
              </button>
            ) : item.needsAction && !isDeadUpload && (
              <span className={`inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold px-2 py-1 rounded-full ${t.cta}`}>
                {actionLabel} <ChevronRight size={12} />
              </span>
            )}
            {discardButton}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        {item.badge && <span className={`font-mono text-[9px] font-semibold px-1.5 py-0.5 rounded ${t.badge}`}>{item.badge}</span>}
        <div className="font-mono text-[9.5px] text-ink-4 mt-1">{fmtAge(s.createdAt)} ago</div>
      </div>
    </div>
  )
}
