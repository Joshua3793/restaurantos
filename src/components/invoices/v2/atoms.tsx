'use client'
// Phase 2 — Atomic UI primitives for the invoice review drawer.
// Each component is self-contained and renders correctly from props alone.

import { Package, Scale, TrendingUp, TrendingDown, ChevronDown, Plus } from 'lucide-react'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'

// ─── Colour tokens ─────────────────────────────────────────────────────────────
// These approximate the v4 CSS variables using standard Tailwind classes.
// Kept here so every atom draws from the same palette.

const PILL_VARIANTS = {
  warn:    'bg-amber-100 text-amber-800',
  info:    'bg-blue-100  text-blue-800',
  danger:  'bg-red-100   text-red-800',
  success: 'bg-green-100 text-green-800',
  neutral: 'bg-stone-100 text-stone-600 border border-stone-200',
} as const

export type PillVariant = keyof typeof PILL_VARIANTS

// ─── ModeIcon ──────────────────────────────────────────────────────────────────
// Bare 20px icon column — no background chip (deliberate, per v4).
// Package (gray) for per-case, Scale (blue) for per-weight.

export function ModeIcon({ mode }: { mode: 'per_case' | 'per_weight' }) {
  if (mode === 'per_weight') {
    return (
      <span
        className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-blue-700"
        title="Priced by weight"
      >
        <Scale size={19} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-gray-400"
      title="Priced by case"
    >
      <Package size={19} />
    </span>
  )
}

// ─── Pill ──────────────────────────────────────────────────────────────────────
// Small state label. Used inline in line titles for: mode mismatch, catchweight,
// needs link, math check, format mismatch, etc.

export function Pill({
  variant,
  children,
}: {
  variant: PillVariant
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-[3px] px-[7px] py-[1px] rounded text-[10px] font-medium leading-[1.5] tracking-[0.015em] ${PILL_VARIANTS[variant]}`}
    >
      {children}
    </span>
  )
}

// ─── VariancePill ──────────────────────────────────────────────────────────────
// "↓ 8.5%" or "↑ 4.2%" — green for price drop, red for price rise.

export function VariancePill({
  percent,
  direction,
}: {
  percent: number
  direction: 'up' | 'down'
}) {
  const isUp = direction === 'up'
  return (
    <span
      className={`inline-flex items-center gap-[3px] px-[7px] py-[1px] rounded text-[11px] font-medium ${
        isUp ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
      }`}
    >
      {isUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {isUp ? '+' : ''}
      {percent.toFixed(1)}%
    </span>
  )
}

// ─── RcPill ────────────────────────────────────────────────────────────────────
// When assigned: solid chip showing RC name + chevron (opens RC picker on click).
// When unassigned: dashed chip showing "assign RC +" (calls onAssign).

export function RcPill({
  rc,
  onAssign,
  onClick,
}: {
  rc?: RevenueCenter | null
  onAssign?: () => void
  onClick?: () => void
}) {
  if (rc) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 bg-stone-50 border border-stone-200 px-2 py-[3px] rounded text-xs text-stone-600 hover:bg-stone-100 transition-colors"
      >
        <span className="text-[10px] text-stone-400 font-medium uppercase tracking-wide">RC</span>
        <span className="font-medium text-stone-900">{rc.name}</span>
        <ChevronDown size={12} className="text-stone-400" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onAssign}
      className="inline-flex items-center gap-1 border border-dashed border-stone-300 px-2 py-[3px] rounded text-xs text-stone-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
    >
      <span>assign RC</span>
      <Plus size={11} />
    </button>
  )
}

// ─── ModeToggle ────────────────────────────────────────────────────────────────
// Segmented control inside the Invoice math card header.
// Active "case" → white bg. Active "weight" → blue bg (per v4).

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'per_case' | 'per_weight'
  onChange: (m: 'per_case' | 'per_weight') => void
}) {
  return (
    <div className="inline-flex p-[2px] bg-stone-100 border border-stone-200 rounded-[6px]">
      <button
        type="button"
        onClick={() => onChange('per_case')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_case'
            ? 'bg-white text-stone-900 shadow-sm'
            : 'text-stone-500 hover:text-stone-700'
        }`}
      >
        case
      </button>
      <button
        type="button"
        onClick={() => onChange('per_weight')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_weight'
            ? 'bg-blue-100 text-blue-800 shadow-sm'
            : 'text-stone-500 hover:text-stone-700'
        }`}
      >
        weight
      </button>
    </div>
  )
}
