'use client'
import { TrendingUp, Activity, Zap, ChevronRight } from 'lucide-react'
import { InboxItem, fmtAge, Signal } from '@/lib/invoices/inbox-items'

const ICON = { price: TrendingUp, variance: Activity, signal: Zap } as const

export function InboxSignalCard({ item, onOpen }: { item: InboxItem; onOpen: (item: InboxItem) => void }) {
  const sig = item.raw as Signal
  const Icon = ICON[item.icon as keyof typeof ICON] ?? Zap
  const border = item.tone === 'red' ? '#dc2626' : item.tone === 'gold' ? '#d97706' : '#a1a1aa'
  const iconCls = item.tone === 'red' ? 'text-red-text' : item.tone === 'gold' ? 'text-gold-2' : 'text-ink-3'
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full text-left bg-paper border border-line rounded-xl p-3 flex items-start gap-3 active:bg-bg-2 transition-colors"
      style={{ borderLeftWidth: 3, borderLeftColor: border }}
    >
      <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 bg-bg-2">
        <Icon size={16} className={iconCls} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-ink truncate">{item.title}</div>
        <div className="font-mono text-[10.5px] text-ink-3 truncate mt-0.5">{item.meta}</div>
      </div>
      <div className="text-right shrink-0 flex flex-col items-end">
        {item.impact && <div className={`font-mono text-[14px] font-semibold ${item.tone === 'red' ? 'text-red-text' : 'text-ink-2'}`}>{item.impact}</div>}
        <div className="font-mono text-[9.5px] text-ink-4 mt-0.5 flex items-center gap-1">{fmtAge(sig.createdAt)} ago <ChevronRight size={12} className="text-ink-4" /></div>
      </div>
    </button>
  )
}
