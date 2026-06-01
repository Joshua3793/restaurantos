'use client'
import { FileText, AlertTriangle, ChevronRight } from 'lucide-react'
import { InboxItem, fmtAge } from '@/lib/invoices/inbox-items'
import type { SessionSummary } from '@/components/invoices/types'

const TONE: Record<string, { border: string; iconBg: string; icon: string; badge: string }> = {
  gold: { border: '#d97706', iconBg: 'bg-gold-soft', icon: 'text-gold-2', badge: 'bg-gold-soft text-gold-2' },
  red:  { border: '#dc2626', iconBg: 'bg-red-soft',  icon: 'text-red-text', badge: 'bg-red-soft text-red-text' },
}

export function InboxInvoiceCard({ item, onOpen }: { item: InboxItem; onOpen: (sessionId: string) => void }) {
  const s = item.raw as SessionSummary
  const t = TONE[item.tone] ?? TONE.gold
  return (
    <button
      type="button"
      onClick={() => onOpen(s.id)}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: t.border }}
    >
      <span className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${t.iconBg}`}>
        {item.icon === 'exception' ? <AlertTriangle size={16} className={t.icon} /> : <FileText size={16} className={t.icon} />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
        {item.needsAction && (
          <span className="inline-flex items-center gap-1 mt-2 font-mono text-[10.5px] font-semibold text-gold-2 bg-gold-soft px-2 py-1 rounded-full">
            Review <ChevronRight size={12} />
          </span>
        )}
      </div>
      <div className="text-right shrink-0">
        {item.badge && <span className={`font-mono text-[9px] font-semibold px-1.5 py-0.5 rounded ${t.badge}`}>{item.badge}</span>}
        <div className="font-mono text-[9.5px] text-ink-4 mt-1">{fmtAge(s.createdAt)} ago</div>
      </div>
    </button>
  )
}
