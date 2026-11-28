'use client'
import { useEffect } from 'react'

export interface WasteToast { id: number; text: string; undoId?: string }

// "Logged 2 kg Goats Cheese — Undo". Sits at the TOP on a phone so neither the
// keyboard nor the log sheet's Save bar covers it; bottom-centre on desktop.
// z-[95]: above the log sheet (z-[90]).
export function UndoToast({
  toast, onUndo, onDismiss, ms = 6000,
}: {
  toast: WasteToast | null
  onUndo: (id: string) => void
  onDismiss: () => void
  ms?: number
}) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDismiss, ms)
    return () => clearTimeout(t)
  }, [toast, onDismiss, ms])

  if (!toast) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed z-[95] left-4 right-4 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] md:left-1/2 md:right-auto md:-translate-x-1/2 md:top-auto md:bottom-6 md:w-auto md:min-w-[340px]"
    >
      <div className="flex items-center gap-3 bg-ink text-paper rounded-xl shadow-2xl pl-4 pr-1.5 py-1.5">
        <span className="flex-1 min-w-0 text-[15px] md:text-sm leading-snug py-2">{toast.text}</span>
        {toast.undoId && (
          <button
            type="button"
            onClick={() => onUndo(toast.undoId!)}
            className="shrink-0 min-h-[44px] md:min-h-[36px] px-4 rounded-lg text-gold font-semibold text-[15px] md:text-sm hover:bg-ink-2"
          >
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
