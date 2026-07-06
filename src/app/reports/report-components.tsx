'use client'
import { useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, ChevronDown, Minus, Info } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

/**
 * Small ⓘ affordance that reveals a provenance note (how a number is computed:
 * formula · window · scope) on hover or keyboard focus.
 *
 * The tooltip is rendered in a portal on <body> with fixed positioning, so it
 * escapes the `overflow-hidden` / narrow KPI-card containers that used to crop it.
 * Position is measured from the icon and clamped to the viewport (flips above the
 * icon when there isn't room below).
 */
const TIP_W = 264
export function InfoDot({ text, className = '' }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [box, setBox] = useState<{ left: number; top?: number; bottom?: number } | null>(null)

  const show = useCallback(() => {
    const el = ref.current
    if (!el || typeof window === 'undefined') return
    const r = el.getBoundingClientRect()
    // Center under the icon, then clamp horizontally into the viewport (8px gutter).
    const left = Math.max(8, Math.min(r.left + r.width / 2 - TIP_W / 2, window.innerWidth - TIP_W - 8))
    // Flip above the icon when the bottom half of the viewport is tight.
    const openUp = window.innerHeight - r.bottom < 140
    setBox(openUp
      ? { left, bottom: window.innerHeight - r.top + 6 }
      : { left, top: r.bottom + 6 })
  }, [])
  const hide = useCallback(() => setBox(null), [])

  return (
    <span
      ref={ref}
      className={`relative inline-flex align-middle ${className}`}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
    >
      <Info size={12} tabIndex={0}
        className="text-ink-4 hover:text-ink-2 focus:text-ink-2 cursor-help shrink-0 outline-none" />
      {box && typeof document !== 'undefined' && createPortal(
        <span role="tooltip"
          style={{ position: 'fixed', left: box.left, top: box.top, bottom: box.bottom, width: TIP_W }}
          className="pointer-events-none z-[100] rounded-lg bg-ink text-paper text-[11px] leading-snug
            font-normal normal-case tracking-normal text-left px-2.5 py-2 shadow-xl">
          {text}
        </span>,
        document.body,
      )}
    </span>
  )
}

export const CAT_COLORS: Record<string, string> = {
  MEAT: '#dc2626', FISH: '#0d9488', DAIRY: '#2563eb', PROD: '#16a34a',
  DRY: '#ca8a04', BREAD: '#ea580c', PREPD: '#7c3aed', CHM: '#71717a',
}

export const CHART_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0d9488','#ea580c','#db2777']

export function pct(n: number | null | undefined, decimals = 1) {
  if (n == null) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`
}

export function DeltaBadge({ change, inverse = false }: { change: number | null; inverse?: boolean }) {
  if (change === null) return <span className="text-xs text-ink-4">vs prev</span>
  const good = inverse ? change < 0 : change > 0
  const Icon = change > 0 ? ChevronUp : change < 0 ? ChevronDown : Minus
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${good ? 'text-green-text' : change === 0 ? 'text-ink-4' : 'text-red'}`}>
      <Icon size={11} />
      {Math.abs(change).toFixed(1)}%
    </span>
  )
}

export function KpiCard({ label, value, sub, change, inverse = false, accent = 'blue', icon: Icon, info }:
  { label: string; value: string; sub?: string; change?: number | null; inverse?: boolean; accent?: string; icon?: React.ElementType; info?: string }) {
  const accentMap: Record<string, string> = {
    blue: 'text-gold', green: 'text-green-text', amber: 'text-gold',
    red: 'text-red', purple: 'text-blue', gray: 'text-ink-3',
  }
  return (
    <div className="bg-white rounded-xl border border-line p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-ink-4 tracking-wide uppercase leading-tight inline-flex items-center gap-1">
          {label}{info && <InfoDot text={info} />}
        </span>
        {Icon && <Icon size={16} className={accentMap[accent] ?? 'text-ink-4'} />}
      </div>
      <div className={`text-2xl font-bold ${accentMap[accent] ?? 'text-ink-2'}`}>{value}</div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        {sub && <span className="text-xs text-ink-4">{sub}</span>}
        {change !== undefined && <DeltaBadge change={change ?? null} inverse={inverse} />}
      </div>
    </div>
  )
}

export function SectionHeader({ title, subtitle, info }: { title: string; subtitle?: string; info?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-base font-bold text-ink inline-flex items-center gap-1.5">
        {title}{info && <InfoDot text={info} />}
      </h2>
      {subtitle && <p className="text-xs text-ink-3 mt-0.5">{subtitle}</p>}
    </div>
  )
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-line shadow-sm p-4 ${className}`}>{children}</div>
}

export function EmptyState({ message }: { message: string }) {
  return <div className="flex items-center justify-center py-12 text-ink-4 text-sm">{message}</div>
}

export const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-line rounded-lg shadow-lg px-3 py-2 text-xs">
      <div className="font-semibold text-ink-2 mb-1">{label}</div>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-ink-3">{p.name}:</span>
          <span className="font-semibold text-ink-2">{typeof p.value === 'number' ? formatCurrency(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LoadingState() {
  return (
    <div className="space-y-4">
      {[1,2,3].map(i => (
        <div key={i} className="bg-white rounded-xl border border-line p-4 h-32 animate-pulse">
          <div className="h-3 bg-bg-2 rounded w-1/4 mb-3" />
          <div className="h-6 bg-bg-2 rounded w-1/2 mb-2" />
          <div className="h-3 bg-bg-2 rounded w-1/3" />
        </div>
      ))}
    </div>
  )
}
