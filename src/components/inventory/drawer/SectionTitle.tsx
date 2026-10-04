'use client'
import type { ReactNode } from 'react'

/** A drawer section's small heading, with an optional note on the right. */
export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="font-mono text-[10.5px] font-semibold text-ink-3 uppercase tracking-[0.04em]">{children}</div>
      {aside && <div className="text-[11px] text-ink-4">{aside}</div>}
    </div>
  )
}
