'use client'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

// Shared mobile UI primitives — thin wrappers over the existing Tailwind tokens
// (bg / paper / ink / line / gold). Keeps every mobile screen short + consistent.
// All are mobile-only surfaces; pages mount them inside a md:hidden block.

// Full-height scroll surface that clears the top RC bar and bottom tab bar.
export function MScreen({ children }: { children: ReactNode }) {
  return (
    <div className="md:hidden min-h-screen bg-bg text-ink px-4 pb-28">
      {children}
    </div>
  )
}

export function MPageHead({ title, eyebrow, right }: { title: string; eyebrow?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 pt-2 pb-3.5">
      <div className="min-w-0">
        {eyebrow && <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mb-1.5">{eyebrow}</div>}
        <h1 className="m-0 text-[30px] font-semibold tracking-[-0.035em] leading-none">{title}</h1>
      </div>
      {right}
    </div>
  )
}

export function MCard({ children, accent, onClick, className = '' }: { children: ReactNode; accent?: string; onClick?: () => void; className?: string }) {
  return (
    <div
      onClick={onClick}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
      className={`bg-paper border border-line rounded-xl p-3.5 ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

export function MSectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em] mt-[18px] mb-2">
      <span>{children}</span>
      {right && <span className="text-gold-2">{right}</span>}
    </div>
  )
}

export function MProgressBar({ pct, tone }: { pct: number; tone?: 'warn' | 'bad' | 'ok' }) {
  const col = tone === 'bad' ? 'bg-red' : tone === 'warn' ? 'bg-gold' : tone === 'ok' ? 'bg-green' : 'bg-ink'
  return (
    <div className="h-[5px] rounded-full bg-bg-2 overflow-hidden">
      <div className={`h-full rounded-full ${col}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  )
}

export function MQuickAction({ label, icon, badge, onClick }: { label: string; icon: ReactNode; badge?: number; onClick: () => void }) {
  return (
    <button onClick={onClick} className="relative flex flex-col items-start gap-2 bg-paper border border-line rounded-xl p-3.5 text-left">
      <span className="grid place-items-center w-9 h-9 rounded-[10px] bg-ink text-gold">{icon}</span>
      <span className="text-[14px] font-semibold tracking-[-0.01em]">{label}</span>
      {badge ? <span className="absolute top-2.5 right-2.5 font-mono text-[9px] font-bold bg-gold text-ink rounded-full px-1.5 leading-[14px]">{badge}</span> : null}
    </button>
  )
}

export function MRowChevron() {
  return <ChevronRight size={17} className="text-ink-4 shrink-0" />
}
