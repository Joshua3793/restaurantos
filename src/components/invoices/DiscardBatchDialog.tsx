'use client'
import { Trash2, Loader2 } from 'lucide-react'

// One confirm for "throw this batch away", used from the sorter's ⋯ menu, the
// desktop queue row and the mobile inbox card. Bottom sheet on phones,
// centred dialog from sm: up. z-[80] sits above the sorter (z-50) and its
// photo viewer (z-[60]).
export function DiscardBatchDialog({ photoCount, noun = 'photos', onCancel, onConfirm, busy }: {
  photoCount: number
  noun?: string
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center sm:justify-center bg-black/40" onClick={busy ? undefined : onCancel}>
      <div
        className="bg-paper border border-line w-full sm:max-w-sm sm:mx-4 rounded-t-2xl sm:rounded-[14px] p-6 shadow-2xl"
        style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-[9px] grid place-items-center shrink-0 bg-red-soft text-red-text">
            <Trash2 size={15} />
          </div>
          <div className="flex-1">
            <h3 className="text-[16px] font-semibold text-ink tracking-[-0.015em]">Discard this batch?</h3>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 mt-0.5">This cannot be undone</p>
          </div>
        </div>
        <p className="text-[13px] text-ink-2 leading-[1.5] mb-4">
          This deletes {photoCount} {noun}. Nothing has been scanned, so no invoice, price or stock is affected.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 border border-line bg-paper text-ink-2 rounded-[9px] py-2.5 text-[13px] font-medium hover:border-ink-4 disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 bg-red text-white rounded-[9px] py-2.5 text-[13px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Discard batch
          </button>
        </div>
      </div>
    </div>
  )
}
