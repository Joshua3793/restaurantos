'use client'
import { useEffect } from 'react'

// Mobile bottom sheet — matches the app's pattern (fixed overlay, slide-up
// panel, md:hidden so it never shows on desktop). Locks body scroll while open.
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[60] flex items-end md:hidden" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full bg-paper rounded-t-2xl px-[18px] pb-8 pt-2 shadow-xl animate-[slide-up_.25s_ease] max-h-[94vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="w-9 h-1 bg-line rounded-full mx-auto mb-3" />
        {title && <div className="text-[18px] font-semibold text-ink tracking-[-0.02em] mb-3">{title}</div>}
        {children}
      </div>
    </div>
  )
}
