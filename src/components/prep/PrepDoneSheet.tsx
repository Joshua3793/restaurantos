'use client'
/**
 * PrepDoneSheet — lightweight mobile bottom sheet that captures the actual yield
 * when a chef marks an in-progress prep done straight from the compact row. It is
 * the one-tap shortcut for the drawer's "How much did you make?" prompt: opening it
 * pre-fills the suggested qty (editable, Enter submits) and confirming logs DONE.
 * Rendered only while an item is set; triggered from PrepTaskRowCompact's "Mark done".
 */
import { useEffect, useState } from 'react'
import { IcCheck, IcX } from '@/components/prep/icons'
import { PrepItemRich } from '@/components/prep/types'

interface Props {
  item: PrepItemRich | null
  onClose: () => void
  onConfirm: (item: PrepItemRich, qty: number) => void
}

export default function PrepDoneSheet({ item, onClose, onConfirm }: Props) {
  const [value, setValue] = useState('')

  // Pre-fill with the suggested qty each time a new item opens the sheet.
  useEffect(() => {
    if (item) setValue(item.suggestedQty ? String(item.suggestedQty) : '')
  }, [item?.id])

  // Escape closes the sheet.
  useEffect(() => {
    if (!item) return
    function handle(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [item, onClose])

  if (!item) return null

  const submit = () => {
    const v = parseFloat(value)
    if (!v || v <= 0) return
    onConfirm(item, v)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center md:justify-center md:p-6">
      {/* Plain dim overlay — NO backdrop-blur. A full-viewport `backdrop-filter: blur()`
          over the large prep page (which has a continuously-spinning in-progress loader
          and an always-mounted nav backdrop-filter behind it) forces the browser to
          re-blur the whole page every frame — that froze the app on weaker laptops.
          See the same fix in RecipeCookAlongModal. A dim overlay is GPU-cheap. */}
      <div onClick={onClose} className="fixed inset-0 z-40 bg-[rgba(9,9,11,0.6)]" aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Mark prep done"
        className="relative z-50 bg-paper w-full rounded-t-2xl border-t border-line px-[22px] pt-4 shadow-2xl md:w-[420px] md:rounded-2xl md:border md:pb-5"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
      >
        <div className="flex items-start gap-3 mb-4">
          <span className="w-8 h-8 rounded-[9px] bg-green text-white grid place-items-center shrink-0">
            <IcCheck size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[16px] font-semibold tracking-[-0.02em] leading-tight truncate">{item.name}</div>
            <div className="font-mono text-[11px] text-ink-3 mt-0.5">Planned {item.suggestedQty} {item.unit}</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-line grid place-items-center text-ink-2 shrink-0"
          >
            <IcX size={15} />
          </button>
        </div>

        <label className="font-mono text-[10px] uppercase tracking-[0.03em] text-ink-3">
          How much did you make ({item.unit})
        </label>
        <div className="flex gap-[7px] mt-1.5">
          <input
            type="number"
            inputMode="decimal"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            placeholder="e.g. 6.5"
            className="flex-1 min-w-0 border border-line-2 rounded-[9px] px-3 py-3 text-base font-mono outline-none focus:border-ink-3"
          />
          <button
            type="button"
            onClick={submit}
            className="bg-green text-white px-5 rounded-[9px] text-[14px] font-semibold whitespace-nowrap inline-flex items-center gap-2"
          >
            <IcCheck size={16} />
            Mark done
          </button>
        </div>
      </div>
    </div>
  )
}
