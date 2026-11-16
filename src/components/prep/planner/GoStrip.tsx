'use client'
// Smart Prep — jobs already cooking, on top of Your list. Read only: no
// quantity, no reset, never "won't fit". Tap opens the job's drawer.
import type { PrepItemRich } from '@/components/prep/types'
import { fmtPipelineReady } from '@/lib/prep-plan'

export function readyText(item: PrepItemRich, nowMs: number): string {
  const at = item.pipeline?.readyAt
  if (!at) return 'cooking'
  return new Date(at).getTime() <= nowMs ? 'wait done' : `ready ${fmtPipelineReady(at, nowMs)}`
}

export function GoStrip({ items, nowMs, onOpen }: { items: PrepItemRich[]; nowMs: number; onOpen: (item: PrepItemRich) => void }) {
  if (!items.length) return null
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2.5 bg-gold-soft border-b border-[#fcd34d]">
      <span className="text-[12.5px] font-semibold text-gold-2 whitespace-nowrap">On the go · {items.length}</span>
      {items.map(t => (
        <button key={t.id} type="button" onClick={() => onOpen(t)}
          className="inline-flex items-center gap-2 whitespace-nowrap min-h-[36px] px-3 rounded-full bg-paper border border-[#fcd34d] text-[12.5px] font-semibold text-ink-2">
          {t.name}
          <span className="font-mono text-[11.5px] font-medium text-gold-2">{readyText(t, nowMs)}</span>
        </button>
      ))}
    </div>
  )
}
