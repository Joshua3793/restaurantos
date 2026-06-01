'use client'
import { X } from 'lucide-react'
import { InboxItem, Signal } from '@/lib/invoices/inbox-items'

export function SignalSheet({ item, onClose, onAct }: {
  item: InboxItem | null
  onClose: () => void
  onAct: (id: string, action: 'apply' | 'snooze' | 'dismiss') => void
}) {
  if (!item || item.kind !== 'signal') return null
  const sig = item.raw as Signal
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:hidden">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="relative z-50 bg-paper w-full rounded-t-2xl max-h-[85dvh] overflow-y-auto pb-safe">
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-line">
          <div className="min-w-0">
            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">{sig.rule.replaceAll('_', ' ')}</div>
            <h2 className="text-[19px] font-semibold text-ink tracking-[-0.02em] leading-tight mt-1">{sig.title}</h2>
          </div>
          <button onClick={onClose} className="w-9 h-9 rounded-full bg-bg-2 grid place-items-center text-ink-3 shrink-0"><X size={16} /></button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {sig.impactValue != null && sig.impactValue > 0 && (
            <div className="bg-ink rounded-xl p-4 flex items-center justify-between">
              <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.06em]">Estimated impact</div>
              <div className="font-mono text-[22px] font-semibold text-gold">{'+$' + Number(sig.impactValue).toFixed(2)}</div>
            </div>
          )}
          <p className="text-[13.5px] text-ink-2 leading-relaxed">{sig.body}</p>
        </div>

        <div className="border-t border-line px-4 py-3 grid grid-cols-3 gap-2 pb-safe">
          <button onClick={() => onAct(sig.id, 'dismiss')} className="py-2.5 rounded-xl text-[13px] font-medium text-ink-3 border border-line active:bg-bg-2">Dismiss</button>
          <button onClick={() => onAct(sig.id, 'snooze')} className="py-2.5 rounded-xl text-[13px] font-medium text-ink-2 border border-line active:bg-bg-2">Snooze</button>
          <button onClick={() => onAct(sig.id, 'apply')} className="py-2.5 rounded-xl text-[13px] font-semibold bg-ink text-paper active:bg-ink-2">Apply</button>
        </div>
      </div>
    </div>
  )
}
