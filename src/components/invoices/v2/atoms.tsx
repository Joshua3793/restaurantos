'use client'
// Phase 2 — Atomic UI primitives for the invoice review drawer.
// Each component is self-contained and renders correctly from props alone.

import { Package, Scale, TrendingUp, TrendingDown, ChevronDown, Plus } from 'lucide-react'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'

// ─── Colour tokens ─────────────────────────────────────────────────────────────
// These approximate the v4 CSS variables using standard Tailwind classes.
// Kept here so every atom draws from the same palette.

const PILL_VARIANTS = {
  warn:    'bg-gold-soft text-gold-2',
  info:    'bg-blue-soft  text-blue-text',
  danger:  'bg-red-soft   text-red-text',
  success: 'bg-green-soft text-green-text',
  neutral: 'bg-bg-2 text-ink-3 border border-line',
} as const

export type PillVariant = keyof typeof PILL_VARIANTS

// ─── ModeIcon ──────────────────────────────────────────────────────────────────
// Bare 20px icon column — no background chip (deliberate, per v4).
// Package (gray) for per-case, Scale (blue) for per-weight.

export function ModeIcon({ mode }: { mode: 'per_case' | 'per_weight' }) {
  if (mode === 'per_weight') {
    return (
      <span
        className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-blue-text"
        title="Priced by weight"
      >
        <Scale size={19} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center w-[22px] h-6 shrink-0 mt-0.5 text-ink-4"
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
        isUp ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'
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
        className="inline-flex items-center gap-1.5 bg-bg border border-line px-2 py-[3px] rounded text-xs text-ink-3 hover:bg-bg-2 transition-colors"
      >
        <span className="text-[10px] text-ink-4 font-medium uppercase tracking-wide">RC</span>
        <span className="font-medium text-ink">{rc.name}</span>
        <ChevronDown size={12} className="text-ink-4" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onAssign}
      className="inline-flex items-center gap-1 border border-dashed border-line-2 px-2 py-[3px] rounded text-xs text-ink-3 hover:border-blue hover:text-blue-text transition-colors"
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
    <div className="inline-flex p-[2px] bg-bg-2 border border-line rounded-[6px]">
      <button
        type="button"
        onClick={() => onChange('per_case')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_case'
            ? 'bg-paper text-ink shadow-sm'
            : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        case
      </button>
      <button
        type="button"
        onClick={() => onChange('per_weight')}
        className={`px-[11px] py-[3px] text-[11px] rounded font-medium transition-colors ${
          mode === 'per_weight'
            ? 'bg-blue-soft text-blue-text shadow-sm'
            : 'text-ink-3 hover:text-ink-2'
        }`}
      >
        weight
      </button>
    </div>
  )
}

// ─── IssueBadge ──────────────────────────────────────────────────────────────
// The single coloured pill that labels an .issue block (price / mode / sku /
// supplier). Mock §5: .badge.price → red-soft, .badge.mode → gold-soft,
// .badge.sku → blue-soft. Mono, uppercase, pill.

export type IssueKind = 'price' | 'mode' | 'sku' | 'supplier' | 'conf'

const ISSUE_BADGE: Record<IssueKind, string> = {
  price:    'bg-red-soft text-red-text',
  mode:     'bg-gold-soft text-gold-2',
  sku:      'bg-blue-soft text-blue-text',
  supplier: 'bg-gold-soft text-gold-2',
  conf:     'bg-gold-soft text-gold-2',
}

export function IssueBadge({ kind, children }: { kind: IssueKind; children: React.ReactNode }) {
  return (
    <span
      className={`font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full shrink-0 ${ISSUE_BADGE[kind]}`}
    >
      {children}
    </span>
  )
}

// ─── ActButton ───────────────────────────────────────────────────────────────
// The inline decision button used in .actions rows. Mock §5:
//   .act          → bordered paper, ink-2 text
//   .act.primary  → solid ink, paper text (the recommended decision)
//   .act.danger   → borderless red, hover red-soft
// Optional `kbd` renders the little keycap chip (e.g. the ⌘⏎ on Approve).

export function ActButton({
  variant = 'default',
  onClick,
  children,
  kbd,
  disabled,
  title,
}: {
  variant?: 'default' | 'primary' | 'danger'
  onClick?: () => void
  children: React.ReactNode
  kbd?: string
  disabled?: boolean
  title?: string
}) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const variantCls =
    variant === 'primary'
      ? 'bg-ink text-paper border border-ink hover:bg-ink-2'
      : variant === 'danger'
      ? 'bg-transparent text-red-text border border-transparent hover:bg-red-soft'
      : 'bg-paper text-ink-2 border border-line hover:border-ink-4 hover:text-ink'
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${base} ${variantCls}`}>
      {children}
      {kbd && (
        <span className="font-mono text-[9.5px] px-[5px] py-[1px] rounded bg-paper/15 text-bg">{kbd}</span>
      )}
    </button>
  )
}

// ─── LineNumberChip ──────────────────────────────────────────────────────────
// The "01" / "02" index chip at the left of each .line-head. Goes gold on
// attention lines, green on auto-matched, neutral otherwise.

export function LineNumberChip({
  n,
  tone = 'neutral',
}: {
  n: number
  tone?: 'neutral' | 'attention' | 'ok' | 'muted'
}) {
  const toneCls =
    tone === 'attention' ? 'bg-gold-soft text-gold-2'
    : tone === 'ok'       ? 'bg-green-soft text-green-text'
    : tone === 'muted'    ? 'bg-bg-2 text-ink-4'
    :                       'bg-bg-2 text-ink-3'
  return (
    <span className={`font-mono text-[10px] font-semibold w-6 text-center py-[3px] rounded-[5px] ${toneCls}`}>
      {String(n).padStart(2, '0')}
    </span>
  )
}

// ─── Segmented ───────────────────────────────────────────────────────────────
// The All / Issues / Matched control in the review-pane progress header.
// Mock .rv-progress .seg: bg-2 track, active segment goes white-on-paper.

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div className="flex bg-bg-2 rounded-[7px] p-[2px]">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`font-mono text-[10px] font-semibold uppercase tracking-[0.01em] px-[9px] py-1 rounded-[5px] transition-colors ${
            value === o.value
              ? 'bg-paper text-ink shadow-sm'
              : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
