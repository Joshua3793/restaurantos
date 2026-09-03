'use client'
import { FileText, AlertTriangle, ChevronRight, Layers, Trash2 } from 'lucide-react'
import { InboxItem, fmtAge } from '@/lib/invoices/inbox-items'
import type { SessionSummary } from '@/components/invoices/types'

const TONE: Record<string, { border: string; iconBg: string; icon: string; badge: string; cta: string }> = {
  gold: { border: '#d97706', iconBg: 'bg-gold-soft', icon: 'text-gold-2',    badge: 'bg-gold-soft text-gold-2',    cta: 'text-gold-2 bg-gold-soft' },
  red:  { border: '#dc2626', iconBg: 'bg-red-soft',  icon: 'text-red-text',  badge: 'bg-red-soft text-red-text',   cta: 'text-red-text bg-red-soft' },
  // A batch is not money waiting for approval — it never competes with the gold rows.
  blue: { border: '#2563eb', iconBg: 'bg-blue-soft', icon: 'text-blue-text', badge: 'bg-blue-soft text-blue-text', cta: 'text-blue-text bg-blue-soft' },
}

export function InboxInvoiceCard({ item, onOpen, onDiscardBatch }: {
  item: InboxItem
  onOpen: (sessionId: string) => void
  /** Present when the viewer may throw an unsorted batch away from the card. */
  onDiscardBatch?: (sessionId: string) => void
}) {
  const s = item.raw as SessionSummary
  const t = TONE[item.tone] ?? TONE.gold
  const isBatch = item.kind === 'batch'
  const actionLabel = isBatch ? 'Sort photos' : 'Review'
  const Icon = item.icon === 'exception' ? AlertTriangle : item.icon === 'batch' ? Layers : FileText
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(s.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onOpen(s.id) }}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: t.border }}
    >
      <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${t.iconBg}`}>
        <Icon size={16} className={t.icon} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
        {item.needsAction && (
          <div className="flex items-center gap-2 mt-2">
            <span className={`inline-flex items-center gap-1 font-mono text-[10.5px] font-semibold px-2 py-1 rounded-full ${t.cta}`}>
              {actionLabel} <ChevronRight size={12} />
            </span>
            {isBatch && onDiscardBatch && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onDiscardBatch(s.id) }}
                className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-3 px-2 py-1 rounded-full border border-line active:bg-red-soft active:text-red-text"
                aria-label="Discard this batch"
              >
                <Trash2 size={11} /> Discard
              </button>
            )}
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
