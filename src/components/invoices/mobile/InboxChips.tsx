'use client'
import { INBOX_CHIPS, ChipId } from '@/lib/invoices/inbox-items'

export function InboxChips({ active, counts, onPick }: {
  active: ChipId
  counts: Record<ChipId, number>
  onPick: (id: ChipId) => void
}) {
  return (
    <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {INBOX_CHIPS.map(chip => {
        const on = active === chip.id
        const n = counts[chip.id] ?? 0
        return (
          <button
            key={chip.id}
            onClick={() => onPick(chip.id)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12.5px] font-medium tracking-[-0.005em] border transition-colors ${
              on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'
            }`}
          >
            {chip.label}
            <span className={`font-mono text-[10px] ${on ? 'text-gold' : 'text-ink-4'}`}>{n}</span>
          </button>
        )
      })}
    </div>
  )
}
