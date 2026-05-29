# Fergie's OS — Feature Components — invoices (v2 review system)

The multi-step invoice OCR → review → approve UI. atoms/chrome/card/composites build up to the review drawer.


---

## `src/components/invoices/v2/atoms.tsx`

```tsx
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

export type IssueKind = 'price' | 'mode' | 'sku' | 'supplier'

const ISSUE_BADGE: Record<IssueKind, string> = {
  price:    'bg-red-soft text-red-text',
  mode:     'bg-gold-soft text-gold-2',
  sku:      'bg-blue-soft text-blue-text',
  supplier: 'bg-gold-soft text-gold-2',
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

```


---

## `src/components/invoices/v2/chrome.tsx`

```tsx
'use client'
// Drawer "chrome" — the brand surfaces that frame the review pane:
// cost-impact strip (Principle 01), the totals-tie alert banner, the review
// progress header, and the section dividers.

import { AlertTriangle } from 'lucide-react'
import { Segmented } from './atoms'

// ─── ImpactStrip ───────────────────────────────────────────────────────────────
// "Cost is chrome" — the dark strip directly under the header summarising what
// approving will write. Only metrics we can compute pre-approve are shown.

export interface ImpactMetric {
  label: string
  value: string
  tone?: 'warn' | 'bad' | 'ok'
}

export function ImpactStrip({
  metrics,
  helper,
}: {
  metrics: ImpactMetric[]
  helper?: React.ReactNode
}) {
  const toneCls = (t?: ImpactMetric['tone']) =>
    t === 'warn' ? 'text-[#fcd34d]' : t === 'bad' ? 'text-[#fca5a5]' : t === 'ok' ? 'text-green' : 'text-bg'

  return (
    <div className="flex items-center gap-[18px] bg-ink text-bg px-[22px] py-[9px] overflow-x-auto">
      {metrics.map((m, i) => (
        <div key={m.label} className="flex items-center gap-[18px] shrink-0">
          {i > 0 && <span className="w-px h-3.5 bg-ink-2" />}
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-ink-4">{m.label}</span>
            <span className={`font-mono text-[13.5px] font-semibold tabular-nums ${toneCls(m.tone)}`}>{m.value}</span>
          </div>
        </div>
      ))}
      <span className="flex-1" />
      {helper && <span className="font-mono text-[10.5px] text-ink-3 shrink-0">{helper}</span>}
    </div>
  )
}

// ─── AlertBanner ───────────────────────────────────────────────────────────────
// Gold-soft full-width bar. Only rendered for invoice-wide issues (e.g. the
// sum-of-lines / subtotal mismatch).

export function AlertBanner({
  children,
  onIgnore,
  onShowFix,
  showFixLabel = 'Show suggested fix',
}: {
  children: React.ReactNode
  onIgnore?: () => void
  onShowFix?: () => void
  showFixLabel?: string
}) {
  return (
    <div className="flex items-center gap-3 bg-gold-soft border-b border-[#fcd34d]/60 px-[22px] py-[11px] text-[13px] text-gold-2">
      <AlertTriangle size={16} className="text-gold-2 shrink-0" strokeWidth={2.2} />
      <span className="flex-1 min-w-0">{children}</span>
      <div className="flex gap-1.5 shrink-0">
        {onIgnore && (
          <button
            type="button"
            onClick={onIgnore}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2/10 text-gold-2 hover:bg-gold-2/20 transition-colors"
          >
            Ignore for now
          </button>
        )}
        {onShowFix && (
          <button
            type="button"
            onClick={onShowFix}
            className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-gold-2 text-paper hover:bg-gold-2 transition-colors"
          >
            {showFixLabel}
          </button>
        )}
      </div>
    </div>
  )
}

// ─── ReviewProgress ──────────────────────────────────────────────────────────
// "X of N resolved" + gold progress bar + All / Issues / Matched segmented filter.

export type ReviewSegment = 'all' | 'issues' | 'matched'

export function ReviewProgress({
  resolved,
  total,
  segment,
  onSegment,
  counts,
}: {
  resolved: number
  total: number
  segment: ReviewSegment
  onSegment: (s: ReviewSegment) => void
  counts: { all: number; issues: number; matched: number }
}) {
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 100
  return (
    <div className="flex items-center gap-3 px-[22px] py-2.5 bg-paper border-b border-line shrink-0">
      <span className="font-mono text-[11px] font-semibold text-ink-2 shrink-0 tabular-nums">
        {total > 0 ? `${resolved} of ${total} resolved` : 'All matched'}
      </span>
      <div className="flex-1 h-1 rounded-full bg-bg-2 overflow-hidden">
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <Segmented<ReviewSegment>
        value={segment}
        onChange={onSegment}
        options={[
          { value: 'all',     label: `All ${counts.all}` },
          { value: 'issues',  label: `Issues ${counts.issues}` },
          { value: 'matched', label: `Matched ${counts.matched}` },
        ]}
      />
    </div>
  )
}

// ─── SectionDivider ──────────────────────────────────────────────────────────

export function SectionDivider({
  tone,
  label,
  count,
}: {
  tone: 'red' | 'green' | 'neutral'
  label: string
  count?: string
}) {
  const dotCls = tone === 'red' ? 'bg-red' : tone === 'green' ? 'bg-green' : 'bg-ink-4'
  return (
    <div className="flex items-center gap-2.5 pt-2 pb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      <span>{label}</span>
      {count && <span className="text-ink-4 font-medium normal-case tracking-normal">· {count}</span>}
      <span className="flex-1 h-px bg-line" />
    </div>
  )
}

```


---

## `src/components/invoices/v2/card.tsx`

```tsx
'use client'
// LineItemCard — the redesigned per-line review card (Invoice Drawer mock §2/§5).
// Matched lines render as a single collapsed row; attention lines expand into a
// link-row, stacked `.issue` blocks, the invoice-math block, and an optional
// inventory-cost comparison. Reads shared state from DrawerContext.

import { useRef } from 'react'
import { ChevronDown, ExternalLink, Ban, Undo2, Check } from 'lucide-react'
import { useDrawerContext } from './context'
import { LineNumberChip } from './atoms'
import {
  LinkPicker,
  CaseStructureEditor,
  InvoiceMathFields,
  type InventorySearchResult,
} from './composites'
import { ModeIssue, NewSkuIssue, PriceIssue } from './issues'
import {
  derivePricingMode, isCatchweight, hasModeMismatch, hasFormatMismatch,
  hasMathCheck, isUnlinked,
} from '@/lib/invoice/predicates'
import { isBigPriceChange, lineUnresolved } from '@/lib/invoice/resolution'
import { formatPackSummary, formatRateLabel, formatCurrency } from '@/lib/invoice/formatters'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import type { ScanItem } from '@/components/invoices/types'

// ─── LineItemCard ──────────────────────────────────────────────────────────────

export function LineItemCard({ lineId, displayNo }: { lineId: string; displayNo: number }) {
  const ctx  = useDrawerContext()
  const item = ctx.getEffectiveLine(lineId)
  const mathRef = useRef<HTMLDivElement>(null)

  const pricingMode = derivePricingMode(item)
  const isOpen      = ctx.expandedLineIds.has(lineId)
  const isFlashing  = ctx.flashingLineIds.has(lineId)
  const isPicking   = ctx.pickingLinkForId === lineId
  const isSkipped   = item.action === 'SKIP'
  const isCreateNew = item.action === 'CREATE_NEW'

  const unlinked       = !isSkipped && isUnlinked(item)
  const modeMismatch   = !isSkipped && hasModeMismatch(item)
  const formatMismatch = !isSkipped && hasFormatMismatch(item)
  const mathCheck      = !isSkipped && hasMathCheck(item)
  const bigPrice       = !isSkipped && isBigPriceChange(item)
  const isAttention    = unlinked || modeMismatch || formatMismatch || mathCheck || bigPrice
  const isCatch        = isCatchweight(item)

  // A line that surfaced an issue but whose decisions are all made now reads as
  // resolved — flips the card from amber attention to green acknowledgment.
  const resolved = isAttention && !lineUnresolved(item, {
    modeWriteback: ctx.modeWritebackItems.has(lineId),
    priceAck:      ctx.acknowledgedPriceLines.has(lineId),
  })

  // data-task for the footer's goToTask() targeting (highest-priority first).
  const dataTask = isSkipped ? undefined
    : unlinked       ? 'link'
    : mathCheck      ? 'math'
    : (modeMismatch || formatMismatch) ? 'mismatch'
    : undefined

  const handleToggle = () => ctx.toggleExpand(lineId)
  const handleChangeLink = () => ctx.startLinkPicker(lineId)

  const handleSelectLink = (result: InventorySearchResult) => {
    ctx.updateLine(lineId, {
      matchedItemId: result.id,
      matchedItem: {
        id: result.id,
        itemName: result.itemName,
        purchaseUnit: result.purchaseUnit,
        purchasePrice: String(result.purchasePrice),
        pricePerBaseUnit: String(result.pricePerBaseUnit),
        baseUnit: result.baseUnit,
        qtyPerPurchaseUnit: String(result.qtyPerPurchaseUnit),
        packSize: String(result.packSize),
        packUOM: result.packUOM,
        priceType: 'CASE',
        qtyUOM: result.packUOM,
        innerQty: null,
      },
      action: 'UPDATE_PRICE',
    })
    ctx.closeLinkPicker()
  }

  const handleMathChange = (patch: Partial<ScanItem>) => ctx.updateLine(lineId, patch)
  const defaultRcId = ctx.revenueCenters.find(r => r.isDefault)?.id ?? ''
  const handleRcChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const picked = ctx.revenueCenters.find(r => r.id === e.target.value) ?? null
    ctx.setLineRc(lineId, picked)
  }

  const total = item.rawLineTotal ? Number(item.rawLineTotal) : null
  const rate  = formatRateLabel(item)

  // ── Charge / skipped line — "Other line items" section ──────────────────────
  if (isSkipped) {
    return (
      <article
        data-line-id={lineId}
        className="flex items-center gap-3 bg-paper border border-line rounded-lg px-4 py-[11px] opacity-70"
      >
        <LineNumberChip n={displayNo} tone="muted" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink-3 font-medium truncate">{item.rawDescription || '(no description)'}</div>
          <div className="font-mono text-[10.5px] text-ink-4 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <Ban size={10} /> Skipped — no COGS impact
          </div>
        </div>
        <div className="font-mono text-[13px] font-semibold text-ink-3 tabular-nums shrink-0">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        <button
          type="button"
          onClick={() => ctx.updateLine(lineId, { action: item.matchedItemId ? 'UPDATE_PRICE' : 'PENDING' })}
          className="font-mono text-[10.5px] font-semibold text-gold border-b border-dashed border-gold/70 hover:text-gold-2 shrink-0 inline-flex items-center gap-1"
        >
          <Undo2 size={11} /> undo
        </button>
      </article>
    )
  }

  // ── Auto-matched, collapsed — single row ────────────────────────────────────
  if (!isOpen) {
    return (
      <article
        data-line-id={lineId}
        data-task={dataTask}
        onClick={handleToggle}
        className={`flex items-center gap-3 bg-paper border rounded-lg px-4 py-[11px] cursor-pointer transition-colors ${
          resolved ? 'border-[#86efac] hover:border-green-text'
          : isAttention ? 'border-[#fcd34d] hover:border-gold'
          : 'border-line hover:border-line-2'
        } ${isFlashing ? 'animate-flash-highlight' : ''}`}
      >
        <LineNumberChip n={displayNo} tone={isAttention && !resolved ? 'attention' : 'ok'} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-ink font-medium truncate">
            {item.rawDescription || '(no description)'}
            <span className="font-mono text-[10.5px] text-ink-4 font-normal ml-2">{formatPackSummary(item)}</span>
          </div>
        </div>
        {resolved && (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0 inline-flex items-center gap-1">
            <Check size={10} /> resolved
          </span>
        )}
        {!isAttention && item.matchedItem && (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0">
            matched
          </span>
        )}
        <div className="font-mono text-[13px] font-semibold text-ink tabular-nums shrink-0">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        <ChevronDown size={15} className="text-ink-4 shrink-0" />
      </article>
    )
  }

  // ── Expanded card ────────────────────────────────────────────────────────────
  return (
    <article
      data-line-id={lineId}
      data-task={dataTask}
      className={`bg-paper border rounded-lg overflow-hidden transition-shadow ${
        resolved ? 'border-[#86efac]' : isAttention ? 'border-[#fcd34d]' : 'border-line'
      } ${isOpen ? 'shadow-sm' : ''} ${isFlashing ? 'animate-flash-highlight' : ''}`}
    >
      {/* line-head */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleToggle()}
        className="grid grid-cols-[24px_1fr_auto] gap-3 items-start px-4 pt-3.5 pb-3 border-b border-dashed border-line cursor-pointer select-none"
      >
        <LineNumberChip n={displayNo} tone={isAttention ? 'attention' : 'ok'} />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-ink leading-[1.3]">
            {item.rawDescription || '(no description)'}
          </div>
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {item.supplierItemCode && (
              <>
                <span>#{item.supplierItemCode}</span>
                <span className="text-line-2">·</span>
              </>
            )}
            <span>{formatPackSummary(item)}</span>
            {isCatch && item.qtyOrdered && (
              <>
                <span className="text-line-2">·</span>
                <span className="text-blue-text">{Number(item.qtyOrdered).toFixed(2)} {item.qtyOrderedUOM ?? item.rateUOM ?? 'lb'} received</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-start gap-2.5 shrink-0">
          {resolved && (
            <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text inline-flex items-center gap-1 self-center">
              <Check size={10} /> resolved
            </span>
          )}
          <div className="text-right">
            <div className="font-mono text-[16px] font-semibold text-ink tabular-nums leading-none">
              {total !== null ? formatCurrency(total) : '—'}
            </div>
            {rate && <div className="font-mono text-[10.5px] text-ink-4 mt-0.5 tabular-nums">{rate}</div>}
          </div>
          <ChevronDown size={16} className="text-ink-4 mt-1 rotate-180 transition-transform" />
        </div>
      </div>

      {/* link picker (search) */}
      {isPicking ? (
        <div className="px-4 py-2.5 border-b border-dashed border-line">
          <LinkPicker
            defaultQuery={item.rawDescription ?? ''}
            onSelect={handleSelectLink}
            onCreateNew={() => { ctx.closeLinkPicker(); ctx.openCreateNew(item) }}
          />
          <button
            type="button"
            onClick={ctx.closeLinkPicker}
            className="mt-2 text-[11px] text-ink-4 hover:text-ink-2 underline underline-offset-2"
          >
            cancel
          </button>
        </div>
      ) : isCreateNew ? (
        <div className="px-4 py-2.5 flex items-center gap-2.5 text-[12.5px] bg-green-soft border-b border-dashed border-line">
          <span className="inline-flex items-center gap-1.5 font-medium text-green-text">+ new item on approve</span>
          <span className="flex-1" />
          <button onClick={() => ctx.startLinkPicker(lineId)} className="font-mono text-[10.5px] font-semibold text-ink-4 hover:text-gold border-b border-dashed border-line-2">change</button>
        </div>
      ) : item.matchedItem ? (
        <div className="px-4 py-2.5 flex items-center gap-2.5 text-[12.5px] bg-bg border-b border-dashed border-line">
          <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-4">Linked to</span>
          <span className="inline-flex items-center gap-1.5 font-medium text-ink px-2 py-[2px] rounded-md bg-paper border border-line">
            <span className="w-1.5 h-1.5 rounded-full bg-red" />
            {item.matchedItem.itemName}
          </span>
          <span className="flex-1" />
          <button onClick={handleChangeLink} className="font-mono text-[10.5px] font-semibold text-gold hover:text-gold-2 border-b border-dashed border-gold/70">change link</button>
        </div>
      ) : null}

      {/* issue blocks */}
      {!isPicking && (
        <>
          {unlinked && <NewSkuIssue item={item} lineId={lineId} />}
          {modeMismatch && <ModeIssue item={item} lineId={lineId} />}
          {bigPrice && <PriceIssue item={item} lineId={lineId} onFixUom={() => mathRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />}
          {formatMismatch && !modeMismatch && (
            <div className="px-4 py-2.5 border-b border-dashed border-line">
              <FormatMismatchNotice item={item} lineId={lineId} />
            </div>
          )}
        </>
      )}

      {/* invoice math */}
      {!isPicking && (
        <>
          {pricingMode === 'per_case' && (
            <div className="px-4 py-2.5 border-b border-dashed border-line">
              <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold mb-2">Pack structure</div>
              <CaseStructureEditor item={item} onChange={patch => ctx.updateLine(lineId, patch)} />
            </div>
          )}

          <div ref={mathRef} className="px-4 py-2.5 bg-bg border-b border-dashed border-line">
            <InvoiceMathFields
              item={item}
              mode={pricingMode}
              onMode={m => ctx.updateLine(lineId, { pricingMode: m })}
              onChange={handleMathChange}
            />
          </div>

          {/* inventory cost comparison — hidden when the price issue already shows it */}
          {item.matchedItem && !isCreateNew && !bigPrice && (
            <InventoryComparisonCard item={item} />
          )}

          {/* line actions: revenue center + skip */}
          <div className="px-4 py-2.5 flex items-center gap-2" onClick={e => e.stopPropagation()} role="presentation">
            <select
              value={item.revenueCenterId ?? defaultRcId}
              onChange={handleRcChange}
              className="font-mono text-[11px] text-ink-3 bg-bg border border-line rounded px-1.5 py-[3px] hover:bg-bg-2 focus:outline-none focus:ring-1 focus:ring-gold/40 cursor-pointer"
            >
              {ctx.revenueCenters.map(r => (
                <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}
              title="Skip this line — won't affect COGS"
              className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-4 hover:text-ink-2 hover:bg-bg-2 px-2 py-[3px] rounded transition-colors"
            >
              <Ban size={11} /> Skip
            </button>
          </div>
        </>
      )}
    </article>
  )
}

// ─── InventoryComparisonCard ───────────────────────────────────────────────────
// Current linked cost vs. what this invoice would set it to (normalised $/unit).

function InventoryComparisonCard({ item }: { item: ScanItem }) {
  const norm = computeNormalisedPrices(item)

  let prevLabel = '—'
  let nextLabel = '—'
  let pct: number | null = null
  let rateUnit = ''

  if (norm) {
    const factor = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
    rateUnit  = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each'
    prevLabel = `${formatCurrency(norm.inventoryPPB * factor)}/${rateUnit}`
    nextLabel = `${formatCurrency(norm.invoicePPB * factor)}/${rateUnit}`
    pct       = norm.pctDiff
  } else {
    const prev = item.previousPrice ? Number(item.previousPrice) : null
    const next = item.rawUnitPrice  ? Number(item.rawUnitPrice)  : null
    const bu   = item.matchedItem?.purchaseUnit ?? 'case'
    if (prev !== null) prevLabel = `${formatCurrency(prev)}/${bu}`
    if (next !== null) {
      nextLabel = `${formatCurrency(next)}/${bu}`
      if (prev !== null && prev > 0) pct = Math.round(((next - prev) / prev) * 10000) / 100
    }
  }

  const ctx = useDrawerContext()
  const isBad = pct !== null && pct > 0

  return (
    <div className="px-4 py-2.5 border-b border-dashed border-line">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-4 font-semibold">Inventory comparison</div>
        {item.matchedItem?.id && (
          <button
            type="button"
            onClick={() => ctx.openInventoryEdit(item.matchedItem!.id)}
            className="inline-flex items-center gap-1 font-mono text-[10.5px] text-gold hover:text-gold-2 font-semibold border-b border-dashed border-gold/70"
          >
            Edit <ExternalLink size={11} />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-bg border border-line rounded-lg px-3 py-2.5">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Current cost</div>
          <div className="font-mono text-[13px] font-semibold text-ink-2 tabular-nums mt-1">{prevLabel}</div>
        </div>
        <div className={`rounded-lg px-3 py-2.5 border ${isBad ? 'border-[#fecaca] bg-red-soft' : 'border-line bg-bg'}`}>
          <div className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Invoice cost</div>
          <div className={`font-mono text-[13px] font-semibold tabular-nums mt-1 ${isBad ? 'text-red-text' : 'text-ink'}`}>
            {nextLabel}
            {pct !== null && Math.abs(pct) >= 0.1 && (
              <span className={`ml-1.5 text-[11px] ${pct > 0 ? 'text-red' : 'text-green-text'}`}>
                {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── FormatMismatchNotice ──────────────────────────────────────────────────────
// Shows invoice vs inventory pack format with two resolution actions.

function FormatMismatchNotice({ item, lineId }: { item: ScanItem; lineId: string }) {
  const { updateLine } = useDrawerContext()

  const inv = item.matchedItem
  const invFmt = inv ? `${inv.qtyPerPurchaseUnit} × ${inv.packSize}${inv.packUOM}` : null
  const invoiceFmt = item.invoicePackQty && item.invoicePackSize && item.invoicePackUOM
    ? `${item.invoicePackQty} × ${item.invoicePackSize}${item.invoicePackUOM}`
    : null

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-blue-soft text-blue-text shrink-0">Format mismatch</span>
        <span className="text-[12.5px] text-ink-2 leading-[1.45]">
          Pack structure on this invoice (<b className="font-semibold text-ink">{invoiceFmt ?? '—'}</b>) doesn&rsquo;t match{' '}
          <b className="font-semibold text-ink">{inv?.itemName ?? 'the stored item'}</b> (<b className="font-semibold text-ink">{invFmt ?? '—'}</b>).
        </span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => updateLine(lineId, { formatMismatch: false })}
          className="inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-ink text-paper hover:bg-ink-2 transition-colors"
        >
          Use invoice format
        </button>
        <button
          type="button"
          onClick={() => {
            if (!inv) return
            updateLine(lineId, {
              formatMismatch: false,
              invoicePackQty:  String(inv.qtyPerPurchaseUnit),
              invoicePackSize: String(inv.packSize),
              invoicePackUOM:  inv.packUOM ?? undefined,
            })
          }}
          className="inline-flex items-center gap-1.5 px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-paper text-ink-2 border border-line hover:border-ink-4 transition-colors"
        >
          Revert to inventory format
        </button>
      </div>
    </div>
  )
}

```


---

## `src/components/invoices/v2/composites.tsx`

```tsx
'use client'
// Phase 3 — Composite components for the invoice review drawer.
// Each renders correctly given just its props; no drawer-level context required.

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  AlertTriangle, Search, Plus, Check, ArrowRight,
  RotateCcw, ZoomIn, ChevronDown, Link2, Info, X,
} from 'lucide-react'
import type { ScanItem } from '@/components/invoices/types'
import { Pill, VariancePill, ModeToggle } from './atoms'
import { computeLineMath, computeNormalisedPrices } from '@/lib/invoice/calculations'
import { formatCurrency } from '@/lib/invoice/formatters'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { FILTER_LABELS, type FilterKey, type SortMode } from '@/lib/invoice/filters'
import { PACK_UOMS } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InventorySearchResult {
  id: string
  itemName: string
  abbreviation: string | null
  purchaseUnit: string
  purchasePrice: number
  pricePerBaseUnit: number
  baseUnit: string
  category: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

export type ReconcileResult = {
  sumOfLines: number
  invoiceSubtotal: number | null
  delta: number
  status: 'match' | 'mismatch' | 'unknown'
  suggestedFixItemId: string | null
  suggestedFixValue: number | null
}

// ─── LineAmounts ──────────────────────────────────────────────────────────────
// Right-side column of each collapsed row. Always shows total; below it shows
// either a rate string OR a math-check warning — never both.

export function LineAmounts({
  total,
  rate,
  warning,
  isOpen,
}: {
  total: number | null
  rate?: string | null
  warning?: string | null
  isOpen?: boolean
}) {
  return (
    <div className="flex items-start gap-2.5 shrink-0">
      <div className="flex flex-col items-end gap-[2px]">
        <div className="text-[15.5px] font-semibold tabular-nums whitespace-nowrap leading-none tracking-[-0.01em]">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        {warning ? (
          <div className="flex items-center gap-[3px] text-[11px] text-gold-2 tabular-nums">
            <AlertTriangle size={11} />
            maybe {warning}
          </div>
        ) : rate ? (
          <div className="text-[11px] text-ink-4 tabular-nums">{rate}</div>
        ) : null}
      </div>
      <ChevronDown
        size={16}
        className={`text-ink-4 mt-[5px] shrink-0 transition-transform duration-[180ms] ${isOpen ? 'rotate-180' : ''}`}
      />
    </div>
  )
}

// ─── LinkInfoRow ──────────────────────────────────────────────────────────────
// The "linked to …" row shown when a line item is already matched.

export function LinkInfoRow({
  item,
  onChangeClick,
}: {
  item: ScanItem
  onChangeClick: () => void
}) {
  const norm      = computeNormalisedPrices(item)
  // Prefer normalised pct (accounts for mode/format differences) over the raw
  // matcher value which compares per-case prices even for per-weight items.
  const variance  = norm
    ? norm.pctDiff
    : item.priceDiffPct ? Number(item.priceDiffPct) : null

  return (
    <div className="flex items-center gap-[7px] min-w-0 flex-wrap text-[12.5px]">
      <Link2 size={14} className="text-ink-3 shrink-0" />
      <span className="text-ink-3">linked to</span>
      <span className="font-medium text-ink truncate">{item.matchedItem?.itemName}</span>
      <button
        type="button"
        onClick={onChangeClick}
        className="text-[11px] px-2 py-[2px] border border-line rounded text-ink-3 hover:bg-bg hover:text-ink transition-colors"
      >
        change
      </button>
      {variance !== null && Math.abs(variance) >= 0.1 ? (
        <VariancePill percent={Math.abs(variance)} direction={variance > 0 ? 'up' : 'down'} />
      ) : norm ? (
        <span className="text-[11px] text-ink-4 tabular-nums">
          {formatCurrency(norm.invoicePPB)}/{norm.baseUnit} · unchanged
        </span>
      ) : null}
    </div>
  )
}

// ─── LinkPicker ───────────────────────────────────────────────────────────────
// Three-part UI: search input → results list → promoted "create new" option.
// "Create new" is always visible even when matches exist (deliberate).

export function LinkPicker({
  defaultQuery,
  onSelect,
  onCreateNew,
}: {
  defaultQuery: string
  onSelect: (result: InventorySearchResult) => void
  onCreateNew: () => void
}) {
  const [query,   setQuery]   = useState(defaultQuery)
  const [results, setResults] = useState<InventorySearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!q.trim()) { setResults([]); return }
    timerRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res  = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
        const data = await res.json()
        setResults(data)
      } finally {
        setLoading(false)
      }
    }, 180)
  }, [])

  // Run initial search on mount
  useEffect(() => { runSearch(defaultQuery) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = (v: string) => {
    setQuery(v)
    runSearch(v)
  }

  return (
    <div className="space-y-[5px]">
      {/* Label */}
      <div className="flex items-center gap-1.5 text-[11px] text-ink-3 uppercase tracking-[0.06em] mb-1.5">
        <Search size={13} />
        <span>Link to product</span>
      </div>

      {/* Search input */}
      <div className="flex items-center gap-2 bg-paper border-[1.5px] border-blue rounded px-3 h-9 shadow-[0_0_0_3px_rgba(37,99,172,0.12)]">
        <input
          autoFocus
          value={query}
          onChange={e => handleChange(e.target.value)}
          placeholder="search or create…"
          className="flex-1 text-[13px] bg-transparent border-none outline-none"
        />
        <span className="text-[10px] text-ink-4 px-1.5 py-0.5 bg-bg-2 rounded font-mono">↑↓</span>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="bg-paper border border-line rounded-lg overflow-hidden">
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r)}
              className={`w-full flex items-center gap-3 px-[13px] py-[10px] text-left hover:bg-bg transition-colors ${
                i < results.length - 1 ? 'border-b border-bg-2' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-ink">{r.itemName}</div>
                <div className="text-[11px] text-ink-3 mt-0.5 tabular-nums">
                  {formatCurrency(r.pricePerBaseUnit)}/{r.baseUnit}
                  {r.category ? ` · ${r.category}` : ''}
                </div>
              </div>
              {i === 0 && loading === false && (
                <span className="text-[10.5px] bg-green-soft text-green-text px-[7px] py-[2px] rounded font-medium shrink-0">
                  top match
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Promoted "create new" — always visible */}
      <button
        type="button"
        onClick={onCreateNew}
        className="w-full flex items-center gap-3 px-[13px] py-3 bg-blue-soft/60 border border-blue rounded-lg hover:bg-blue-soft transition-colors"
      >
        <span className="w-[22px] h-[22px] rounded-full bg-blue-text text-paper inline-flex items-center justify-center shrink-0">
          <Plus size={13} />
        </span>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[11px] text-blue-text uppercase tracking-[0.05em] mb-[2px]">Or create new</div>
          <div className="text-[13px] text-blue-text font-medium truncate">"{defaultQuery}"</div>
        </div>
        <span className="text-[10px] text-blue font-mono px-1.5 py-0.5 bg-blue-soft rounded">⏎</span>
      </button>
    </div>
  )
}

// ─── CaseStructureEditor ──────────────────────────────────────────────────────
// "1 cs → [pkgQty] pkg × [pkgSize] [uom] per pkg"
// Live derived summary: "total per case: 12 L · cost per ml: $0.0046"

export function CaseStructureEditor({
  item,
  onChange,
}: {
  item: ScanItem
  onChange: (patch: Partial<Pick<ScanItem, 'invoicePackQty' | 'invoicePackSize' | 'invoicePackUOM'>>) => void
}) {
  const [pq,   setPq]   = useState(item.invoicePackQty  ? String(Number(item.invoicePackQty))  : '')
  const [ps,   setPs]   = useState(item.invoicePackSize ? String(Number(item.invoicePackSize)) : '')
  const [pUOM, setPUOM] = useState(item.invoicePackUOM  ?? '')

  const totalPerCase = (parseFloat(pq) || 0) * (parseFloat(ps) || 0)
  const unitPrice    = item.rawUnitPrice ? Number(item.rawUnitPrice) : null
  const costPerUnit  = unitPrice && totalPerCase > 0 ? unitPrice / totalPerCase : null

  const flush = (patch: Partial<Pick<ScanItem, 'invoicePackQty' | 'invoicePackSize' | 'invoicePackUOM'>>) => {
    onChange(patch)
  }

  return (
    <div>
      {/* Inline editor row */}
      <div className="flex items-center gap-[7px] text-[13.5px] tabular-nums flex-wrap">
        <span className="text-ink-3">
          {item.rawQty ? `${Number(item.rawQty)} cs` : '1 cs'}
        </span>
        <ArrowRight size={14} className="text-line-2" />
        <input
          type="number"
          step="any"
          min="0"
          value={pq}
          onChange={e => setPq(e.target.value)}
          onBlur={() => flush({ invoicePackQty: pq || null })}
          className="w-[50px] h-8 text-center font-semibold border border-line rounded bg-paper text-sm focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
        />
        <span className="text-ink-3">pkg</span>
        <span className="text-line-2 mx-0.5">×</span>
        <input
          type="number"
          step="any"
          min="0"
          value={ps}
          onChange={e => setPs(e.target.value)}
          onBlur={() => flush({ invoicePackSize: ps || null })}
          className="w-[50px] h-8 text-center font-semibold border border-line rounded bg-paper text-sm focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
        />
        <select
          value={pUOM}
          onChange={e => { setPUOM(e.target.value); flush({ invoicePackUOM: e.target.value || null }) }}
          className="h-8 px-2 border border-line rounded bg-paper text-sm font-medium focus:outline-none focus:border-blue"
        >
          <option value="">—</option>
          {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <span className="text-ink-3">per pkg</span>
      </div>

      {/* Derived summary */}
      {totalPerCase > 0 && pUOM && (
        <div className="mt-[9px] pt-[9px] border-t border-dashed border-line text-[11.5px] text-ink-3 flex items-center gap-2 flex-wrap tabular-nums">
          <span className="text-ink-4">total per case:</span>
          <strong className="text-ink">{totalPerCase} {pUOM}</strong>
          {costPerUnit !== null && (
            <>
              <span className="text-line-2">·</span>
              <span className="text-ink-4">cost per {pUOM}:</span>
              <strong className="text-ink">{formatCurrency(costPerUnit)}</strong>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── InvoiceMathFields ────────────────────────────────────────────────────────
// Two-column grid of editable pricing fields.
// NO silent auto-recompute — three fields are independent. When they disagree,
// MismatchPanel renders below with three labelled fix actions.

export function InvoiceMathFields({
  item,
  mode,
  onMode,
  onChange,
}: {
  item: ScanItem
  mode: 'per_case' | 'per_weight'
  onMode: (m: 'per_case' | 'per_weight') => void
  onChange: (patch: Partial<Pick<ScanItem,
    'rawQty' | 'rawUnit' | 'rawUnitPrice' | 'rawLineTotal' |
    'totalQty' | 'totalQtyUOM' | 'rate' | 'rateUOM'
  >>) => void
}) {
  // Per-case fields
  const [qty,       setQty]       = useState(item.rawQty          ? String(Number(item.rawQty))          : '')
  const [unitPrice, setUnitPrice] = useState(item.rawUnitPrice    ? String(Number(item.rawUnitPrice))    : '')
  const [lineTotal, setLineTotal] = useState(item.rawLineTotal    ? String(Number(item.rawLineTotal))    : '')
  // Per-weight fields
  const [wQty,      setWQty]      = useState(item.totalQty        ? String(Number(item.totalQty))        : '')
  const [wQtyUOM,   setWQtyUOM]   = useState(item.totalQtyUOM     ?? item.rateUOM ?? 'kg')
  const [rate,      setRate]      = useState(item.rate            ? String(Number(item.rate))            : '')
  const [rateUOM,   setRateUOM]   = useState(item.rateUOM         ?? 'lb')
  const [wTotal,    setWTotal]    = useState(item.rawLineTotal     ? String(Number(item.rawLineTotal))    : '')

  // Track which fields were edited this session (for blue tint)
  const [edited, setEdited] = useState<Set<string>>(new Set())
  const markEdited = (field: string) => setEdited(prev => new Set(prev).add(field))

  // Dismiss-panel state
  const [panelDismissed, setPanelDismissed] = useState(false)

  // Build a ScanItem snapshot from current local state to feed computeLineMath
  const localItem: ScanItem = {
    ...item,
    rawQty:        mode === 'per_case' ? (qty       || null) : item.rawQty,
    rawUnitPrice:  mode === 'per_case' ? (unitPrice || null) : null,
    rawLineTotal:  mode === 'per_case' ? (lineTotal || null) : (wTotal || null),
    totalQty:      mode === 'per_weight' ? (wQty    || null) : item.totalQty,
    totalQtyUOM:   mode === 'per_weight' ? wQtyUOM           : item.totalQtyUOM,
    rate:          mode === 'per_weight' ? (rate    || null) : item.rate,
    rateUOM:       mode === 'per_weight' ? rateUOM           : item.rateUOM,
    pricingMode:   mode,
  }

  const math = computeLineMath(localItem)
  const showPanel = !panelDismissed && math !== null && !math.matches && edited.size > 0

  // Reset dismiss when item changes
  useEffect(() => { setPanelDismissed(false); setEdited(new Set()) }, [item.id])

  const inputBase = 'h-8 border rounded text-sm tabular-nums transition-colors focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10'
  const editedCls = (field: string) => edited.has(field) ? 'border-blue bg-blue-soft' : 'border-line bg-paper'

  return (
    <div>
      {/* Card header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10.5px] text-ink-4 uppercase tracking-[0.06em] font-medium">
          Invoice math
        </span>
        <ModeToggle mode={mode} onChange={m => { onMode(m); setPanelDismissed(false); setEdited(new Set()) }} />
      </div>

      {mode === 'per_case' ? (
        <div className="grid grid-cols-2 gap-2.5 text-[12px]">
          {/* Qty shipped */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">qty shipped</span>
              {edited.has('qty') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                type="number" step="any" min="0"
                value={qty}
                onChange={e => { setQty(e.target.value); markEdited('qty') }}
                onBlur={() => onChange({ rawQty: qty || null })}
                className={`flex-1 px-2 text-center ${inputBase} ${editedCls('qty')}`}
              />
              <select
                className="h-8 px-1.5 border border-line rounded bg-paper text-sm font-medium focus:outline-none"
              >
                <option>cs</option>
              </select>
            </div>
          </div>

          {/* Unit price */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">unit price</span>
              {edited.has('unitPrice') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('unitPrice')} ${edited.has('unitPrice') ? 'focus-within:border-blue' : 'focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10'}`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={unitPrice}
                onChange={e => { setUnitPrice(e.target.value); markEdited('unitPrice') }}
                onBlur={() => onChange({ rawUnitPrice: unitPrice || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
              <span className="text-ink-4 text-[12.5px]">/ cs</span>
            </div>
          </div>

          {/* Line total — full width */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">line total</span>
              {edited.has('lineTotal') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('lineTotal')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={lineTotal}
                onChange={e => { setLineTotal(e.target.value); markEdited('lineTotal') }}
                onBlur={() => onChange({ rawLineTotal: lineTotal || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 text-[12px]">
          {/* Qty shipped (weight) */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">qty shipped</span>
              {edited.has('wQty') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className="flex gap-1.5">
              <input
                type="number" step="any" min="0"
                value={wQty}
                onChange={e => { setWQty(e.target.value); markEdited('wQty') }}
                onBlur={() => onChange({ totalQty: wQty || null, totalQtyUOM: wQtyUOM })}
                className={`flex-1 px-2 text-center ${inputBase} ${editedCls('wQty')}`}
              />
              <select
                value={wQtyUOM}
                onChange={e => { setWQtyUOM(e.target.value); onChange({ totalQtyUOM: e.target.value }) }}
                className="h-8 px-1.5 border border-line rounded bg-paper text-sm font-medium focus:outline-none"
              >
                {['lb', 'kg', 'g', 'oz'].map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          {/* Rate */}
          <div>
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">rate</span>
              {edited.has('rate') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('rate')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={rate}
                onChange={e => { setRate(e.target.value); markEdited('rate') }}
                onBlur={() => onChange({ rate: rate || null, rateUOM })}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
              <span className="text-ink-4 text-[12.5px] shrink-0">/ {rateUOM}</span>
            </div>
          </div>

          {/* Line total */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-[5px]">
              <span className="text-ink-3 text-[11.5px]">line total</span>
              {edited.has('wTotal') && <span className="text-[9px] text-blue font-medium uppercase tracking-wide">edited</span>}
            </div>
            <div className={`flex items-center gap-1.5 px-2.5 h-8 border rounded transition-colors ${editedCls('wTotal')} focus-within:border-blue focus-within:ring-[3px] focus-within:ring-blue/10`}>
              <span className="text-ink-4 text-[12.5px]">$</span>
              <input
                type="number" step="any" min="0"
                value={wTotal}
                onChange={e => { setWTotal(e.target.value); markEdited('wTotal') }}
                onBlur={() => onChange({ rawLineTotal: wTotal || null })}
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
            </div>
          </div>
        </div>
      )}

      {/* Check row */}
      {math && (
        <div className="mt-[11px] pt-[9px] border-t border-dashed border-line flex items-center justify-between text-[11.5px] tabular-nums">
          <div>
            <span className="text-ink-4">check: </span>
            <span className="text-ink-2 ml-1">
              {mode === 'per_case'
                ? `${qty || '?'} × ${unitPrice ? formatCurrency(Number(unitPrice)) : '?'} = ${formatCurrency(math.computed)}`
                : `${wQty || '?'} × ${rate ? formatCurrency(Number(rate)) : '?'} = ${formatCurrency(math.computed)}`
              }
            </span>
          </div>
          {math.matches ? (
            <span className="flex items-center gap-1 text-green-text font-medium">
              <Check size={12} /> matches invoice
            </span>
          ) : (
            <span className="flex items-center gap-1 text-gold-2">
              <AlertTriangle size={12} /> {formatCurrency(Math.abs(math.delta))} off
            </span>
          )}
        </div>
      )}

      {/* Inline mismatch resolution */}
      {showPanel && math && (
        <MismatchPanel
          computed={math.computed}
          entered={math.entered}
          onAcceptComputed={() => {
            if (mode === 'per_case') {
              setLineTotal(math.computed.toFixed(2))
              onChange({ rawLineTotal: math.computed.toFixed(2) })
            } else {
              setWTotal(math.computed.toFixed(2))
              onChange({ rawLineTotal: math.computed.toFixed(2) })
            }
            setPanelDismissed(true)
          }}
          onRevertPrice={() => {
            if (mode === 'per_case') {
              const q = parseFloat(qty)
              if (q > 0 && math.entered > 0) {
                const reverted = (math.entered / q).toFixed(4)
                setUnitPrice(reverted)
                onChange({ rawUnitPrice: reverted })
              }
            } else {
              const q = parseFloat(wQty)
              if (q > 0 && math.entered > 0) {
                const reverted = (math.entered / q).toFixed(4)
                setRate(reverted)
                onChange({ rate: reverted })
              }
            }
            setPanelDismissed(true)
          }}
          onKeepAsIs={() => setPanelDismissed(true)}
        />
      )}
    </div>
  )
}

// ─── MismatchPanel ────────────────────────────────────────────────────────────
// Amber resolution UI when line math doesn't agree.

export function MismatchPanel({
  computed,
  entered,
  suggestedValue,
  onAcceptComputed,
  onRevertPrice,
  onKeepAsIs,
}: {
  computed: number
  entered: number
  suggestedValue?: number | null   // from reconcileInvoiceTotals (invoice-level suggestion)
  onAcceptComputed: () => void
  onRevertPrice: () => void
  onKeepAsIs: () => void
}) {
  const delta = computed - entered

  return (
    <div className="mt-[11px] bg-gold-soft rounded-lg p-3">
      {/* Header */}
      <div className="flex gap-2 items-start mb-[10px]">
        <AlertTriangle size={15} className="text-gold-2 mt-0.5 shrink-0" />
        <div className="flex-1 text-[12px] text-gold-2">
          <div className="font-semibold mb-1">Line total may be off</div>
          <div className="space-y-0.5 tabular-nums leading-[1.7]">
            <div>scanned line total: <strong>{formatCurrency(entered)}</strong></div>
            <div>computed from fields: <strong>{formatCurrency(computed)}</strong></div>
            <div className="border-t border-[#fcd34d]/60/60 pt-1 mt-1 font-medium">
              Δ <strong>{formatCurrency(Math.abs(delta))}</strong>
              {' '}{delta > 0 ? 'missing' : 'extra'}
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="text-[11px] text-gold-2 font-medium mb-[7px]">What&apos;s correct?</div>
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={onAcceptComputed}
          className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors font-medium"
        >
          <ArrowRight size={11} />
          use {formatCurrency(computed)}
        </button>
        <button
          type="button"
          onClick={onRevertPrice}
          className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors"
        >
          <RotateCcw size={11} />
          revert price
        </button>
        {suggestedValue !== undefined && suggestedValue !== null && (
          <button
            type="button"
            onClick={onAcceptComputed}
            className="flex items-center gap-1.5 text-[11px] px-[11px] py-[5px] bg-paper border border-gold text-gold-2 rounded hover:bg-gold-soft transition-colors"
          >
            <ZoomIn size={11} />
            view on invoice
          </button>
        )}
      </div>
      <div className="mt-[9px] pt-2 border-t border-[#fcd34d]/60 text-[11px] text-gold-2">
        Or{' '}
        <button
          type="button"
          onClick={onKeepAsIs}
          className="underline underline-offset-2 hover:text-gold-2 transition-colors"
        >
          keep as-is and flag for review
        </button>{' '}
        — discrepancy stays on invoice-level math check.
      </div>
    </div>
  )
}

// ─── ReconcileBanner ──────────────────────────────────────────────────────────
// Subtle amber collapsible banner in the invoice header when sum-of-lines
// doesn't match the OCR'd subtotal.

export function ReconcileBanner({
  reconciliation,
  onRecheck,
}: {
  reconciliation: ReconcileResult
  onRecheck?: () => void
}) {
  const [open, setOpen] = useState(false)

  if (reconciliation.status !== 'mismatch') return null

  const { delta, sumOfLines, invoiceSubtotal } = reconciliation

  return (
    <div className="mt-[13px] bg-gold-soft/80 border-l-2 border-gold-2 rounded-r-lg overflow-hidden">
      {/* Summary row */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-gold-2 hover:bg-gold-soft/50 transition-colors text-left"
      >
        <AlertTriangle size={14} className="text-gold-2 shrink-0" />
        <span className="flex-1">
          <strong>{formatCurrency(Math.abs(delta))} mismatch</strong>
          {' '}— sum of lines doesn&apos;t tie to invoice subtotal.
          {reconciliation.suggestedFixItemId && ' 1 line flagged.'}
        </span>
        <ChevronDown
          size={14}
          className={`text-gold-2 shrink-0 transition-transform duration-[180ms] ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded breakdown */}
      {open && (
        <div className="px-3 pb-3 pt-0 text-[12px] text-gold-2 border-t border-[#fcd34d]/60/50 tabular-nums">
          <div className="space-y-0 leading-[1.9] mt-2">
            <div className="flex justify-between">
              <span>Sum of line items</span>
              <span className="font-medium">{formatCurrency(sumOfLines)}</span>
            </div>
            <div className="flex justify-between">
              <span>Invoice subtotal</span>
              <span className="font-medium">{invoiceSubtotal !== null ? formatCurrency(invoiceSubtotal) : '—'}</span>
            </div>
            <div className="flex justify-between border-t border-[#fcd34d]/60/60 pt-1 mt-1 font-medium">
              <span>Δ {delta > 0 ? 'missing' : 'extra'}</span>
              <span>{formatCurrency(Math.abs(delta))}</span>
            </div>
          </div>
          {onRecheck && (
            <div className="flex justify-end mt-2">
              <button
                type="button"
                onClick={onRecheck}
                className="text-[11px] px-2.5 py-1 border border-gold rounded text-gold-2 hover:bg-gold-soft transition-colors"
              >
                Recheck OCR
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── ChipRow ──────────────────────────────────────────────────────────────────
// Filter chips + sort toggle. Shows up to 4 chips; overflow becomes "+N more".

const CHIP_ORDER: FilterKey[] = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch', 'priceDelta', 'catchweight']
const MAX_VISIBLE_CHIPS = 4

export function ChipRow({
  totalCount,
  counts,
  activeFilters,
  onToggle,
  sortMode,
  onSort,
}: {
  totalCount: number
  counts: Record<FilterKey, number>
  activeFilters: Set<FilterKey>
  onToggle: (k: FilterKey) => void
  sortMode: SortMode
  onSort: (m: SortMode) => void
}) {
  const [overflowOpen, setOverflowOpen] = useState(false)

  const withCounts = CHIP_ORDER.filter(k => counts[k] > 0)
  const visible  = withCounts.slice(0, MAX_VISIBLE_CHIPS)
  const overflow = withCounts.slice(MAX_VISIBLE_CHIPS)

  return (
    <div className="flex items-center gap-1.5 px-[22px] py-[11px] bg-paper border-b border-line flex-nowrap overflow-x-auto">
      {/* All chip */}
      <button
        type="button"
        onClick={() => activeFilters.size > 0 && onToggle(Array.from(activeFilters)[0])}
        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] border transition-colors whitespace-nowrap ${
          activeFilters.size === 0
            ? 'bg-ink text-paper border-ink font-medium'
            : 'border-line-2 text-ink-2 hover:bg-bg'
        }`}
      >
        All {totalCount}
      </button>

      {/* Filter chips */}
      {visible.map(k => {
        const active = activeFilters.has(k)
        const isWarn   = ['needsLink', 'mathCheck', 'formatMismatch', 'modeMismatch'].includes(k)
        const ringCls  = k === 'needsLink' ? 'bg-red' : isWarn ? 'bg-gold' : 'bg-blue'
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] border transition-colors whitespace-nowrap ${
              active
                ? 'bg-ink text-paper border-ink font-medium'
                : 'border-line-2 text-ink-2 hover:bg-bg'
            }`}
          >
            {!active && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ringCls}`} />}
            {FILTER_LABELS[k]} {counts[k]}
          </button>
        )
      })}

      {/* Overflow */}
      {overflow.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOverflowOpen(o => !o)}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[12px] border border-dashed border-line-2 text-ink-3 hover:bg-bg whitespace-nowrap"
          >
            +{overflow.length} more
          </button>
          {overflowOpen && (
            <div className="absolute top-full left-0 mt-1 bg-paper border border-line rounded-lg shadow-lg z-10 py-1 min-w-[160px]">
              {overflow.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => { onToggle(k); setOverflowOpen(false) }}
                  className="w-full text-left px-3 py-2 text-[12px] text-ink-2 hover:bg-bg flex items-center justify-between"
                >
                  <span>{FILTER_LABELS[k]}</span>
                  <span className="text-ink-4 ml-4">{counts[k]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* Sort toggle */}
      <button
        type="button"
        onClick={() => {
          const modes: SortMode[] = ['invoice', 'priceDelta', 'unlinked']
          const next = modes[(modes.indexOf(sortMode) + 1) % modes.length]
          onSort(next)
        }}
        className="inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink transition-colors whitespace-nowrap px-2 py-1 shrink-0"
      >
        <ChevronDown size={12} className="rotate-180" />
        {sortMode === 'invoice' ? 'invoice order' : sortMode === 'priceDelta' ? 'price delta' : 'unlinked first'}
      </button>
    </div>
  )
}

```


---

## `src/components/invoices/v2/issues.tsx`

```tsx
'use client'
// Issue blocks for the redesigned line card. One `.issue` primitive — a coloured
// badge + plain-English description + a row of decision buttons — replaces the
// three different warning languages the old drawer used (mock §1, §3, §7).

import { ArrowRight, Check } from 'lucide-react'
import { IssueBadge, ActButton, VariancePill, type IssueKind } from './atoms'
import { useDrawerContext } from './context'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import { formatCurrency } from '@/lib/invoice/formatters'
import { derivePricingMode } from '@/lib/invoice/predicates'
import type { ScanItem } from '@/components/invoices/types'

// ─── IssueShell ────────────────────────────────────────────────────────────────
// Badge + description on one row, actions below. The container border/divider is
// supplied by the card; here we only own the badge/desc/actions stack.

function IssueShell({
  kind,
  label,
  children,
  actions,
  resolved = false,
}: {
  kind: IssueKind
  label: string
  children: React.ReactNode
  actions: React.ReactNode
  /** Decision made — render the block in a green, acknowledged state. */
  resolved?: boolean
}) {
  return (
    <div className={`px-4 py-2.5 border-b border-dashed border-line last:border-b-0 flex flex-col gap-2.5 transition-colors ${resolved ? 'bg-green-soft/40' : ''}`}>
      <div className="flex items-start gap-2.5">
        {resolved ? (
          <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-green-soft text-green-text shrink-0 inline-flex items-center gap-1">
            <Check size={10} /> {label}
          </span>
        ) : (
          <IssueBadge kind={kind}>{label}</IssueBadge>
        )}
        <div className="text-[12.5px] text-ink-2 leading-[1.45] min-w-0">{children}</div>
      </div>
      <div className="flex gap-1.5 flex-wrap pl-0">{actions}</div>
    </div>
  )
}

// ─── ModeIssue ───────────────────────────────────────────────────────────────
// Invoice prices per-weight but the product defaults per-case (or vice versa).
// Two explicit choices: write the mode back to the product, or treat this line
// in the product's mode just for this invoice.

export function ModeIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  const detected = derivePricingMode(item)
  const detectedLbl = detected === 'per_weight' ? 'per-weight' : 'per-case'
  const productMode = item.matchedItem?.priceType === 'UOM' ? 'per-weight' : 'per-case'
  const writeback = ctx.modeWritebackItems.has(lineId)

  return (
    <IssueShell
      kind="mode"
      label="Mode mismatch"
      resolved={writeback}
      actions={
        <>
          <ActButton
            variant={writeback ? 'primary' : 'default'}
            onClick={() => {
              if (!writeback) {
                ctx.toggleModeWriteback(lineId)
                // Persist the resolved mode so approve writes the invoice's mode
                // (and its per-weight price) back to the inventory item.
                ctx.updateLine(lineId, { pricingMode: detected })
              }
            }}
          >
            Switch product to {detectedLbl}
          </ActButton>
          <ActButton
            variant={!writeback ? 'primary' : 'default'}
            onClick={() => {
              if (writeback) ctx.toggleModeWriteback(lineId)
              // Treat this line in the product's mode for this invoice only.
              ctx.updateLine(lineId, { pricingMode: detected === 'per_weight' ? 'per_case' : 'per_weight' })
            }}
          >
            Treat as {productMode} this time
          </ActButton>
        </>
      }
    >
      Invoice is <b className="font-semibold text-ink">{detectedLbl}</b> but{' '}
      <b className="font-semibold text-ink">{item.matchedItem?.itemName}</b> defaults to{' '}
      <b className="font-semibold text-ink">{productMode}</b>. The two unit systems give
      different costs downstream.
    </IssueShell>
  )
}

// ─── NewSkuIssue ───────────────────────────────────────────────────────────────
// The line didn't match any inventory item. Create it, search to link, or skip.

export function NewSkuIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  return (
    <IssueShell
      kind="sku"
      label="New ingredient"
      actions={
        <>
          <ActButton variant="primary" onClick={() => ctx.openCreateNew(item)}>
            Create &ldquo;{item.rawDescription}&rdquo;
          </ActButton>
          <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Search inventory</ActButton>
          <ActButton variant="danger" onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}>
            Skip (no inventory write)
          </ActButton>
        </>
      }
    >
      This SKU isn&rsquo;t in your inventory yet. Create it now, or link to an existing item.
    </IssueShell>
  )
}

// ─── PriceCompare ──────────────────────────────────────────────────────────────
// The was → now card. Normalised $/base-unit on both sides + delta pill.

export function PriceCompare({ item }: { item: ScanItem }) {
  const norm = computeNormalisedPrices(item)
  if (!norm) return null
  const factor   = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
  const rateUnit = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each'
  const prev = norm.inventoryPPB * factor
  const next = norm.invoicePPB * factor
  const pct  = norm.pctDiff

  return (
    <div className="grid grid-cols-[1fr_24px_1fr] gap-2.5 items-center bg-bg border border-line rounded-lg px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Inventory has</span>
        <span className="font-mono text-[13px] font-semibold text-ink tabular-nums">{formatCurrency(prev)} / {rateUnit}</span>
      </div>
      <ArrowRight size={14} className="text-line-2 mx-auto" />
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.02em] text-ink-4">Invoice says</span>
        <span className="font-mono text-[13px] font-semibold text-red-text tabular-nums">{formatCurrency(next)} / {rateUnit}</span>
      </div>
      {Math.abs(pct) >= 0.1 && (
        <div className="col-span-3 flex items-center gap-2 pt-2 border-t border-dashed border-line">
          <VariancePill percent={Math.abs(pct)} direction={pct > 0 ? 'up' : 'down'} />
          <span className="font-mono text-[11px] text-ink-3">re-costs every recipe that uses this ingredient</span>
        </div>
      )}
    </div>
  )
}

// ─── PriceIssue ────────────────────────────────────────────────────────────────
// Big price jump on a linked item. Accept (the spine writes the new price),
// fix a UOM error in the math below, or dispute (skip — no write).

export function PriceIssue({
  item,
  lineId,
  onFixUom,
}: {
  item: ScanItem
  lineId: string
  onFixUom: () => void
}) {
  const ctx = useDrawerContext()
  const acked = ctx.acknowledgedPriceLines.has(lineId)
  const norm = computeNormalisedPrices(item)
  const pct = norm ? norm.pctDiff : (item.priceDiffPct ? Number(item.priceDiffPct) : 0)
  const factor = norm && (norm.baseUnit === 'g' || norm.baseUnit === 'ml') ? 1000 : 1
  const rateUnit = norm ? (norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each') : ''

  return (
    <IssueShell
      kind="price"
      label={`Price ${pct > 0 ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%`}
      resolved={acked}
      actions={
        <>
          <ActButton variant={acked ? 'primary' : 'default'} onClick={() => ctx.acknowledgePrice(lineId)}>
            {acked ? 'New price accepted' : 'Accept new price'}
          </ActButton>
          <ActButton onClick={onFixUom}>It&rsquo;s a UOM error → fix</ActButton>
          <ActButton variant="danger" onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}>
            Dispute
          </ActButton>
        </>
      }
    >
      {norm ? (
        <>
          Was <b className="font-semibold text-ink">{formatCurrency(norm.inventoryPPB * factor)} / {rateUnit}</b>.
          This one bills at <b className="font-semibold text-ink">{formatCurrency(norm.invoicePPB * factor)} / {rateUnit}</b>.
          {Math.abs(pct) > 1000 && ' Almost certainly a UOM mistake — confirm before it re-costs your recipes.'}
        </>
      ) : (
        <>This line&rsquo;s price moved <b className="font-semibold text-ink">{Math.abs(pct).toFixed(1)}%</b> from the last invoice — confirm before approving.</>
      )}
      {norm && <div className="mt-2"><PriceCompare item={item} /></div>}
    </IssueShell>
  )
}

```


---

## `src/components/invoices/v2/InvoiceReviewDrawer.tsx`

```tsx
'use client'
// Phase 5 — InvoiceReviewDrawer: the top-level container.
// Owns all shared state, provides DrawerContext, and renders the drawer panel.

import {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react'
import { X, Check, Loader2, AlertTriangle, ChevronUp, ChevronDown, TrendingUp, TrendingDown, RotateCcw, Package, BookOpen, Tag, Search } from 'lucide-react'
import { DrawerContext, type DrawerContextValue } from './context'
import { LineItemCard } from './card'
import { type ReconcileResult } from './composites'
import { ActButton, IssueBadge } from './atoms'
import { ImpactStrip, AlertBanner, ReviewProgress, SectionDivider, type ImpactMetric, type ReviewSegment } from './chrome'
import { ImageViewerV2, type BBox } from './ImageViewer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { InventoryItemDrawer } from '@/components/inventory/InventoryItemDrawer'
import type { Session, ScanItem, SessionSummary } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { reconcileInvoiceTotals } from '@/lib/invoice/calculations'
import {
  type FilterKey, type SortMode,
} from '@/lib/invoice/filters'
import {
  isUnlinked, hasMathCheck, hasModeMismatch, hasFormatMismatch,
} from '@/lib/invoice/predicates'
import { lineUnresolved, isCharge, isBigPriceChange } from '@/lib/invoice/resolution'
import { formatCurrency } from '@/lib/invoice/formatters'
import { PACK_UOMS, PURCHASE_UNITS, calcPricePerBaseUnit } from '@/lib/utils'

// ─── InvoiceHeader ─────────────────────────────────────────────────────────────

function supplierInitials(name: string | null): string {
  if (!name) return '??'
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function InvoiceHeader({
  session,
  onClose,
  queuePos,
  onPrev,
  onNext,
}: {
  session: Session
  onClose: () => void
  queuePos: { idx: number; total: number }
  onPrev?: () => void
  onNext?: () => void
}) {
  const total    = session.total    ? Number(session.total)    : null
  const subtotal = session.subtotal ? Number(session.subtotal) : null
  const tax      = session.tax      ? Number(session.tax)      : null
  const itemCount = session.scanItems.filter(i => i.action !== 'SKIP').length

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${itemCount} line${itemCount !== 1 ? 's' : ''}`)

  return (
    <div
      className="grid grid-cols-[32px_1fr_auto_auto] items-center gap-4 px-[22px] py-[16px] bg-paper border-b border-line"
      style={{ paddingTop: 'calc(16px + env(safe-area-inset-top, 0px))' }}
    >
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        className="w-8 h-8 grid place-items-center rounded-lg border border-line text-ink-3 hover:border-ink-4 hover:text-ink-2 transition-colors"
      >
        <X size={16} />
      </button>

      {/* Avatar + title + meta */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-[9px] bg-ink text-paper grid place-items-center font-mono text-[12px] font-semibold shrink-0">
          {supplierInitials(session.supplierName)}
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-[23px] leading-[1.1] tracking-[-0.02em] text-ink truncate">
            {session.supplierName ?? 'Unknown supplier'}
          </h2>
          <div className="font-mono text-[11px] text-ink-4 mt-[3px] flex items-center gap-2 flex-wrap">
            {metaParts.map((p, i) => (
              <span key={p} className="flex items-center gap-2">
                {i > 0 && <span className="text-line-2">·</span>}
                {p}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Total */}
      <div className="text-right pr-1.5">
        <div className="font-mono text-[28px] font-semibold tracking-[-0.02em] text-ink tabular-nums leading-none">
          {total !== null ? formatCurrency(total) : '—'}
        </div>
        {(subtotal !== null || tax !== null) && (
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] tabular-nums">
            {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
            {subtotal !== null && tax !== null && ' · '}
            {tax !== null && `tax ${formatCurrency(tax)}`}
          </div>
        )}
      </div>

      {/* Prev / next in queue */}
      <div className="hidden md:flex items-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!onPrev}
          aria-label="Previous invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronUp size={13} className="-rotate-90" />
        </button>
        <span className="font-mono text-[10.5px] text-ink-4 px-1.5 tabular-nums">{queuePos.idx} / {queuePos.total}</span>
        <button
          type="button"
          onClick={onNext}
          disabled={!onNext}
          aria-label="Next invoice"
          className="w-7 h-7 grid place-items-center rounded-[7px] border border-line text-ink-4 hover:border-ink-4 hover:text-ink-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={13} className="-rotate-90" />
        </button>
      </div>
    </div>
  )
}

// ─── DrawerFooter ──────────────────────────────────────────────────────────────
// Commits, doesn't decide (mock §4). Left = a plain-English summary of exactly
// what approving writes; right = Reject + the one ink-on-gold Approve & post.

function DrawerFooter({
  priceWrites,
  newItems,
  supplierLink,
  canApprove,
  disabledReason,
  onApprove,
  onReject,
  saveStatus,
}: {
  priceWrites: number
  newItems: number
  supplierLink: boolean
  canApprove: boolean
  disabledReason: string
  onApprove: () => void
  onReject: () => void
  saveStatus: 'idle' | 'saving' | 'error'
}) {
  const parts: string[] = []
  parts.push(`${priceWrites} price${priceWrites !== 1 ? 's' : ''} to inventory`)
  if (newItems > 0) parts.push(`creates ${newItems} new item${newItems !== 1 ? 's' : ''}`)
  if (supplierLink) parts.push('links 1 supplier')

  return (
    <div
      className="grid grid-cols-[1fr_auto] gap-4 items-center px-[22px] py-3 bg-paper border-t border-line shrink-0"
      style={{ paddingBottom: 'calc(14px + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink-3 leading-[1.5]">
          Approve writes <b className="text-ink-2 font-medium">{parts.join(', ')}</b>, and re-costs the recipes that use them.
        </div>
        <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5"><span className="w-[5px] h-[5px] rounded-full bg-gold" /> Reversible — re-open any time</span>
          {saveStatus === 'saving' && <span className="inline-flex items-center gap-1 text-ink-4"><Loader2 size={11} className="animate-spin" /> saving</span>}
          {saveStatus === 'error'  && <span className="inline-flex items-center gap-1 text-red"><AlertTriangle size={11} /> save failed</span>}
        </div>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          type="button"
          onClick={onReject}
          className="px-4 py-2.5 text-[13.5px] font-medium text-ink-3 bg-paper border border-line rounded-[9px] hover:border-ink-4 hover:text-ink transition-colors"
        >
          Reject invoice
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={!canApprove}
          title={disabledReason}
          className={`inline-flex items-center gap-2 px-[18px] py-2.5 text-[13.5px] font-medium rounded-[9px] transition-colors ${
            canApprove
              ? 'bg-ink text-paper hover:bg-ink-2'
              : 'bg-line text-ink-4 cursor-not-allowed'
          }`}
        >
          <Check size={14} className={canApprove ? 'text-gold' : ''} />
          Approve &amp; post
          <span className="font-mono text-[9.5px] px-1.5 py-0.5 rounded bg-paper/15 text-bg">⌘ ⏎</span>
        </button>
      </div>
    </div>
  )
}

// ─── InvoiceReviewDrawer ───────────────────────────────────────────────────────

export function InvoiceReviewDrawer({
  sessionId,
  onClose,
  onApproveOrReject,
  onNavigate,
  allSessions = [],
}: {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}) {
  const { revenueCenters } = useRc()

  // Lock background scroll while the drawer is open — otherwise wheel events over
  // a non-scrolling area of the drawer (PDF pane, header, gaps) chain through to
  // the page behind it. The page's scroll container is <html>, not <body>, so we
  // must lock the documentElement (locking body alone has no effect here).
  useEffect(() => {
    if (sessionId === null) return
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => { html.style.overflow = prevHtml; document.body.style.overflow = prevBody }
  }, [sessionId])

  // ── Session data ────────────────────────────────────────────────────────────
  const [session,     setSession]     = useState<Session | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [saveStatus,  setSaveStatus]  = useState<'idle' | 'saving' | 'error'>('idle')
  const [approving,   setApproving]   = useState(false)
  const [approved,    setApproved]    = useState(false)

  // ── Supplier linking ────────────────────────────────────────────────────────
  const [linkedSupplierId,  setLinkedSupplierId]  = useState<string | null>(null)
  const [supplierComboOpen, setSupplierComboOpen] = useState(false)
  const [supplierSearch,    setSupplierSearch]    = useState('')
  const [allSuppliers, setAllSuppliers] = useState<Array<{ id: string; name: string }>>([])

  const loadSuppliers = useCallback(async () => {
    if (allSuppliers.length > 0) return
    try {
      const data = await fetch('/api/suppliers').then(r => r.ok ? r.json() : [])
      setAllSuppliers(Array.isArray(data) ? data : (data.suppliers ?? []))
    } catch {}
  }, [allSuppliers.length])

  const handleLinkSupplier = useCallback(async (supplierId: string) => {
    if (!session) return
    setLinkedSupplierId(supplierId)
    setSupplierComboOpen(false)
    setSupplierSearch('')
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId }),
    })
  }, [session])

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
      setLinkedSupplierId(data.supplierId ?? null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Silent refresh — updates session data without showing the loading spinner,
  // so child component state (expanded cards, staged edits) is preserved.
  const refreshSession = useCallback(async (id: string) => {
    try {
      const res  = await fetch(`/api/invoices/sessions/${id}`)
      const data = await res.json()
      setSession(data)
    } catch { /* ignore — stale session data stays on screen */ }
  }, [])

  useEffect(() => {
    if (!sessionId) { setSession(null); return }
    setApproved(false)
    fetchSession(sessionId)
  }, [sessionId, fetchSession])

  // ── UI state ────────────────────────────────────────────────────────────────
  const [editedLines,       setEditedLines]       = useState<Map<string, Partial<ScanItem>>>(new Map())
  const [expandedLineIds,   setExpandedLineIds]   = useState<Set<string>>(new Set())
  const [flashingLineIds,   setFlashingLineIds]   = useState<Set<string>>(new Set())
  const [activeFilters,     setActiveFilters]     = useState<Set<FilterKey>>(new Set())
  const [sortMode,          setSortMode]          = useState<SortMode>('invoice')
  const [pickingLinkForId,  setPickingLinkForId]  = useState<string | null>(null)
  const [modeWritebackItems, setModeWritebackItems] = useState<Set<string>>(new Set())
  const [acknowledgedPriceLines, setAcknowledgedPriceLines] = useState<Set<string>>(new Set())
  const [creatingNewForItem,      setCreatingNewForItem]      = useState<ScanItem | null>(null)
  const [editingInventoryItemId,  setEditingInventoryItemId]  = useState<string | null>(null)
  const [activeBboxItemId,   setActiveBboxItemId]    = useState<string | null>(null)
  const [mobileTab,          setMobileTab]          = useState<'review' | 'image'>('review')
  const [reviewSegment,      setReviewSegment]      = useState<ReviewSegment>('all')
  const [supplierSkipped,    setSupplierSkipped]    = useState(false)
  const [bannerDismissed,    setBannerDismissed]    = useState(false)
  // Snapshot of which lines needed attention at load — the stable denominator
  // for the "X of N resolved" progress bar.
  const [initialAttention,   setInitialAttention]   = useState<{ lineIds: Set<string>; supplier: boolean }>({ lineIds: new Set(), supplier: false })

  // Ref for the scrollable list container
  const listRef = useRef<HTMLDivElement>(null)

  // ── Auto-expand attention items when session first loads ────────────────────
  useEffect(() => {
    if (!session) return
    const toExpand = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (isUnlinked(i) || hasMathCheck(i) || hasModeMismatch(i)))
        .map(i => i.id),
    )
    setExpandedLineIds(toExpand)
    setEditedLines(new Map())
    setActiveFilters(new Set())
    setSortMode('invoice')
    setPickingLinkForId(null)
    setModeWritebackItems(new Set())
    setAcknowledgedPriceLines(new Set())
    setActiveBboxItemId(null)
    setMobileTab('review')
    setReviewSegment('all')
    setSupplierSkipped(false)
    setBannerDismissed(false)

    // Snapshot the lines that need a decision at load — the progress denominator.
    const attentionIds = new Set(
      session.scanItems
        .filter(i => i.action !== 'SKIP' && (
          isUnlinked(i) || hasMathCheck(i) || hasModeMismatch(i) || hasFormatMismatch(i) || isBigPriceChange(i)
        ))
        .map(i => i.id),
    )
    setInitialAttention({ lineIds: attentionIds, supplier: !session.supplierId })
  }, [session])

  // ── Computed data ────────────────────────────────────────────────────────────
  const effectiveLines = useMemo(() => {
    if (!session) return []
    return session.scanItems.map(item => {
      const edits = editedLines.get(item.id)
      return edits ? { ...item, ...edits } : item
    })
  }, [session, editedLines])

  const reconciliation = useMemo<ReconcileResult | null>(() => {
    if (!session) return null
    const sub = session.subtotal ? Number(session.subtotal) : null
    const r   = reconcileInvoiceTotals(effectiveLines, sub)
    return r
  }, [session, effectiveLines])

  // Per-line resolution options (mode writeback / price acknowledgement).
  const optsFor = useCallback(
    (id: string) => ({ modeWriteback: modeWritebackItems.has(id), priceAck: acknowledgedPriceLines.has(id) }),
    [modeWritebackItems, acknowledgedPriceLines],
  )

  const lineIsAttention = useCallback((i: ScanItem) =>
    isUnlinked(i) || hasModeMismatch(i) || hasFormatMismatch(i) || hasMathCheck(i) || isBigPriceChange(i),
  [])

  // Group lines into the mock's three sections + per-line invoice numbering.
  const sections = useMemo(() => {
    const active  = effectiveLines.filter(i => !isCharge(i))
    const charges = effectiveLines.filter(i => isCharge(i))
    const ordered        = [...active].sort((a, b) => a.sortOrder - b.sortOrder)
    const orderedCharges = [...charges].sort((a, b) => a.sortOrder - b.sortOrder)
    const displayNo = new Map<string, number>()
    ordered.forEach((i, idx) => displayNo.set(i.id, idx + 1))
    orderedCharges.forEach((i, idx) => displayNo.set(i.id, ordered.length + idx + 1))
    return {
      attention: ordered.filter(lineIsAttention),
      matched:   ordered.filter(i => !lineIsAttention(i)),
      charges:   orderedCharges,
      displayNo,
      activeCount: active.length,
    }
  }, [effectiveLines, lineIsAttention])

  const supplierNeedsLink = !linkedSupplierId && !supplierSkipped

  // Progress bar — stable denominator from the load-time snapshot.
  const progress = useMemo(() => {
    const total = initialAttention.lineIds.size + (initialAttention.supplier ? 1 : 0)
    let resolved = 0
    for (const id of initialAttention.lineIds) {
      const line = effectiveLines.find(l => l.id === id)
      if (!line || isCharge(line) || !lineUnresolved(line, optsFor(id))) resolved++
    }
    if (initialAttention.supplier && (linkedSupplierId || supplierSkipped)) resolved++
    return { total, resolved }
  }, [effectiveLines, initialAttention, optsFor, linkedSupplierId, supplierSkipped])

  // Approve gate — computed over CURRENT state so edits that introduce a new
  // issue re-block approval (the snapshot above only fixes the progress total).
  const currentlyUnresolved =
    sections.attention.filter(i => lineUnresolved(i, optsFor(i.id))).length +
    (supplierNeedsLink && initialAttention.supplier ? 1 : 0)
  const canApprove = currentlyUnresolved === 0
  const disabledReason = canApprove
    ? ''
    : `${currentlyUnresolved} ${currentlyUnresolved === 1 ? 'issue needs' : 'issues need'} a decision`

  // Impact-strip + footer metrics (only what's computable before approve).
  const priceWrites   = effectiveLines.filter(i => i.action !== 'SKIP' && i.matchedItemId).length
  const newItemsCount = effectiveLines.filter(i => i.action === 'CREATE_NEW').length
  const impactMetrics: ImpactMetric[] = [
    { label: 'Inventory writes', value: `${priceWrites} price${priceWrites !== 1 ? 's' : ''}` },
    ...(newItemsCount > 0 ? [{ label: 'New items', value: String(newItemsCount) }] : []),
    {
      label: 'Supplier',
      value: linkedSupplierId ? 'linked' : supplierSkipped ? 'skipped' : 'link pending',
      tone: (linkedSupplierId || supplierSkipped) ? undefined : ('warn' as const),
    },
  ]

  const segmentCounts = { all: sections.activeCount, issues: sections.attention.length, matched: sections.matched.length }

  // ── Review queue navigation (prev/next invoice in the inbox) ────────────────
  const reviewQueueIds = useMemo(
    () => allSessions.filter(s => s.status === 'REVIEW').map(s => s.id),
    [allSessions],
  )
  const queueIdx  = session ? reviewQueueIds.indexOf(session.id) : -1
  const queuePos  = { idx: queueIdx >= 0 ? queueIdx + 1 : 1, total: Math.max(reviewQueueIds.length, 1) }
  const navPrev   = onNavigate && queueIdx > 0 ? () => onNavigate(reviewQueueIds[queueIdx - 1]) : undefined
  const navNext   = onNavigate && queueIdx >= 0 && queueIdx < reviewQueueIds.length - 1
    ? () => onNavigate(reviewQueueIds[queueIdx + 1]) : undefined

  // ── Duplicate detection ─────────────────────────────────────────────────────
  const duplicateSessions = useMemo(() => {
    if (!session?.invoiceNumber) return []
    return allSessions.filter(s =>
      s.id !== session.id && s.invoiceNumber === session.invoiceNumber
    )
  }, [session, allSessions])

  // ── Context helpers ─────────────────────────────────────────────────────────
  const getEffectiveLine = useCallback((id: string): ScanItem => {
    const base  = session?.scanItems.find(i => i.id === id)
    if (!base) throw new Error(`Line ${id} not found`)
    const edits = editedLines.get(id)
    return edits ? { ...base, ...edits } : base
  }, [session, editedLines])

  const getItemRc = useCallback((id: string): RevenueCenter | null => {
    const line = getEffectiveLine(id)
    if (!line.revenueCenterId) return null
    return revenueCenters.find(rc => rc.id === line.revenueCenterId) ?? null
  }, [getEffectiveLine, revenueCenters])

  // ── Line mutations ──────────────────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const persistEdit = useCallback(async (id: string, patch: Partial<ScanItem>) => {
    if (!session) return
    setSaveStatus('saving')
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanItemId: id, ...patch }),
      })
      if (!res.ok) setSaveStatus('error')
      else setSaveStatus('idle')
    } catch {
      setSaveStatus('error')
    }
  }, [session])

  const updateLine = useCallback((id: string, patch: Partial<ScanItem>) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.set(id, { ...prev.get(id), ...patch })
      return next
    })
    // Debounce the server save by 600ms to batch rapid field edits
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persistEdit(id, patch), 600)
  }, [persistEdit])

  const clearLineEdits = useCallback((id: string) => {
    setEditedLines(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  // ── Expand / collapse ───────────────────────────────────────────────────────
  const toggleExpand = useCallback((id: string, forceOpen?: boolean) => {
    setExpandedLineIds(prev => {
      const next = new Set(prev)
      const willOpen = forceOpen || !next.has(id)
      if (willOpen) next.add(id)
      else next.delete(id)
      // Track which item to highlight in the image viewer
      setActiveBboxItemId(willOpen ? id : null)
      return next
    })
  }, [])

  // Pending scroll target — set by J/K navigation, consumed after expand.
  const scrollPendingRef = useRef<string | null>(null)

  // After expandedLineIds updates, handle pending scroll + flash
  useEffect(() => {
    const lineId = scrollPendingRef.current
    if (!lineId) return
    scrollPendingRef.current = null
    const el = listRef.current?.querySelector(`[data-line-id="${lineId}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setFlashingLineIds(prev => new Set(prev).add(lineId))
    setTimeout(() => {
      setFlashingLineIds(prev => {
        const next = new Set(prev)
        next.delete(lineId)
        return next
      })
    }, 1400)
  }, [expandedLineIds])

  // ── RC assignment ───────────────────────────────────────────────────────────
  const setLineRc = useCallback((id: string, rc: RevenueCenter | null) => {
    updateLine(id, { revenueCenterId: rc?.id ?? null })
  }, [updateLine])

  // ── Filters / sort ──────────────────────────────────────────────────────────
  const toggleFilter = useCallback((k: FilterKey) => {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }, [])

  // ── Mode writeback ──────────────────────────────────────────────────────────
  const toggleModeWriteback = useCallback((id: string) => {
    setModeWritebackItems(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // ── Price-change acknowledgement ─────────────────────────────────────────────
  const acknowledgePrice = useCallback((id: string) => {
    setAcknowledgedPriceLines(prev => new Set(prev).add(id))
  }, [])

  // ── Approve ─────────────────────────────────────────────────────────────────
  const handleApprove = async () => {
    if (!session) return
    setApproving(true)
    try {
      const res    = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        alert(`Approval failed: ${result.error ?? res.statusText}`)
        return
      }
      setApproved(true)
      onApproveOrReject()
      if (result.queued) onClose()
    } catch {
      alert('Network error — please try again.')
    } finally {
      setApproving(false)
    }
  }

  // ── Reject ──────────────────────────────────────────────────────────────────
  const handleReject = async () => {
    if (!session) return
    const ok = window.confirm('Reject this invoice? It will be marked as rejected and no prices will be updated.')
    if (!ok) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  // ── Keyboard model (mock §6): Esc close · ⌘⏎ approve · R reject · J/K nav ────
  const visibleIdsRef = useRef<string[]>([])
  const focusedIdRef  = useRef<string | null>(null)

  const focusLine = useCallback((id: string) => {
    focusedIdRef.current = id
    scrollPendingRef.current = id
    toggleExpand(id, true)
  }, [toggleExpand])

  useEffect(() => {
    const reviewing = !!session && !approved && !approving
      && session.status !== 'APPROVED' && session.status !== 'REJECTED'
    if (!reviewing) return
    // Don't steal keys while a nested modal is open.
    if (creatingNewForItem || editingInventoryItemId) return

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (canApprove) handleApprove()
        return
      }
      if (typing) return
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); handleReject(); return }
      if (e.key === '[' && navPrev) { e.preventDefault(); navPrev(); return }
      if (e.key === ']' && navNext) { e.preventDefault(); navNext(); return }
      if (e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const ids = visibleIdsRef.current
        if (ids.length === 0) return
        e.preventDefault()
        const down = e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown'
        const cur  = focusedIdRef.current ? ids.indexOf(focusedIdRef.current) : -1
        const next = down
          ? ids[Math.min(cur + 1, ids.length - 1)] ?? ids[0]
          : ids[Math.max(cur - 1, 0)] ?? ids[0]
        focusLine(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, approved, approving, creatingNewForItem, editingInventoryItemId, canApprove, navPrev, navNext, focusLine, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the J/K navigation order in sync with what's actually rendered.
  useEffect(() => {
    const ids: string[] = []
    if (reviewSegment !== 'matched') ids.push(...sections.attention.map(i => i.id))
    if (reviewSegment !== 'issues')  ids.push(...sections.matched.map(i => i.id))
    if (reviewSegment === 'all')     ids.push(...sections.charges.map(i => i.id))
    visibleIdsRef.current = ids
  }, [sections, reviewSegment])

  // ── Compute active bbox for the image viewer ────────────────────────────────
  const activeBbox = useMemo<BBox | null>(() => {
    if (!activeBboxItemId) return null
    const line = session?.scanItems.find(i => i.id === activeBboxItemId)
    const edits = editedLines.get(activeBboxItemId)
    const effective = edits ? { ...line, ...edits } : line
    const b = effective?.bbox
    if (!b || typeof b !== 'object') return null
    const bb = b as Record<string, unknown>
    if (
      typeof bb.x !== 'number' || typeof bb.y !== 'number' ||
      typeof bb.w !== 'number' || typeof bb.h !== 'number'
    ) return null
    return { page: typeof bb.page === 'number' ? bb.page : 0, x: bb.x, y: bb.y, w: bb.w, h: bb.h }
  }, [activeBboxItemId, session, editedLines])

  // ── Context value ────────────────────────────────────────────────────────────
  const ctxValue = useMemo<DrawerContextValue>(() => ({
    lines: session?.scanItems ?? [],
    revenueCenters,
    editedLines,
    expandedLineIds,
    flashingLineIds,
    activeFilters,
    sortMode,
    pickingLinkForId,
    modeWritebackItems,
    acknowledgedPriceLines,
    reconciliation,
    getEffectiveLine,
    getItemRc,
    updateLine,
    clearLineEdits,
    toggleExpand,
    setLineRc,
    startLinkPicker: (id) => setPickingLinkForId(id),
    closeLinkPicker: ()   => setPickingLinkForId(null),
    openCreateNew:        (item) => setCreatingNewForItem(item),
    openInventoryEdit:    (id)   => setEditingInventoryItemId(id),
    toggleModeWriteback,
    acknowledgePrice,
    activeBboxItemId,
    toggleFilter,
    setSortMode,
  }), [
    session, revenueCenters, editedLines, expandedLineIds, flashingLineIds,
    activeFilters, sortMode, pickingLinkForId, modeWritebackItems, acknowledgedPriceLines, reconciliation,
    getEffectiveLine, getItemRc, updateLine, clearLineEdits, toggleExpand,
    setLineRc, toggleModeWriteback, acknowledgePrice, activeBboxItemId, toggleFilter,
  ])

  // ── Panel open/close animation ───────────────────────────────────────────────
  const isOpen = sessionId !== null

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/25 z-40 transition-opacity"
          onClick={onClose}
        />
      )}

      {/* Drawer panel — wider to fit image viewer + review side by side */}
      <div
        className={`fixed inset-y-0 right-0 z-[60] bg-paper shadow-2xl flex flex-col transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{
          width: (!approved && session?.status !== 'APPROVED' && session?.status !== 'REJECTED' && session?.files?.length)
            ? '1340px' : '620px',
          maxWidth: '100vw',
        }}
      >
        {loading || !session ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={28} className="text-line-2 animate-spin" />
          </div>
        ) : approved || session.status === 'APPROVED' || session.status === 'REJECTED' ? (
          <ApprovedView
            session={session}
            onClose={onClose}
            onReviewAgain={() => {
              setApproved(false)
              onApproveOrReject()
              fetchSession(session.id)
            }}
          />
        ) : (
          <DrawerContext.Provider value={ctxValue}>
            {/* Full-width header */}
            <InvoiceHeader
              session={session}
              onClose={onClose}
              queuePos={queuePos}
              onPrev={navPrev}
              onNext={navNext}
            />

            {/* Cost-chrome impact strip — Principle 01 */}
            <ImpactStrip metrics={impactMetrics} helper="on approve" />

            {/* Invoice-wide banners */}
            {duplicateSessions.length > 0 && !bannerDismissed && (
              <div className="flex items-center gap-3 bg-red-soft border-b border-[#fecaca] px-[22px] py-[11px] text-[13px] text-red-text">
                <AlertTriangle size={16} className="text-red shrink-0" strokeWidth={2.2} />
                <span className="flex-1 min-w-0">
                  <b className="font-semibold">Possible duplicate.</b>{' '}
                  Invoice #{session.invoiceNumber} was already scanned
                  {duplicateSessions[0].supplierName ? ` from ${duplicateSessions[0].supplierName}` : ''}{' '}
                  ({duplicateSessions[0].status.toLowerCase()}). Review carefully.
                </span>
                <button
                  type="button"
                  onClick={() => setBannerDismissed(true)}
                  className="font-mono text-[10.5px] font-semibold px-2.5 py-1 rounded-full bg-red/10 text-red-text hover:bg-red/20 transition-colors shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}
            {reconciliation?.status === 'mismatch' && !bannerDismissed && (
              <AlertBanner
                onIgnore={() => setBannerDismissed(true)}
                onShowFix={reconciliation.suggestedFixItemId ? () => setActiveBboxItemId(reconciliation.suggestedFixItemId) : undefined}
              >
                <b className="font-semibold">{formatCurrency(Math.abs(reconciliation.delta))} mismatch</b>
                {' '}— sum of lines doesn&rsquo;t tie to the invoice subtotal.
                {reconciliation.suggestedFixItemId && ' One line looks off.'}
              </AlertBanner>
            )}

            {/* Mobile tab bar — only shown on small screens when files exist */}
            {session.files.length > 0 && (
              <div className="md:hidden flex border-b border-line shrink-0">
                <button
                  onClick={() => setMobileTab('review')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'review'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Review items
                </button>
                <button
                  onClick={() => setMobileTab('image')}
                  className={`flex-1 py-2.5 text-[13px] font-medium transition-colors ${
                    mobileTab === 'image'
                      ? 'text-ink border-b-2 border-ink'
                      : 'text-ink-4'
                  }`}
                >
                  Invoice image
                </button>
              </div>
            )}

            {/* Body: image viewer (left) + review panel (right) on desktop;
                    tabs control which panel is visible on mobile */}
            <div className="flex flex-1 min-h-0 overflow-hidden">

              {/* ── Image viewer ───────────────────────────────────────────── */}
              {session.files.length > 0 && (
                <>
                  <div className={mobileTab === 'review' ? 'hidden md:contents' : 'contents'}>
                    <ImageViewerV2
                      files={session.files}
                      activeBbox={activeBbox}
                    />
                  </div>
                  <div className="hidden md:block w-px bg-line shrink-0" />
                </>
              )}

              {/* ── Review panel ───────────────────────────────────────────── */}
              <div className={`flex flex-col flex-1 min-w-0 min-h-0 md:flex-none md:w-[680px] overflow-hidden ${
                session.files.length > 0 && mobileTab === 'image' ? 'hidden md:flex' : 'flex'
              }`}>
                {/* Review progress + segmented filter */}
                <ReviewProgress
                  resolved={progress.resolved}
                  total={progress.total}
                  segment={reviewSegment}
                  onSegment={setReviewSegment}
                  counts={segmentCounts}
                />

                {/* Line item list — grouped by section */}
                <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-[18px] py-3 flex flex-col gap-1.5">
                  {/* Needs your attention */}
                  {(reviewSegment === 'all' || reviewSegment === 'issues') && (sections.attention.length > 0 || supplierNeedsLink) && (
                    <>
                      <SectionDivider
                        tone="red"
                        label="Needs your attention"
                        count={`${sections.attention.length + (supplierNeedsLink ? 1 : 0)} item${sections.attention.length + (supplierNeedsLink ? 1 : 0) !== 1 ? 's' : ''}`}
                      />
                      {supplierNeedsLink && (
                        <SupplierLinkCard
                          supplierName={session.supplierName}
                          comboOpen={supplierComboOpen}
                          suppliers={allSuppliers}
                          search={supplierSearch}
                          onSearch={setSupplierSearch}
                          onOpenCombo={() => { loadSuppliers(); setSupplierComboOpen(v => !v) }}
                          onPick={handleLinkSupplier}
                          onSkip={() => { setSupplierSkipped(true); setSupplierComboOpen(false) }}
                        />
                      )}
                      {sections.attention.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Auto-matched */}
                  {(reviewSegment === 'all' || reviewSegment === 'matched') && sections.matched.length > 0 && (
                    <>
                      <SectionDivider tone="green" label="Auto-matched" count={`${sections.matched.length} line${sections.matched.length !== 1 ? 's' : ''}`} />
                      {sections.matched.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {/* Other line items (skipped / non-inventory) */}
                  {reviewSegment === 'all' && sections.charges.length > 0 && (
                    <>
                      <SectionDivider tone="neutral" label="Other line items" count={`${sections.charges.length} not inventory`} />
                      {sections.charges.map(i => (
                        <LineItemCard key={i.id} lineId={i.id} displayNo={sections.displayNo.get(i.id) ?? 0} />
                      ))}
                    </>
                  )}

                  {sections.attention.length === 0 && sections.matched.length === 0 && sections.charges.length === 0 && (
                    <div className="flex items-center justify-center h-32 text-[13px] text-ink-4">No line items.</div>
                  )}
                </div>

                {/* Footer */}
                {!approving ? (
                  <DrawerFooter
                    priceWrites={priceWrites}
                    newItems={newItemsCount}
                    supplierLink={initialAttention.supplier && !!linkedSupplierId}
                    canApprove={canApprove}
                    disabledReason={disabledReason}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    saveStatus={saveStatus}
                  />
                ) : (
                  <div
                    className="border-t border-line px-[18px] py-[13px] flex items-center justify-center gap-3 shrink-0"
                    style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
                  >
                    <Loader2 size={16} className="animate-spin text-ink-3" />
                    <span className="text-[13px] text-ink-3">Approving…</span>
                  </div>
                )}
              </div>
            </div>
          </DrawerContext.Provider>
        )}
      </div>

      {/* Inventory item edit — overlays the invoice drawer */}
      {editingInventoryItemId && (
        <InventoryItemDrawer
          itemId={editingInventoryItemId}
          onClose={() => setEditingInventoryItemId(null)}
          onUpdated={() => { if (session) refreshSession(session.id) }}
        />
      )}

      {/* Create new item mini-modal */}
      {creatingNewForItem && (
        <AddNewItemModal
          item={creatingNewForItem}
          sessionId={session?.id ?? ''}
          onSaved={() => {
            if (creatingNewForItem) {
              updateLine(creatingNewForItem.id, {
                action: 'CREATE_NEW',
                isNewItem: true,
                matchedItemId: null,
                matchedItem: null,
              })
            }
            setCreatingNewForItem(null)
            if (session) refreshSession(session.id)
          }}
          onClose={() => setCreatingNewForItem(null)}
        />
      )}
    </>
  )
}

// ─── ApprovedView ──────────────────────────────────────────────────────────────
// Full read-only view for APPROVED / REJECTED sessions.

function ApprovedView({
  session,
  onClose,
  onReviewAgain,
}: {
  session: Session
  onClose: () => void
  onReviewAgain: () => void
}) {
  const [priceAlertsOpen,  setPriceAlertsOpen]  = useState(true)
  const [recipeAlertsOpen, setRecipeAlertsOpen] = useState(true)
  const [reverting,        setReverting]        = useState(false)

  const rejected  = session.status === 'REJECTED'
  const total     = session.total    ? Number(session.total)    : null
  const subtotal  = session.subtotal ? Number(session.subtotal) : null
  const tax       = session.tax      ? Number(session.tax)      : null

  const activeItems   = session.scanItems.filter(i => i.action !== 'SKIP')
  const updatedItems  = session.scanItems.filter(i => i.action === 'UPDATE_PRICE' && i.approved)
  const newItems      = session.scanItems.filter(i => i.isNewItem && i.approved)
  const skippedItems  = session.scanItems.filter(i => i.action === 'SKIP')

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  metaParts.push(`${activeItems.length} line${activeItems.length !== 1 ? 's' : ''}`)

  const handleReviewAgain = async () => {
    setReverting(true)
    try {
      await fetch(`/api/invoices/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'REVIEW' }),
      })
      onReviewAgain()
    } finally {
      setReverting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div
        className={`px-[22px] pt-[18px] pb-[16px] border-b border-line ${rejected ? 'bg-paper' : 'bg-gradient-to-r from-green-soft/60 to-white'}`}
        style={{ paddingTop: 'calc(18px + env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5 mb-[5px]">
              <div className={`flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[11px] font-semibold ${
                rejected
                  ? 'bg-red-soft text-red-text'
                  : 'bg-green-soft text-green-text'
              }`}>
                {rejected ? <X size={10} /> : <Check size={10} />}
                {rejected ? 'Rejected' : 'Applied'}
              </div>
            </div>
            <h2 className="text-[19px] font-semibold text-ink leading-[1.2] truncate">
              {session.supplierName ?? 'Unknown supplier'}
            </h2>
            <p className="text-[12.5px] text-ink-4 mt-[3px]">{metaParts.join(' · ')}</p>
          </div>

          <div className="text-right shrink-0">
            <div className="text-[24px] font-semibold text-ink leading-none tabular-nums">
              {total !== null ? formatCurrency(total) : '—'}
            </div>
            {(subtotal !== null || tax !== null) && (
              <div className="text-[11.5px] text-ink-4 mt-[4px] tabular-nums">
                {subtotal !== null && `sub ${formatCurrency(subtotal)}`}
                {subtotal !== null && tax !== null && ' · '}
                {tax !== null && `tax ${formatCurrency(tax)}`}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2.5 flex items-center justify-center rounded-lg text-ink-4 hover:text-ink-2 hover:bg-bg-2 transition-colors"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Summary stat cards */}
        {!rejected && (
          <div className="px-[18px] pt-[16px] pb-[4px] grid grid-cols-4 gap-3">
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{updatedItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">prices updated</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{newItems.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">new items</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.priceAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">price alerts</div>
            </div>
            <div className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
              <div className="text-[22px] font-semibold text-ink tabular-nums leading-none">{session.recipeAlerts.length}</div>
              <div className="text-[11px] text-ink-4 mt-1">recipe impacts</div>
            </div>
          </div>
        )}

        {/* ── Line items ── */}
        <div className="px-[18px] pt-[16px]">
          <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider mb-2">Line items</p>
          <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
            {session.scanItems.map(item => {
              const prevPrice = item.previousPrice ? Number(item.previousPrice) : null
              const newPrice  = item.newPrice      ? Number(item.newPrice)      : null
              const diffPct   = item.priceDiffPct  ? Number(item.priceDiffPct)  : null
              const lineTotal = item.rawLineTotal  ? Number(item.rawLineTotal)  : null
              const isSkip    = item.action === 'SKIP'
              const isNew     = item.isNewItem && item.approved
              const isUpdate  = item.action === 'UPDATE_PRICE' && item.approved

              return (
                <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${isSkip ? 'opacity-40' : ''}`}>
                  {/* Icon */}
                  <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                    isNew    ? 'bg-green-soft'  :
                    isUpdate ? 'bg-blue-soft'      :
                    isSkip   ? 'bg-bg-2'    : 'bg-bg'
                  }`}>
                    {isNew    ? <Package  size={13} className="text-green-text" /> :
                     isSkip   ? <X        size={13} className="text-ink-4"   /> :
                                <Tag      size={13} className="text-blue"    />}
                  </div>

                  {/* Name + badge */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-medium text-ink-2 truncate">
                        {item.matchedItem?.itemName ?? item.rawDescription}
                      </span>
                      {isNew && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-green-soft text-green-text">NEW</span>
                      )}
                      {isSkip && (
                        <span className="text-[10px] font-semibold px-1.5 py-[1px] rounded bg-bg-2 text-ink-4">SKIPPED</span>
                      )}
                    </div>
                    {item.rawDescription !== item.matchedItem?.itemName && item.matchedItem && (
                      <div className="text-[11px] text-ink-4 truncate mt-0.5">{item.rawDescription}</div>
                    )}
                  </div>

                  {/* Price change */}
                  {!isSkip && !isNew && prevPrice !== null && newPrice !== null ? (
                    <div className="shrink-0 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevPrice)}</span>
                        <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newPrice)}</span>
                        {diffPct !== null && (
                          <span className={`text-[11px] font-semibold ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
                            {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                          </span>
                        )}
                      </div>
                      {lineTotal !== null && (
                        <div className="text-[11px] text-ink-4 mt-0.5 tabular-nums">{formatCurrency(lineTotal)}</div>
                      )}
                    </div>
                  ) : lineTotal !== null ? (
                    <div className="shrink-0 text-[12px] text-ink-3 tabular-nums">{formatCurrency(lineTotal)}</div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Price alerts ── */}
        {session.priceAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setPriceAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Price alerts ({session.priceAlerts.length})
              </p>
              {priceAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {priceAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.priceAlerts.map(alert => {
                  const prev    = Number(alert.previousPrice)
                  const next    = Number(alert.newPrice)
                  const pct     = Number(alert.changePct)
                  const up      = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-red-soft' : 'bg-green-soft'}`}>
                        {up
                          ? <TrendingUp   size={13} className="text-red"     />
                          : <TrendingDown size={13} className="text-green-text" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.inventoryItem.itemName}</span>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prev)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(next)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-red' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Recipe impacts ── */}
        {session.recipeAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <button
              type="button"
              onClick={() => setRecipeAlertsOpen(v => !v)}
              className="w-full flex items-center justify-between mb-2 group"
            >
              <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                Recipe impacts ({session.recipeAlerts.length})
              </p>
              {recipeAlertsOpen
                ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
                : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
            </button>
            {recipeAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.recipeAlerts.map(alert => {
                  const prevCost  = Number(alert.previousCost)
                  const newCost   = Number(alert.newCost)
                  const pct       = Number(alert.changePct)
                  const foodCost  = alert.newFoodCostPct ? Number(alert.newFoodCostPct) : null
                  const up        = pct > 0
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-orange-50' : 'bg-green-soft'}`}>
                        <BookOpen size={13} className={up ? 'text-orange-500' : 'text-green-text'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-ink-2">{alert.recipe.name}</span>
                        {foodCost !== null && (
                          <div className="text-[11px] text-ink-4 mt-0.5">food cost {foodCost.toFixed(1)}%</div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <span className="text-[12px] text-ink-4 line-through tabular-nums">{formatCurrency(prevCost)}</span>
                          <span className="text-[12px] font-medium text-ink-2 tabular-nums">{formatCurrency(newCost)}</span>
                          <span className={`text-[11px] font-semibold ${up ? 'text-orange-500' : 'text-green-text'}`}>
                            {up ? '+' : ''}{pct.toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <div className="h-6" />
      </div>

      {/* ── Footer ── */}
      <div
        className="border-t border-line px-[18px] py-[13px] flex items-center justify-between gap-3 bg-paper"
        style={{ paddingBottom: 'calc(13px + env(safe-area-inset-bottom, 0px))' }}
      >
        {!rejected ? (
          <button
            type="button"
            onClick={handleReviewAgain}
            disabled={reverting}
            className="flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 transition-colors disabled:opacity-50"
          >
            {reverting
              ? <Loader2 size={14} className="animate-spin" />
              : <RotateCcw size={14} />}
            Review again
          </button>
        ) : <div />}
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2 text-[13px] bg-ink text-paper rounded-lg hover:bg-ink-2 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  )
}

// ─── AddNewItemModal ───────────────────────────────────────────────────────────
// Full form to configure a new inventory item before approve creates it.

function AddNewItemModal({
  item,
  sessionId,
  onSaved,
  onClose,
}: {
  item: ScanItem
  sessionId: string
  onSaved: () => void
  onClose: () => void
}) {
  const [saving,          setSaving]          = useState(false)
  const [categories,      setCategories]      = useState<string[]>([])
  const [itemName,        setItemName]        = useState(item.rawDescription ?? '')
  const [category,        setCategory]        = useState('DRY')
  const [purchaseUnit,    setPurchaseUnit]    = useState(item.rawUnit ?? 'case')
  const [qtyPerPurchase,  setQtyPerPurchase]  = useState(item.invoicePackQty ?? '1')
  const [packSize,        setPackSize]        = useState(item.invoicePackSize ?? '1')
  const [packUOM,         setPackUOM]         = useState(item.invoicePackUOM ?? 'each')
  const [priceType,       setPriceType]       = useState<'CASE' | 'UOM'>(item.pricingMode === 'per_weight' ? 'UOM' : 'CASE')
  const [purchasePrice,   setPurchasePrice]   = useState(item.rate ?? item.rawUnitPrice ?? item.newPrice ?? '')

  useEffect(() => {
    fetch('/api/categories').then(r => r.json()).then((data: { name: string }[]) => {
      setCategories(data.map(c => c.name))
    }).catch(() => {})
  }, [])

  const ppb = (() => {
    const price = Number(purchasePrice)
    const qty   = Number(qtyPerPurchase) || 1
    const ps    = Number(packSize) || 1
    if (!price) return null
    return calcPricePerBaseUnit(price, qty, 'each', null, ps, packUOM, priceType)
  })()

  const handleSave = async () => {
    setSaving(true)
    await fetch(`/api/invoices/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanItemId:    item.id,
        action:        'CREATE_NEW',
        isNewItem:     true,
        matchedItemId: null,
        newItemData: {
          itemName:           itemName.trim() || item.rawDescription,
          category,
          purchaseUnit,
          qtyPerPurchaseUnit: Number(qtyPerPurchase) || 1,
          packSize:           Number(packSize) || 1,
          packUOM,
          priceType,
          purchasePrice:      Number(purchasePrice) || 0,
          pricePerBaseUnit:   ppb ?? 0,
          baseUnit:           packUOM,
        },
      }),
    })
    setSaving(false)
    onSaved()
  }

  const inputCls = 'w-full border border-line rounded-lg px-3 py-[7px] text-[13px] focus:outline-none focus:ring-2 focus:ring-blue/20 focus:border-blue transition-colors'
  const labelCls = 'block text-[11px] font-medium text-ink-3 mb-[5px] uppercase tracking-wide'

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={onClose} />
      <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
        <div className="bg-paper rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]">
          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-bg-2">
            <div>
              <h3 className="text-[16px] font-semibold text-ink">Create new product</h3>
              <p className="text-[12px] text-ink-4 mt-0.5">These fields will be set when the invoice is approved.</p>
            </div>
            <button type="button" onClick={onClose} className="p-2.5 flex items-center justify-center text-ink-4 hover:text-ink-3 transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Form */}
          <div className="overflow-y-auto px-6 py-5 space-y-4">
            {/* Item name */}
            <div>
              <label className={labelCls}>Item name</label>
              <input
                type="text"
                value={itemName}
                onChange={e => setItemName(e.target.value)}
                className={inputCls}
                placeholder={item.rawDescription ?? ''}
              />
            </div>

            {/* Category */}
            <div>
              <label className={labelCls}>Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className={inputCls}>
                {(categories.length ? categories : ['DRY', 'DAIRY', 'MEAT', 'PRODUCE', 'FROZEN', 'BEVERAGE', 'OTHER']).map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Purchase unit */}
            <div>
              <label className={labelCls}>Purchase unit</label>
              <select value={purchaseUnit} onChange={e => setPurchaseUnit(e.target.value)} className={inputCls}>
                {(PURCHASE_UNITS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>

            {/* Pack structure */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Pack qty</label>
                <input type="number" min="1" step="1" value={qtyPerPurchase} onChange={e => setQtyPerPurchase(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack size</label>
                <input type="number" min="0" step="any" value={packSize} onChange={e => setPackSize(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Pack UOM</label>
                <select value={packUOM} onChange={e => setPackUOM(e.target.value)} className={inputCls}>
                  {(PACK_UOMS as readonly string[]).map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>

            {/* Price type */}
            <div>
              <label className={labelCls}>Pricing mode</label>
              <div className="flex rounded-lg border border-line overflow-hidden text-[12px]">
                {(['CASE', 'UOM'] as const).map(pt => (
                  <button
                    key={pt}
                    type="button"
                    onClick={() => setPriceType(pt)}
                    className={`flex-1 py-[7px] font-medium transition-colors ${
                      priceType === pt ? 'bg-ink text-paper' : 'bg-paper text-ink-3 hover:bg-bg'
                    }`}
                  >
                    {pt === 'CASE' ? 'Per case' : 'Per weight / UOM'}
                  </button>
                ))}
              </div>
            </div>

            {/* Purchase price */}
            <div>
              <label className={labelCls}>Purchase price</label>
              <div className="flex items-center border border-line rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-blue/20 focus-within:border-blue transition-colors">
                <span className="px-3 text-ink-4 text-[13px]">$</span>
                <input
                  type="number" min="0" step="any"
                  value={purchasePrice}
                  onChange={e => setPurchasePrice(e.target.value)}
                  className="flex-1 py-[7px] pr-3 text-[13px] bg-transparent border-none outline-none"
                />
              </div>
              {ppb !== null && (
                <p className="text-[11px] text-ink-4 mt-1">
                  = {formatCurrency(ppb)}/{packUOM} per base unit
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-bg-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] text-ink-3 border border-line rounded-lg hover:bg-bg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[13px] font-medium bg-ink text-paper rounded-lg hover:bg-ink-2 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save & flag for approval'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── SupplierLinkCard ────────────────────────────────────────────────────────
// Invoice-wide attention card (mock §2): the supplier isn't in the directory.
// Three explicit decisions — link to existing, create new, or skip.

function SupplierLinkCard({
  supplierName,
  comboOpen,
  suppliers,
  search,
  onSearch,
  onOpenCombo,
  onPick,
  onSkip,
}: {
  supplierName: string | null
  comboOpen: boolean
  suppliers: Array<{ id: string; name: string }>
  search: string
  onSearch: (v: string) => void
  onOpenCombo: () => void
  onPick: (id: string) => void
  onSkip: () => void
}) {
  const filtered = suppliers.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
  return (
    <article className="bg-gold-soft/40 border border-[#fcd34d] rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5">
          <IssueBadge kind="supplier">Supplier</IssueBadge>
          <div className="text-[12.5px] text-ink-2 leading-[1.45] min-w-0">
            {supplierName
              ? <><b className="font-semibold text-ink">&ldquo;{supplierName}&rdquo;</b> isn&rsquo;t linked to a supplier in your directory.</>
              : 'No supplier was detected on this invoice.'}
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <ActButton variant="primary" onClick={onOpenCombo}>
            <Search size={12} /> Link to existing
          </ActButton>
          <ActButton variant="danger" onClick={onSkip}>Skip for this invoice</ActButton>
        </div>

        {comboOpen && (
          <div className="bg-paper border border-line rounded-lg overflow-hidden">
            <input
              autoFocus
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search suppliers…"
              className="w-full px-3 py-2 text-[13px] border-b border-bg-2 focus:outline-none"
            />
            <div className="max-h-44 overflow-y-auto">
              {filtered.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className="w-full text-left px-3 py-2 text-[13px] hover:bg-gold-soft transition-colors font-medium text-ink"
                >
                  {s.name}
                </button>
              ))}
              {filtered.length === 0 && <p className="px-3 py-3 text-[12px] text-ink-4">No suppliers found</p>}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

```


---

## `src/components/invoices/v2/InvoiceDrawerV2.tsx`

```tsx
'use client'
// V2 invoice review drawer — mode-aware UI for the redesigned OCR pipeline.
// Mounted alongside v1; users toggle via the `?v=2` URL flag on /invoices.
// When ready we swap the dynamic import in page.tsx and delete v1.
//
// What's different vs v1:
//   - Per-line "math expression" card adapts to per_case vs per_weight
//   - Catchweight shown inline ("3.20 lb (ord 3.00) × $19.89/lb = $63.65")
//   - Filter chips driven by mode-aware predicates (mismatch, catchweight, unknown mode)
//   - Header breakdown: sub · fuel · tax with reconcile indicator
//   - Variance pill computed in the linked product's baseUnit, not packUOM

import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  X, ScanLine, CheckCircle2, AlertTriangle, Loader2,
  Package, Scale, Link2, Unlink, TrendingUp, TrendingDown,
  ChevronDown, ChevronUp, Hash, CalendarDays, AlertCircle, Plus,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { InvoiceImageViewer } from '../InvoiceDrawer'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import type { Session, ScanItem, ApproveResult, SessionSummary, PricingMode } from '../types'
import {
  TONE, effectiveMode, productDefaultMode, varianceOf,
  mathTokens, packDescription, headerReconciliation, taxAggregate, feesAggregate,
  isPriceDelta, isCatchweight as isCw, isNeedsLink, isModeMismatch,
  isLowConfidence, isUnknownMode, isCrossCheckFail,
  applyFilter, sortByExceptionsFirst,
  type V2Filter,
} from './selectors'

interface Props {
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
  allSessions?: SessionSummary[]
}

interface InventorySearchResult {
  id: string; itemName: string; abbreviation: string | null;
  purchaseUnit: string; purchasePrice: number; pricePerBaseUnit: number;
  baseUnit: string; category: string; qtyPerPurchaseUnit: number;
  packSize: number; packUOM: string;
}

function descriptionToKeywords(desc: string): string {
  return desc
    .replace(/\d+\s*[\/x]\s*\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(/\s+/).slice(0, 5).join(' ')
}

// ── Root drawer ───────────────────────────────────────────────────────────────
export function InvoiceDrawerV2({ sessionId, onClose, onApproveOrReject, allSessions = [] }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [isApproving, setIsApproving] = useState(false)
  const [open, setOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<'review' | 'image'>('review')
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem('approvedBy') ?? '' : ''
  )
  const [filter, setFilter] = useState<V2Filter>('all')
  const [sortMode, setSortMode] = useState<'invoice' | 'exceptions'>('invoice')
  const [expandedIds, setExpandedIds] = useState<Record<string, true>>({})
  const { revenueCenters } = useRc()
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSession = useCallback(async (id: string) => {
    const res = await fetch(`/api/invoices/sessions/${id}`)
    if (!res.ok) return null
    const data: Session = await res.json()
    setSession(data)
    return data
  }, [])

  useEffect(() => {
    if (sessionId) {
      setOpen(true)
      setApproveResult(null)
      fetchSession(sessionId)
    } else {
      setOpen(false)
      const t = setTimeout(() => setSession(null), 200)
      return () => clearTimeout(t)
    }
  }, [sessionId, fetchSession])

  // Poll while processing/approving
  useEffect(() => {
    const should = session?.status === 'PROCESSING' || session?.status === 'UPLOADING' || session?.status === 'APPROVING'
    if (should) {
      pollRef.current = setInterval(async () => {
        const s = await fetchSession(session!.id)
        if (!s || (s.status !== 'PROCESSING' && s.status !== 'UPLOADING' && s.status !== 'APPROVING')) {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else if (pollRef.current) {
      clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, fetchSession])

  // Esc closes drawer. No unsaved-edits prompt yet — all edits PATCH on blur,
  // so by the time the user hits Esc the server state is already in sync.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const patchItem = useCallback(async (itemId: string, updates: Partial<ScanItem>) => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await fetchSession(session.id)
  }, [session, fetchSession])

  const handleApprove = async () => {
    if (!session) return
    setIsApproving(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) { alert(`Approval failed: ${result.error ?? res.statusText}`); return }
      if (result.queued) { onApproveOrReject(); onClose() }
      else { setApproveResult(result); onApproveOrReject() }
    } finally { setIsApproving(false) }
  }

  const handleReject = async () => {
    if (!session) return
    await fetch(`/api/invoices/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REJECTED' }),
    })
    onApproveOrReject()
    onClose()
  }

  const isReview = session?.status === 'REVIEW'

  if (!sessionId && !open && !session) return null

  return (
    <>
      {/* Backdrop — desktop only; mobile uses full-screen overlay */}
      <div
        className="hidden sm:block fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        style={{ opacity: open ? 1 : 0, transition: 'opacity 150ms ease-out' }}
      />

      {/* Desktop drawer */}
      <div
        className={`hidden sm:flex fixed top-0 right-0 h-full z-50 bg-paper shadow-2xl flex-col transition-all duration-150 ease-out ${isReview ? 'w-[960px]' : 'w-[560px]'}`}
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)' }}
      >
        <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} />
        <div className="flex-1 overflow-hidden flex min-h-0">
          {isReview && session?.files && session.files.length > 0 && (
            <InvoiceImageViewer files={session.files} />
          )}
          <div className={`flex-1 overflow-y-auto flex flex-col ${isReview ? 'border-l border-gray-100' : ''}`}>
            <DrawerBody
              session={session}
              approveResult={approveResult}
              allSessions={allSessions}
              filter={filter} onFilter={setFilter}
              sortMode={sortMode} onSortMode={setSortMode}
              expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
              patchItem={patchItem}
              revenueCenters={revenueCenters}
            />
            {isReview && session && (
              <DrawerFooter
                session={session}
                approvedBy={approvedBy}
                onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
                onApprove={handleApprove}
                onReject={handleReject}
                isApproving={isApproving}
              />
            )}
          </div>
        </div>
      </div>

      {/* Mobile — full-screen overlay, slides up from bottom */}
      <div
        className="sm:hidden fixed inset-0 z-[60] bg-paper flex flex-col"
        style={{
          transform: open ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 200ms ease-out',
          paddingTop: 'env(safe-area-inset-top, 0px)',
        }}
      >
        <DrawerChrome onClose={onClose} title={session ? labelFor(session.status) : 'Loading…'} size="sm" />
        {isReview && session?.files && session.files.length > 0 && (
          <div className="flex border-b border-gray-100 shrink-0">
            <button onClick={() => setMobileTab('review')} className={`flex-1 py-2.5 text-sm font-medium ${mobileTab === 'review' ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Review</button>
            <button onClick={() => setMobileTab('image')}  className={`flex-1 py-2.5 text-sm font-medium ${mobileTab === 'image'  ? 'text-gold border-b-2 border-gold' : 'text-gray-500'}`}>Invoice Image</button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
          {isReview && mobileTab === 'image' && session?.files?.length
            ? <InvoiceImageViewer files={session.files} />
            : <DrawerBody
                session={session}
                approveResult={approveResult}
                allSessions={allSessions}
                filter={filter} onFilter={setFilter}
                sortMode={sortMode} onSortMode={setSortMode}
                expandedIds={expandedIds} onToggle={(id) => setExpandedIds(p => ({ ...p, [id]: !p[id] ? true : undefined! }))}
                patchItem={patchItem}
                revenueCenters={revenueCenters}
              />}
        </div>
        {isReview && session && (
          <DrawerFooter
            session={session}
            approvedBy={approvedBy}
            onApprovedByChange={(v) => { setApprovedBy(v); localStorage.setItem('approvedBy', v) }}
            onApprove={handleApprove}
            onReject={handleReject}
            isApproving={isApproving}
          />
        )}
      </div>
    </>
  )
}

function labelFor(status: string): string {
  if (status === 'PROCESSING' || status === 'UPLOADING') return 'Scanning…'
  if (status === 'APPROVING') return 'Applying invoice…'
  if (status === 'ERROR')     return 'Scan failed'
  if (status === 'REVIEW')    return 'Review invoice'
  return 'Invoice'
}

// ── Drawer chrome ─────────────────────────────────────────────────────────────
function DrawerChrome({ onClose, title, size = 'md' }: { onClose: () => void; title: string; size?: 'sm' | 'md' }) {
  return (
    <div className={`flex items-center justify-between border-b border-gray-100 shrink-0 ${size === 'sm' ? 'px-5 py-3' : 'px-5 py-4'}`}>
      <div className="flex items-center gap-2">
        <ScanLine size={size === 'sm' ? 16 : 18} className="text-gold" />
        <span className={`font-semibold text-gray-900 ${size === 'sm' ? 'text-sm' : ''}`}>{title}</span>
      </div>
      <button onClick={onClose} aria-label="Close" className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
        <X size={size === 'sm' ? 16 : 18} />
      </button>
    </div>
  )
}

// ── Drawer body — header + chips + lines, or status views ─────────────────────
function DrawerBody({
  session, approveResult, allSessions, filter, onFilter, sortMode, onSortMode,
  expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session | null
  approveResult: ApproveResult | null
  allSessions: SessionSummary[]
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[40vh]">
        <Loader2 size={28} className="animate-spin text-gray-300" />
      </div>
    )
  }

  if (approveResult) {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-green-soft">
          <CheckCircle2 size={28} className="text-green-text" />
        </div>
        <h2 className="text-lg font-semibold text-gray-900">Invoice applied</h2>
        <p className="text-sm text-gray-500">
          {approveResult.itemsUpdated} prices updated · {approveResult.newItemsCreated} new items
        </p>
      </div>
    )
  }

  if (session.status !== 'REVIEW') {
    return (
      <div className="flex-1 p-6 text-center space-y-3">
        <Loader2 size={24} className="animate-spin text-gold mx-auto" />
        <p className="text-sm text-gray-500">{labelFor(session.status)}</p>
        {session.errorMessage && (
          <p className="text-sm text-red bg-red-soft border border-[#fecaca] rounded-xl px-4 py-3 text-left">
            {session.errorMessage}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <DrawerHeader session={session} allSessions={allSessions} />
      <FilterChipsBar
        session={session}
        filter={filter}
        onFilter={onFilter}
        sortMode={sortMode}
        onSortMode={onSortMode}
      />
      <LineItemList
        session={session}
        filter={filter}
        sortMode={sortMode}
        expandedIds={expandedIds}
        onToggle={onToggle}
        patchItem={patchItem}
        revenueCenters={revenueCenters}
      />
    </div>
  )
}

// ── Drawer header ─────────────────────────────────────────────────────────────
function DrawerHeader({ session, allSessions }: { session: Session; allSessions: SessionSummary[] }) {
  const recon = headerReconciliation(session)
  const tax  = taxAggregate(session)
  const fees = feesAggregate(session)
  const sub  = session.subtotal ? Number(session.subtotal) : null
  const ocrTotal = session.total ? Number(session.total) : null

  // When OCR didn't capture the invoice total, sum visible line items as a fallback.
  const scannedTotal = useMemo(() => {
    if (ocrTotal != null) return null // OCR total present — no need for fallback
    let sum = 0
    for (const item of session.scanItems) {
      if (item.action === 'SKIP') continue
      const lt = item.rawLineTotal != null ? Number(item.rawLineTotal) : null
      if (lt != null) sum += lt
    }
    return sum
  }, [ocrTotal, session.scanItems])

  const displayTotal = ocrTotal ?? scannedTotal
  const isComputedTotal = ocrTotal == null && scannedTotal != null

  const dup = session.invoiceNumber
    ? allSessions.find(s => s.id !== session.id && s.invoiceNumber === session.invoiceNumber)
    : null

  return (
    <div className="bg-paper border-b border-gray-100">
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-0.5">Review invoice</p>
            <h2 className="text-[17px] font-medium text-gray-900 leading-tight truncate">
              {session.supplierName || 'Unknown supplier'}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 flex-wrap">
              {session.invoiceNumber && <span className="flex items-center gap-0.5"><Hash size={10} />{session.invoiceNumber}</span>}
              {session.invoiceDate && <span className="flex items-center gap-0.5"><CalendarDays size={10} />{session.invoiceDate}</span>}
              <span>· {session.scanItems.length} line items</span>
            </div>
          </div>
          <div className="text-right shrink-0">
            {displayTotal != null && (
              <div>
                <div className="text-[22px] font-medium text-gray-900 leading-none">{formatCurrency(displayTotal)}</div>
                {isComputedTotal && (
                  <div className="text-[10px] text-gray-400 mt-0.5">scanned total (no OCR total)</div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-500 justify-end flex-wrap">
              {sub != null  && <span>sub {formatCurrency(sub)}</span>}
              {fees > 0     && <span>· fuel {formatCurrency(fees)}</span>}
              {tax != null && tax > 0 && <span>· tax {formatCurrency(tax)}</span>}
            </div>
            {!isComputedTotal && recon.match === true && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-soft text-green-text border border-green-soft">
                <CheckCircle2 size={9} /> totals reconcile
              </div>
            )}
            {!isComputedTotal && recon.match === false && recon.diff != null && (
              <div role="status" className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gold-soft text-gold-2 border border-[#fcd34d]/60">
                <AlertTriangle size={9} /> totals off by {formatCurrency(Math.abs(recon.diff))}
              </div>
            )}
          </div>
        </div>
      </div>

      {dup && (
        <div className="flex items-start gap-2 px-5 py-2.5 bg-gold-soft border-t border-[#fcd34d]/60">
          <AlertTriangle size={13} className="text-gold mt-0.5 shrink-0" />
          <div className="text-xs text-gold-2">
            <span className="font-semibold">Possible duplicate.</span>{' '}
            Invoice #{session.invoiceNumber} was already scanned
            {dup.invoiceDate ? ` on ${dup.invoiceDate}` : ''}
            {' '}<span className="font-semibold">({dup.status.toLowerCase()})</span>. Review carefully before approving.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function FilterChipsBar({
  session, filter, onFilter, sortMode, onSortMode,
}: {
  session: Session
  filter: V2Filter
  onFilter: (f: V2Filter) => void
  sortMode: 'invoice' | 'exceptions'
  onSortMode: (m: 'invoice' | 'exceptions') => void
}) {
  const counts = useMemo(() => ({
    all:          session.scanItems.length,
    price_delta:  session.scanItems.filter(isPriceDelta).length,
    catchweight:  session.scanItems.filter(isCw).length,
    needs_link:   session.scanItems.filter(isNeedsLink).length,
    mismatch:     session.scanItems.filter(isModeMismatch).length,
    low_conf:     session.scanItems.filter(isLowConfidence).length,
    unknown_mode: session.scanItems.filter(isUnknownMode).length,
  }), [session.scanItems])

  const Chip = ({ value, label, tone }: { value: V2Filter; label: string; tone?: 'warning' | 'info' | 'danger' }) => {
    const n = counts[value]
    if (value !== 'all' && n === 0) return null
    const active = filter === value
    const dotClass = tone ? TONE[tone].dot : ''
    return (
      <button
        onClick={() => onFilter(value)}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
          active ? 'bg-gray-900 text-paper border-gray-900' : 'bg-paper text-gray-600 border-gray-200 hover:bg-gray-50'
        }`}
      >
        {tone && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />}
        {label}
        <span className={active ? 'text-gray-300' : 'text-gray-400'}>{n}</span>
      </button>
    )
  }

  return (
    <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap border-b border-gray-100 bg-gray-50/50">
      <Chip value="all"          label="All" />
      <Chip value="unknown_mode" label="Unknown mode" tone="danger" />
      <Chip value="needs_link"   label="Needs link"   tone="danger" />
      <Chip value="mismatch"     label="Mismatch"     tone="warning" />
      <Chip value="low_conf"     label="Low conf"     tone="warning" />
      <Chip value="price_delta"  label="Price Δ"      tone="warning" />
      <Chip value="catchweight"  label="Catchweight"  tone="info" />

      <div className="ml-auto flex items-center gap-2.5">
        <button
          onClick={() => onSortMode(sortMode === 'invoice' ? 'exceptions' : 'invoice')}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-700"
        >
          {sortMode === 'invoice' ? '⇣ Invoice order' : '⚠ Exceptions first'}
        </button>
      </div>
    </div>
  )
}

// ── Line item list ────────────────────────────────────────────────────────────
function LineItemList({
  session, filter, sortMode, expandedIds, onToggle, patchItem, revenueCenters,
}: {
  session: Session
  filter: V2Filter
  sortMode: 'invoice' | 'exceptions'
  expandedIds: Record<string, true>
  onToggle: (id: string) => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const filtered = applyFilter(session.scanItems, filter)
  const ordered = sortMode === 'exceptions' ? sortByExceptionsFirst(filtered) : [...filtered].sort((a, b) => a.sortOrder - b.sortOrder)

  if (ordered.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-gray-400">
        No items match this filter.
      </div>
    )
  }

  return (
    <div className="px-3 py-3 space-y-2 bg-gray-50/60">
      {ordered.map(item => (
        <LineItemRow
          key={item.id}
          item={item}
          isExpanded={!!expandedIds[item.id]}
          onToggle={() => onToggle(item.id)}
          patchItem={patchItem}
          revenueCenters={revenueCenters}
        />
      ))}
    </div>
  )
}

// ── Line item row ─────────────────────────────────────────────────────────────
function LineItemRow({
  item, isExpanded, onToggle, patchItem, revenueCenters,
}: {
  item: ScanItem
  isExpanded: boolean
  onToggle: () => void
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
  revenueCenters: Array<{ id: string; name: string; color: string }>
}) {
  const mode    = effectiveMode(item)
  const tokens  = mathTokens(item)
  const v       = varianceOf(item)
  const pdm     = productDefaultMode(item)
  const linked  = item.matchedItem
  const lineTotal = item.rawLineTotal != null ? Number(item.rawLineTotal) : null

  // Row border tone — danger > warning > neutral
  const borderClass =
    isUnknownMode(item)                      ? 'border-[#fca5a5]' :
    isNeedsLink(item)                        ? 'border-[#fca5a5]' :
    isCrossCheckFail(item)                   ? 'border-[#fca5a5]' :
    isModeMismatch(item)                     ? 'border-[#fcd34d]' :
    isLowConfidence(item)                    ? 'border-[#fcd34d]' :
                                               'border-gray-200'

  return (
    <div className={`bg-paper rounded-xl border ${borderClass} overflow-hidden`}>
      {/* Row header — keyboard-expandable */}
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full text-left px-3 pt-3 pb-2 flex items-start gap-3 hover:bg-gray-50/60 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium text-gray-900 truncate">{item.rawDescription}</span>
            {isModeMismatch(item)   && <Pill tone="warning">mode mismatch</Pill>}
            {isCw(item)             && <Pill tone="info">catchweight</Pill>}
            {isLowConfidence(item)  && <Pill tone="warning">low conf</Pill>}
            {isUnknownMode(item)    && <Pill tone="danger">unknown mode</Pill>}
          </div>
          <div className="mt-0.5 text-[11px] text-gray-500 truncate">
            {[
              item.supplierItemCode ? `#${item.supplierItemCode}` : null,
              packDescription(item) || (mode === 'per_case' ? '⚠ no pack format' : null),
              item.lineCategory || null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[15px] font-medium text-gray-900">
            {lineTotal != null ? formatCurrency(lineTotal) : '—'}
          </div>
          {isExpanded ? <ChevronUp size={14} className="text-gray-400 inline-block mt-1" /> : <ChevronDown size={14} className="text-gray-400 inline-block mt-1" />}
        </div>
      </button>

      {/* Math expression card */}
      <div className="mx-3 mb-2 bg-gray-50 rounded-lg px-3 py-2 flex items-center gap-3">
        <div className="shrink-0 text-gray-400">
          {mode === 'per_weight' ? <Scale size={16} /> : <Package size={16} />}
        </div>
        <div className="flex-1 text-[13px] text-gray-900 leading-tight">
          <span className="font-medium">{tokens.lhs.value}</span>
          {tokens.lhs.uom && <span className="text-gray-500"> {tokens.lhs.uom}</span>}
          {tokens.lhs.ordHint && <span className="text-[11px] text-gray-400 ml-1">{tokens.lhs.ordHint}</span>}
          <span className="text-gray-400 mx-1.5">×</span>
          <span className="font-medium">{tokens.rhs.value}</span>
          {tokens.rhs.uom && <span className="text-gray-500">/{tokens.rhs.uom}</span>}
          <span className="text-gray-400 mx-1.5">=</span>
          <span className="font-medium">{tokens.result}</span>
        </div>
        <ModePill mode={mode} />
      </div>

      {/* Link strip */}
      <div className="px-3 pb-3 flex items-center gap-3 text-[12px]">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {linked ? (
            <>
              <Link2 size={12} className="text-gray-400" />
              <span className="text-gray-700">linked to <span className="font-medium text-gray-900">{linked.itemName}</span></span>
              {v != null && Math.abs(v) >= 0.01 && (
                <VariancePill v={v} />
              )}
            </>
          ) : (
            <>
              <Unlink size={12} className="text-red" />
              {item.action === 'CREATE_NEW' ? (
                <span className="text-gray-700">will create new inventory item</span>
              ) : item.action === 'SKIP' ? (
                <span className="text-gray-400">skipped</span>
              ) : (
                <span className="text-red-text font-medium">not linked yet</span>
              )}
            </>
          )}
        </div>
        <RcAssigner
          item={item}
          revenueCenters={revenueCenters}
          onAssign={(rcId) => patchItem(item.id, { revenueCenterId: rcId })}
        />
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <ItemEditSection
          item={item}
          mode={mode}
          variance={v}
          productDefaultMode={pdm}
          patchItem={patchItem}
        />
      )}
    </div>
  )
}

function Pill({ tone, children }: { tone: 'warning' | 'info' | 'danger' | 'success'; children: React.ReactNode }) {
  const t = TONE[tone]
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>{children}</span>
}

function ModePill({ mode }: { mode: PricingMode }) {
  if (mode === 'unknown') return <Pill tone="danger">unknown mode</Pill>
  if (mode === 'per_weight') return <Pill tone="info">by weight</Pill>
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200">by case</span>
}

function VariancePill({ v }: { v: number }) {
  const pct = (v * 100)
  const up = v > 0
  const tone = up ? 'danger' : 'success'
  const t = TONE[tone]
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.text} border ${t.border}`}>
      {up ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function RcAssigner({
  item, revenueCenters, onAssign,
}: {
  item: ScanItem
  revenueCenters: Array<{ id: string; name: string; color: string }>
  onAssign: (rcId: string) => void
}) {
  if (revenueCenters.length <= 1) return null
  const current = revenueCenters.find(rc => rc.id === item.revenueCenterId)
  return (
    <select
      value={item.revenueCenterId ?? ''}
      onChange={(e) => onAssign(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Assign revenue center"
      className={`text-[11px] rounded-lg px-2 py-0.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-gold ${
        current
          ? 'border border-gray-200 bg-paper text-gray-700'
          : 'border border-dashed border-gray-300 bg-paper text-gray-400'
      }`}
    >
      <option value="">RC: assign…</option>
      {revenueCenters.map(rc => (
        <option key={rc.id} value={rc.id}>RC: {rc.name}</option>
      ))}
    </select>
  )
}

// ── Unified item edit section — replaces ExpandedDetails + PerCaseForm + PerWeightForm ──
function ItemEditSection({
  item, mode, variance, productDefaultMode: pdm, patchItem,
}: {
  item: ScanItem
  mode: PricingMode
  variance: number | null
  productDefaultMode: PricingMode | null
  patchItem: (id: string, updates: Partial<ScanItem>) => Promise<void>
}) {
  // ── Local field state ────────────────────────────────────────────────────────
  const [localQty,       setLocalQty]       = useState(item.rawQty        != null ? String(Number(item.rawQty))        : '')
  const [localPackQty,   setLocalPackQty]   = useState(item.invoicePackQty != null ? String(Number(item.invoicePackQty)) : '')
  const [localPackSize,  setLocalPackSize]  = useState(item.invoicePackSize != null ? String(Number(item.invoicePackSize)) : '')
  const [localPackUOM,   setLocalPackUOM]   = useState(item.invoicePackUOM  ?? '')
  const [localUnitPrice, setLocalUnitPrice] = useState(item.rawUnitPrice   != null ? String(Number(item.rawUnitPrice))  : '')
  const [localLineTotal, setLocalLineTotal] = useState(item.rawLineTotal   != null ? String(Number(item.rawLineTotal))  : '')
  const [localQtyOrdered, setLocalQtyOrdered] = useState(item.qtyOrdered  != null ? String(Number(item.qtyOrdered))    : '')
  const [localRate,      setLocalRate]      = useState(item.rate           != null ? String(Number(item.rate))          : '')
  const [localTotalQty,  setLocalTotalQty]  = useState(item.totalQty      != null ? String(Number(item.totalQty))      : '')
  const [priceDriver,    setPriceDriver]    = useState<'unit' | 'total'>('unit')

  // ── Search state ─────────────────────────────────────────────────────────────
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState<InventorySearchResult[]>([])
  const [isSearching,   setIsSearching]   = useState(false)
  const [showDropdown,  setShowDropdown]  = useState(false)
  const searchRef  = useRef<HTMLDivElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recomputingRef = useRef(false)

  // ── Sync local state when item.id changes (different row selected) ───────────
  useEffect(() => {
    setLocalQty(item.rawQty        != null ? String(Number(item.rawQty))        : '')
    setLocalPackQty(item.invoicePackQty != null ? String(Number(item.invoicePackQty)) : '')
    setLocalPackSize(item.invoicePackSize != null ? String(Number(item.invoicePackSize)) : '')
    setLocalPackUOM(item.invoicePackUOM ?? '')
    setLocalUnitPrice(item.rawUnitPrice != null ? String(Number(item.rawUnitPrice)) : '')
    setLocalLineTotal(item.rawLineTotal != null ? String(Number(item.rawLineTotal)) : '')
    setLocalQtyOrdered(item.qtyOrdered != null ? String(Number(item.qtyOrdered)) : '')
    setLocalRate(item.rate != null ? String(Number(item.rate)) : '')
    setLocalTotalQty(item.totalQty != null ? String(Number(item.totalQty)) : '')
    setPriceDriver('unit')
  }, [item.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reactive cross-field calculation ─────────────────────────────────────────
  useEffect(() => {
    if (recomputingRef.current) return
    recomputingRef.current = true
    try {
      if (mode === 'per_case') {
        const qty  = parseFloat(localQty)
        const up   = parseFloat(localUnitPrice)
        const lt   = parseFloat(localLineTotal)
        if (priceDriver === 'unit' && qty > 0 && up > 0) {
          const next = (qty * up).toFixed(2)
          if (next !== localLineTotal) setLocalLineTotal(next)
        } else if (priceDriver === 'total' && qty > 0 && lt > 0) {
          const next = (lt / qty).toFixed(4)
          if (next !== localUnitPrice) setLocalUnitPrice(next)
        }
      } else if (mode === 'per_weight') {
        const tq = parseFloat(localTotalQty)
        const r  = parseFloat(localRate)
        const lt = parseFloat(localLineTotal)
        if (priceDriver === 'unit' && tq > 0 && r > 0) {
          const next = (tq * r).toFixed(2)
          if (next !== localLineTotal) setLocalLineTotal(next)
        } else if (priceDriver === 'total' && tq > 0 && lt > 0) {
          const next = (lt / tq).toFixed(4)
          if (next !== localRate) setLocalRate(next)
        }
      }
    } finally {
      recomputingRef.current = false
    }
  }, [localQty, localUnitPrice, localLineTotal, localTotalQty, localRate, priceDriver, mode])

  // ── Outside-click closes search dropdown ─────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ── Inventory search ──────────────────────────────────────────────────────────
  const search = useCallback((q: string) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!q.trim()) { setSearchResults([]); setShowDropdown(false); return }
    searchTimerRef.current = setTimeout(async () => {
      setIsSearching(true)
      try {
        const res = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
        if (res.ok) {
          const data: InventorySearchResult[] = await res.json()
          setSearchResults(data)
          setShowDropdown(true)
        }
      } finally {
        setIsSearching(false)
      }
    }, 250)
  }, [])

  const handleSearchChange = (q: string) => {
    setSearchQuery(q)
    search(q)
  }

  const handleSelectItem = async (inv: InventorySearchResult) => {
    setShowDropdown(false)
    setSearchQuery(inv.itemName)
    await patchItem(item.id, {
      matchedItemId: inv.id,
      action: 'UPDATE_PRICE',
      matchConfidence: 'HIGH',
      matchScore: 100,
    } as Partial<ScanItem>)
  }

  const handleSelectCreateNew = async () => {
    setShowDropdown(false)
    await patchItem(item.id, { matchedItemId: null, action: 'CREATE_NEW' } as Partial<ScanItem>)
  }

  const handleSelectSkip = async () => {
    setShowDropdown(false)
    await patchItem(item.id, { action: 'SKIP' } as Partial<ScanItem>)
  }

  // ── Save all fields at once ───────────────────────────────────────────────────
  const saveAll = useCallback(async () => {
    const toNull = (v: string) => v.trim() === '' ? null : v
    await patchItem(item.id, {
      rawQty:         toNull(localQty),
      invoicePackQty: toNull(localPackQty),
      invoicePackSize: toNull(localPackSize),
      invoicePackUOM:  toNull(localPackUOM),
      rawUnitPrice:   toNull(localUnitPrice),
      rawLineTotal:   toNull(localLineTotal),
      qtyOrdered:     toNull(localQtyOrdered),
      rate:           toNull(localRate),
      totalQty:       toNull(localTotalQty),
    } as Partial<ScanItem>)
  }, [item.id, localQty, localPackQty, localPackSize, localPackUOM, localUnitPrice, localLineTotal, localQtyOrdered, localRate, localTotalQty, patchItem])

  // ── Mode switch ───────────────────────────────────────────────────────────────
  const switchMode = async (next: 'per_case' | 'per_weight') => {
    if (mode === next) return
    if (next === 'per_case') {
      const qty = parseFloat(localQty)
      const lt  = parseFloat(localLineTotal)
      const fallbackUnitPrice = (qty > 0 && lt > 0) ? String(lt / qty) : null
      await patchItem(item.id, {
        pricingMode: 'per_case',
        rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
        ...(item.rawUnitPrice == null && fallbackUnitPrice != null ? { rawUnitPrice: fallbackUnitPrice } : {}),
      } as Partial<ScanItem>)
    } else {
      await patchItem(item.id, { pricingMode: 'per_weight', rawUnitPrice: null } as Partial<ScanItem>)
    }
  }

  const rateUOM = item.rateUOM ?? item.totalQtyUOM ?? 'kg'
  const hasPackFormat = localPackQty !== '' || localPackSize !== '' || localPackUOM !== ''
  const linked = item.matchedItem

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="border-t border-dashed border-gray-200 bg-gray-50/80 px-3 py-3 space-y-3">

      {/* ── Linked item search ─────────────────────────────────────────────── */}
      <div ref={searchRef} className="relative">
        <span className="block text-[10px] text-gray-500 mb-1 flex items-center gap-1">
          {linked ? <Link2 size={10} className="text-gray-400" /> : <Unlink size={10} className="text-red" />}
          {linked ? 'Linked item' : 'Link to inventory item'}
        </span>
        <div className="relative flex items-center">
          <input
            type="text"
            value={showDropdown || searchQuery ? searchQuery : (linked?.itemName ?? '')}
            placeholder={`Search inventory… (${descriptionToKeywords(item.rawDescription) || item.rawDescription})`}
            onChange={(e) => handleSearchChange(e.target.value)}
            onFocus={() => {
              const initial = linked?.itemName ?? descriptionToKeywords(item.rawDescription)
              if (!searchQuery) {
                setSearchQuery(initial)
                search(initial)
              } else {
                if (searchResults.length > 0) setShowDropdown(true)
              }
            }}
            className="w-full border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold pr-7"
          />
          {isSearching && (
            <Loader2 size={13} className="absolute right-2 text-gray-400 animate-spin" />
          )}
        </div>

        {showDropdown && (
          <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-paper border border-gray-200 rounded-xl shadow-lg overflow-hidden">
            {searchResults.map((inv) => (
              <button
                key={inv.id}
                onMouseDown={(e) => { e.preventDefault(); handleSelectItem(inv) }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-start gap-2 border-b border-gray-50 last:border-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{inv.itemName}</div>
                  <div className="text-[11px] text-gray-500 truncate">
                    {inv.category} · {inv.packSize}{inv.packUOM} × {inv.qtyPerPurchaseUnit}/{inv.purchaseUnit}
                  </div>
                </div>
              </button>
            ))}
            <div className="flex border-t border-gray-100">
              <button
                onMouseDown={(e) => { e.preventDefault(); handleSelectCreateNew() }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] text-green-text hover:bg-green-soft font-medium"
              >
                <Plus size={12} /> Create new item
              </button>
              <div className="w-px bg-gray-100" />
              <button
                onMouseDown={(e) => { e.preventDefault(); handleSelectSkip() }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] text-gray-500 hover:bg-gray-50 font-medium"
              >
                — Skip this line
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Pricing details label + mode toggle ───────────────────────────── */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Pricing details</span>
        <ModeToggle current={mode} onChange={switchMode} />
      </div>

      {/* ── Mode-specific fields ───────────────────────────────────────────── */}
      {mode === 'per_case' ? (
        <div className="space-y-2.5">
          {/* Pack format */}
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Pack format</span>
              {!hasPackFormat && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gold-soft text-gold-2 border border-[#fcd34d]/60">
                  <AlertTriangle size={9} /> not detected
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack qty</span>
                <input type="number" step="any" min="0" value={localPackQty} placeholder="e.g. 4"
                  onChange={(e) => setLocalPackQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack size</span>
                <input type="number" step="any" min="0" value={localPackSize} placeholder="e.g. 4"
                  onChange={(e) => setLocalPackSize(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
              <label className="block">
                <span className="block text-[10px] text-gray-500 mb-0.5">Pack UOM</span>
                <input type="text" value={localPackUOM} placeholder="kg, lb, L…"
                  onChange={(e) => setLocalPackUOM(e.target.value)}
                  onBlur={saveAll}
                  className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
              </label>
            </div>
            {hasPackFormat && (
              <div className="mt-1 text-[11px] text-gray-500 px-1">
                = {localPackQty || '?'} × {localPackSize || '?'}{localPackUOM} per case
              </div>
            )}
          </div>
          {/* Qty + pricing */}
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty ordered</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQtyOrdered}
                  onChange={(e) => setLocalQtyOrdered(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.qtyOrderedUOM ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty shipped</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQty}
                  onChange={(e) => setLocalQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.rawUnit ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Unit price</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localUnitPrice}
                  onChange={(e) => { setLocalUnitPrice(e.target.value); setPriceDriver('unit') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">${'/'}{item.rawUnit ?? 'cs'}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Line total</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localLineTotal}
                  onChange={(e) => { setLocalLineTotal(e.target.value); setPriceDriver('total') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">$</span>
              </div>
            </label>
          </div>
        </div>
      ) : mode === 'per_weight' ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Qty ordered</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localQtyOrdered}
                  onChange={(e) => setLocalQtyOrdered(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.qtyOrderedUOM ?? rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Shipped (total qty)</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localTotalQty}
                  onChange={(e) => setLocalTotalQty(e.target.value)}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">{item.totalQtyUOM ?? rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Rate</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localRate}
                  onChange={(e) => { setLocalRate(e.target.value); setPriceDriver('unit') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">${'/'}{rateUOM}</span>
              </div>
            </label>
            <label className="block">
              <span className="block text-[10px] text-gray-500 mb-0.5">Line total</span>
              <div className="flex items-center gap-1">
                <input type="number" step="any" min="0" value={localLineTotal}
                  onChange={(e) => { setLocalLineTotal(e.target.value); setPriceDriver('total') }}
                  onBlur={saveAll}
                  className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold" />
                <span className="text-[11px] text-gray-500 shrink-0">$</span>
              </div>
            </label>
          </div>
          <div className="text-[11px] text-gray-500 px-1">
            Line total = total qty × rate ={' '}
            <span className="font-medium text-gray-700">
              {localLineTotal !== '' ? formatCurrency(parseFloat(localLineTotal))
                : (localRate !== '' && localTotalQty !== '')
                  ? formatCurrency(parseFloat(localRate) * parseFloat(localTotalQty))
                  : '—'}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-gold-2 bg-gold-soft border border-[#fcd34d]/60 rounded-lg px-3 py-2">
          Mode couldn&apos;t be detected. Pick{' '}
          <button onClick={() => switchMode('per_case')} className="underline font-medium">per case</button>
          {' '}or{' '}
          <button onClick={() => switchMode('per_weight')} className="underline font-medium">per weight</button>
          {' '}to continue.
        </div>
      )}

      {/* ── Inventory cost result ──────────────────────────────────────────── */}
      {linked && <CostResult item={item} variance={variance} />}

      {/* ── Mode-mismatch note ─────────────────────────────────────────────── */}
      {pdm && mode !== 'unknown' && pdm !== mode && linked && (
        <div className="text-[11px] text-gold-2 bg-gold-soft border border-[#fcd34d]/60 rounded-lg px-3 py-2 flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <div>
            Detected pricing is per {mode === 'per_weight' ? 'weight' : 'case'}, but{' '}
            <span className="font-medium">{linked.itemName}</span> is set up per{' '}
            {pdm === 'per_weight' ? 'weight' : 'case'}. The mode change above applies to this line only.
          </div>
        </div>
      )}
    </div>
  )
}

function ModeToggle({ current, onChange }: { current: PricingMode; onChange: (m: 'per_case' | 'per_weight') => void }) {
  const cls = (active: boolean) =>
    `px-2.5 py-1 text-[11px] font-medium transition-colors ${active ? 'bg-blue-soft text-blue-text' : 'bg-paper text-gray-500 hover:text-gray-700'}`
  return (
    <div className="inline-flex border border-gray-200 rounded-lg overflow-hidden">
      <button onClick={() => onChange('per_case')}   className={cls(current === 'per_case')}>case</button>
      <button onClick={() => onChange('per_weight')} className={cls(current === 'per_weight')}>weight</button>
    </div>
  )
}

// ── Inline field editor — debounced PATCH on blur ────────────────────────────
function NumField({
  label, value, onCommit, uom, placeholder, step = 'any',
}: {
  label: string
  value: string | number | null | undefined
  onCommit: (next: string) => void
  uom?: string | null
  placeholder?: string
  step?: string
}) {
  const [local, setLocal] = useState(value == null ? '' : String(Number(value)))
  useEffect(() => { setLocal(value == null ? '' : String(Number(value))) }, [value])
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min="0"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => { if (local !== (value == null ? '' : String(Number(value)))) onCommit(local) }}
          placeholder={placeholder}
          className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        {uom && <span className="text-[11px] text-gray-500 shrink-0">{uom}</span>}
      </div>
    </label>
  )
}

function TextField({
  label, value, onCommit, placeholder,
}: {
  label: string
  value: string | null | undefined
  onCommit: (next: string) => void
  placeholder?: string
}) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <label className="block">
      <span className="block text-[10px] text-gray-500 mb-0.5">{label}</span>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => { if (local !== (value ?? '')) onCommit(local) }}
        placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
      />
    </label>
  )
}

function CostResult({ item, variance }: { item: ScanItem; variance: number | null }) {
  const inv = item.matchedItem
  if (!inv) return null
  const prev = inv.pricePerBaseUnit != null ? Number(inv.pricePerBaseUnit) : null
  // Local recompute mirroring selectors.newCostPerBaseUnit, but expressed
  // for display so we don't have to thread it through props.
  const baseUnit = inv.baseUnit || 'each'
  return (
    <div className="border-t border-dashed border-gray-200 pt-2.5 flex items-center justify-between gap-3 flex-wrap text-[12px]">
      <div className="text-gray-500">
        inventory cost in <span className="font-mono">{baseUnit}</span>
        {prev != null && (
          <> · last applied <span className="font-medium text-gray-700">${prev.toFixed(4)}/{baseUnit}</span></>
        )}
      </div>
      {variance != null && (
        <VariancePill v={variance} />
      )}
    </div>
  )
}

// ── Drawer footer ─────────────────────────────────────────────────────────────
function DrawerFooter({
  session, approvedBy, onApprovedByChange, onApprove, onReject, isApproving,
}: {
  session: Session
  approvedBy: string
  onApprovedByChange: (v: string) => void
  onApprove: () => void
  onReject: () => void
  isApproving: boolean
}) {
  const blockers = useMemo(() => ({
    unknownMode: session.scanItems.filter(isUnknownMode).length,
    needsLink:   session.scanItems.filter(isNeedsLink).length,
    mismatch:    session.scanItems.filter(isModeMismatch).length,
    lowConf:     session.scanItems.filter(isLowConfidence).length,
  }), [session.scanItems])

  const totalItems = session.scanItems.length
  const canApprove = approvedBy.trim().length > 0 && blockers.unknownMode === 0 && blockers.needsLink === 0 && !isApproving
  const hasBlockerHint = blockers.needsLink > 0 || blockers.mismatch > 0 || blockers.lowConf > 0 || blockers.unknownMode > 0

  return (
    <div className="sticky bottom-0 bg-paper border-t border-gray-200 px-4 py-3 pb-safe flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      <div className="flex-1 text-[12px] text-gray-600 leading-tight">
        <div className="font-medium text-gray-800">{totalItems} items</div>
        {hasBlockerHint && (
          <div className="text-[11px] text-gray-500 mt-0.5">
            {[
              blockers.unknownMode > 0 ? `${blockers.unknownMode} unknown mode` : null,
              blockers.needsLink   > 0 ? `${blockers.needsLink} needs link`     : null,
              blockers.mismatch    > 0 ? `${blockers.mismatch} mismatch`        : null,
              blockers.lowConf     > 0 ? `${blockers.lowConf} low conf`         : null,
            ].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
      <input
        type="text"
        value={approvedBy}
        onChange={(e) => onApprovedByChange(e.target.value)}
        placeholder="Your name"
        aria-label="Approver name"
        className={`border rounded-lg px-3 py-1.5 text-sm w-full sm:w-36 focus:outline-none focus:ring-2 focus:ring-gold ${
          !approvedBy ? 'border-[#fcd34d] bg-gold-soft' : 'border-gray-200'
        }`}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onReject}
          disabled={isApproving}
          className="border border-red text-red rounded-lg px-4 py-2 text-sm font-medium hover:bg-red-soft disabled:opacity-50"
        >
          Reject
        </button>
        <button
          onClick={onApprove}
          disabled={!canApprove}
          title={!canApprove
            ? blockers.unknownMode > 0 ? 'Resolve unknown-mode rows first'
              : blockers.needsLink > 0 ? 'Link or create all rows first'
              : !approvedBy.trim() ? 'Enter your name'
              : ''
            : ''}
          className="bg-green-text text-paper rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2 hover:bg-green-text disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {isApproving ? 'Approving…' : 'Approve & apply'}
        </button>
      </div>
    </div>
  )
}

// Unused import suppressions — Plus is reserved for an upcoming manual-add hook
void Plus

```


---

## `src/components/invoices/v2/ImageViewer.tsx`

```tsx
'use client'
// Invoice image viewer with zoom / pan / rotate toolbar and SVG bbox highlight.

import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus } from 'lucide-react'

export interface BBox {
  page: number   // 0-indexed file index
  x: number      // left edge as fraction of image width  (0–1)
  y: number      // top edge  as fraction of image height (0–1)
  w: number      // width  as fraction of image width
  h: number      // height as fraction of image height
}

interface Props {
  files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string }>
  activeBbox?: BBox | null
}

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 6
const PADDING   = 16   // px of inset padding around the image

export function ImageViewerV2({ files, activeBbox }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [rotation,    setRotation]    = useState(0)
  const [pan,         setPan]         = useState({ x: 0, y: 0 })
  const [isDragging,  setIsDragging]  = useState(false)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [bboxKey,     setBboxKey]     = useState(0)
  // Pixel rect of the rendered image inside containerRef (for bbox SVG positioning)
  const [imgRect,     setImgRect]     = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStart    = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const file    = files[activeIdx]
  const isPdf   = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // ── Compute the pixel rect of the contained image ──────────────────────────
  // object-fit: contain centres the image and letterboxes — we need the exact
  // rendered rect so the bbox SVG overlay aligns with the visible pixels.
  const computeImgRect = useCallback((ns: { w: number; h: number }) => {
    const c = containerRef.current
    if (!c) return
    const availW = c.clientWidth  - PADDING * 2
    const availH = c.clientHeight - PADDING * 2
    if (availW <= 0 || availH <= 0) return
    const scale = Math.min(availW / ns.w, availH / ns.h)
    const rw = ns.w * scale
    const rh = ns.h * scale
    setImgRect({
      x: PADDING + (availW - rw) / 2,
      y: PADDING + (availH - rh) / 2,
      w: rw,
      h: rh,
    })
  }, [])

  // Recompute whenever container resizes (also fires when hidden → visible on tab switch)
  useEffect(() => {
    const c = containerRef.current
    if (!c || !naturalSize) return
    const obs = new ResizeObserver(() => computeImgRect(naturalSize))
    obs.observe(c)
    computeImgRect(naturalSize)
    return () => obs.disconnect()
  }, [naturalSize, computeImgRect])

  // ── Reset when switching files ──────────────────────────────────────────────
  useEffect(() => {
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setNaturalSize(null); setImgRect(null)
  }, [activeIdx])

  // ── Switch page when activeBbox points to a different file ──────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) setActiveIdx(activeBbox.page)
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Record natural size on load ─────────────────────────────────────────────
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const ns = { w: img.naturalWidth, h: img.naturalHeight }
    setNaturalSize(ns)
    computeImgRect(ns)
  }, [computeImgRect])

  // ── Auto-pan+zoom to activeBbox ─────────────────────────────────────────────
  const AUTO_ZOOM_MAX = 2.5

  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !naturalSize || !containerRef.current) return

    setBboxKey(k => k + 1)

    const rect = containerRef.current.getBoundingClientRect()
    const cw = rect.width  - PADDING * 2
    const ch = rect.height - PADDING * 2
    if (cw <= 0 || ch <= 0) return

    const scale  = Math.min(cw / naturalSize.w, ch / naturalSize.h)
    const rendW  = naturalSize.w * scale
    const rendH  = naturalSize.h * scale

    const bboxCx = activeBbox.x + activeBbox.w / 2
    const bboxCy = activeBbox.y + activeBbox.h / 2

    const rad    = (rotation * Math.PI) / 180
    const cosA   = Math.abs(Math.cos(rad))
    const sinA   = Math.abs(Math.sin(rad))
    const bboxVisW = (activeBbox.w * cosA + activeBbox.h * sinA) * rendW
    const bboxVisH = (activeBbox.h * cosA + activeBbox.w * sinA) * rendH

    if (bboxVisW < 2 || bboxVisH < 2) return

    const targetZoom = Math.min(
      Math.max((Math.min(cw, ch) * 0.4) / Math.max(bboxVisW, bboxVisH), 1.2),
      AUTO_ZOOM_MAX,
    )

    const dx = (bboxCx - 0.5) * rendW
    const dy = (bboxCy - 0.5) * rendH
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rdx = cos * dx - sin * dy
    const rdy = sin * dx + cos * dy

    const panX = -rdx * targetZoom
    const panY = -rdy * targetZoom
    const maxPanX = (rendW  * targetZoom - cw)  / 2
    const maxPanY = (rendH  * targetZoom - ch) / 2
    setZoom(targetZoom)
    setPan({
      x: Math.max(-maxPanX, Math.min(maxPanX, panX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, panY)),
    })
  }, [activeBbox, activeIdx, naturalSize, rotation]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toolbar actions ─────────────────────────────────────────────────────────
  const zoomIn      = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut     = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const rotateRight = () => setRotation(r => (r + 90) % 360)
  const rotateLeft  = () => setRotation(r => (r + 270) % 360)
  const reset       = () => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }) }

  // ── Mouse-wheel zoom ────────────────────────────────────────────────────────
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(); else zoomOut()
  }

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }
  const stopDrag = () => { setIsDragging(false); dragStart.current = null }

  const Btn = ({ onClick, children, title, disabled }: {
    onClick: () => void; children: React.ReactNode; title: string; disabled?: boolean
  }) => (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-md text-ink-4 hover:bg-[#3a352d] hover:text-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  const showBbox = activeBbox && activeBbox.page === activeIdx && isImage

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`
  const transition = isDragging ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)'

  return (
    <div className="flex flex-col bg-[#1f1d1a] w-full md:flex-1 md:min-w-0 overflow-hidden">

      {/* File / page tabs */}
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[#3a352d] bg-[#27241f] overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-gold/15 text-[#fcd34d]' : 'text-ink-4 hover:bg-[#3a352d]'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      {isImage && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[#3a352d] bg-[#27241f] shrink-0">
          <Btn onClick={zoomOut} title="Zoom out" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></Btn>
          <span className="text-xs font-mono text-ink-4 w-12 text-center select-none">
            {Math.round(zoom * 100)}%
          </span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={rotateLeft}  title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={rotateRight} title="Rotate right"><RotateCw size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={reset} title="Reset view"><Maximize2 size={14} /></Btn>
          {showBbox && (
            <span className="ml-auto text-[10.5px] text-[#fcd34d] font-medium px-2 py-0.5 bg-gold/15 rounded">
              line highlighted
            </span>
          )}
        </div>
      )}

      {/* Image / PDF / fallback */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden select-none relative"
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {isImage && file?.fileUrl ? (
          <>
            {/* Image — object-fit:contain guarantees it fits the container at any size */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.fileUrl}
              alt={file.fileName}
              draggable={false}
              onLoad={handleImageLoad}
              className="rounded-lg shadow-sm border border-gray-200"
              style={{
                position: 'absolute',
                left: PADDING, top: PADDING, right: PADDING, bottom: PADDING,
                width: `calc(100% - ${PADDING * 2}px)`,
                height: `calc(100% - ${PADDING * 2}px)`,
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
                transform,
                transformOrigin: 'center center',
                transition,
                userSelect: 'none',
              }}
            />

            {/* SVG bbox overlay — positioned to match the rendered image pixels */}
            {showBbox && imgRect && (
              <svg
                key={bboxKey}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{
                  position: 'absolute',
                  left: imgRect.x,
                  top: imgRect.y,
                  width: imgRect.w,
                  height: imgRect.h,
                  pointerEvents: 'none',
                  overflow: 'visible',
                  transform,
                  transformOrigin: 'center center',
                  transition,
                }}
                className="rounded-lg"
              >
                <rect
                  className="bbox-highlight"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="rgba(251, 191, 36, 0.22)" rx="0.004"
                />
                <rect
                  className="bbox-ring"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="none" stroke="rgb(245, 158, 11)" strokeWidth="0.003" rx="0.004"
                />
                <CornerAccent cx={activeBbox!.x} cy={activeBbox!.y} size={0.018} position="tl" />
                <CornerAccent cx={activeBbox!.x + activeBbox!.w} cy={activeBbox!.y + activeBbox!.h} size={0.018} position="br" />
              </svg>
            )}
          </>
        ) : isPdf && file?.fileUrl ? (
          <div className="absolute inset-0 p-2">
            <iframe
              src={file.fileUrl}
              title={file.fileName}
              className="w-full h-full rounded-lg border border-gray-200 bg-paper"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
            <FileText size={40} className="text-gray-300" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-[#3a352d] bg-[#27241f] shrink-0">
        <p className="font-mono text-[10px] text-ink-3 truncate">{file?.fileName}</p>
      </div>
    </div>
  )
}

// ── Corner accent ──────────────────────────────────────────────────────────────
function CornerAccent({ cx, cy, size, position }: {
  cx: number; cy: number; size: number; position: 'tl' | 'br'
}) {
  const s = size
  const paths = {
    tl: `M ${cx + s} ${cy} L ${cx} ${cy} L ${cx} ${cy + s}`,
    br: `M ${cx - s} ${cy} L ${cx} ${cy} L ${cx} ${cy - s}`,
  }
  return (
    <path
      className="bbox-ring"
      d={paths[position]}
      fill="none"
      stroke="rgb(245, 158, 11)"
      strokeWidth="0.004"
      strokeLinecap="round"
    />
  )
}

```


---

## `src/components/invoices/v2/context.tsx`

```tsx
'use client'
// DrawerContext — shared state for the invoice review drawer.
// Provider is built in Phase 5. This file defines the shape and the hook.

import { createContext, useContext } from 'react'
import type { ScanItem } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import type { ReconcileResult } from './composites'
import type { FilterKey, SortMode } from '@/lib/invoice/filters'

export interface DrawerContextValue {
  // ── Server-sourced data ────────────────────────────────────────────────────
  lines: ScanItem[]
  revenueCenters: RevenueCenter[]

  // ── Client-side staged edits ───────────────────────────────────────────────
  editedLines: Map<string, Partial<ScanItem>>

  // ── UI state ───────────────────────────────────────────────────────────────
  expandedLineIds: Set<string>
  flashingLineIds: Set<string>        // temporary flash highlight after goToTask
  activeFilters: Set<FilterKey>
  sortMode: SortMode
  pickingLinkForId: string | null     // which line's link picker is open
  modeWritebackItems: Set<string>     // lines where user wants to update product default mode
  acknowledgedPriceLines: Set<string> // lines where the user accepted the price change

  // ── Reconciliation result ──────────────────────────────────────────────────
  reconciliation: ReconcileResult | null

  // ── Computed helpers ───────────────────────────────────────────────────────
  /** Returns server line with staged edits applied. */
  getEffectiveLine: (id: string) => ScanItem
  /** Looks up the full RevenueCenter for a line's revenueCenterId. */
  getItemRc: (id: string) => RevenueCenter | null

  // ── Line mutations ─────────────────────────────────────────────────────────
  updateLine: (id: string, patch: Partial<ScanItem>) => void
  clearLineEdits: (id: string) => void

  // ── Expand / collapse ──────────────────────────────────────────────────────
  toggleExpand: (id: string, forceOpen?: boolean) => void

  // ── Revenue center ─────────────────────────────────────────────────────────
  setLineRc: (id: string, rc: RevenueCenter | null) => void

  // ── Link picker ────────────────────────────────────────────────────────────
  startLinkPicker: (id: string) => void
  closeLinkPicker: () => void

  // ── Create new inventory item modal ───────────────────────────────────────
  openCreateNew: (item: ScanItem) => void

  // ── Edit linked inventory item ─────────────────────────────────────────────
  openInventoryEdit: (inventoryItemId: string) => void

  // ── Mode writeback checkbox ────────────────────────────────────────────────
  toggleModeWriteback: (id: string) => void

  // ── Price-change acknowledgement (resolves the price .issue) ───────────────
  acknowledgePrice: (id: string) => void

  // ── Active bbox for image highlight ────────────────────────────────────────
  activeBboxItemId: string | null     // which line card is expanded + has a bbox

  // ── Filters / sort ─────────────────────────────────────────────────────────
  toggleFilter: (k: FilterKey) => void
  setSortMode: (m: SortMode) => void
}

export const DrawerContext = createContext<DrawerContextValue | null>(null)

export function useDrawerContext(): DrawerContextValue {
  const ctx = useContext(DrawerContext)
  if (!ctx) throw new Error('useDrawerContext must be called inside <InvoiceReviewDrawer>')
  return ctx
}

```


---

## `src/components/invoices/InboxViewV2.tsx`

```tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { formatCurrency } from '@/lib/utils'
import {
  FileText, ChefHat, ArrowRight, TrendingUp, TrendingDown,
  Upload, Clock, CheckCircle2, AlertTriangle, X, Loader2,
} from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PriceAlert {
  id: string
  direction: string
  changePct: number
  previousPrice: number
  newPrice: number
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  changePct: number
  newFoodCostPct: number | null
  exceededThreshold: boolean
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null }
}

interface Props {
  sessions: SessionSummary[]
  onSelectSession: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Partial<Record<SessionStatus, string>> = {
  REVIEW:     'Needs review',
  PROCESSING: 'Processing',
  UPLOADING:  'Uploading',
  APPROVING:  'Applying',
  ERROR:      'Error',
}

const STATUS_TINT: Partial<Record<SessionStatus, { bg: string; text: string; dot: string }>> = {
  REVIEW:     { bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
  PROCESSING: { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  UPLOADING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  APPROVING:  { bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue' },
  ERROR:      { bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
}

function fmtDate(d: string | null) {
  if (!d) return null
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtAge(createdAt: string) {
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000)
  if (mins < 1)    return 'just now'
  if (mins < 60)   return `${mins}m ago`
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHead({ label, count, action }: { label: string; count: number; action?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between mb-2 px-1">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3 flex items-baseline gap-2">
        {label}
        {count > 0 && <span className="font-mono text-[10.5px] text-ink-2 normal-case tracking-normal">· {count}</span>}
      </h3>
      {action}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function InboxViewV2({ sessions, onSelectSession, onUploadClick, onScanClick }: Props) {
  const [priceAlerts, setPriceAlerts]   = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [dismissing, setDismissing]     = useState<Set<string>>(new Set())

  const fetchAlerts = useCallback(async () => {
    try {
      const data = await fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      if (data) {
        setPriceAlerts(data.priceAlerts ?? [])
        setRecipeAlerts(data.recipeAlerts ?? [])
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchAlerts()
    const t = setInterval(fetchAlerts, 30_000)
    return () => clearInterval(t)
  }, [fetchAlerts])

  // Queue: non-approved, non-rejected sessions, sorted by urgency
  const queue = sessions
    .filter(s => !['APPROVED', 'REJECTED'].includes(s.status))
    .sort((a, b) => {
      const order: Partial<Record<SessionStatus, number>> = { REVIEW: 0, ERROR: 1, APPROVING: 2, PROCESSING: 3, UPLOADING: 4 }
      return (order[a.status] ?? 9) - (order[b.status] ?? 9)
    })

  // Recent approved — last 5
  const recent = sessions.filter(s => s.status === 'APPROVED').slice(0, 5)

  const alertCount = priceAlerts.length + recipeAlerts.length

  async function dismissPriceAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceAlertIds: [id] }),
      })
      setPriceAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissRecipeAlert(id: string) {
    setDismissing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/invoices/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeAlertIds: [id] }),
      })
      setRecipeAlerts(prev => prev.filter(a => a.id !== id))
    } finally {
      setDismissing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  async function dismissAll() {
    await fetch('/api/invoices/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeAll: true }),
    })
    setPriceAlerts([])
    setRecipeAlerts([])
  }

  return (
    <div className="space-y-6">
      {/* ── Queue ────────────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Queue"
          count={queue.length}
          action={
            <div className="flex items-center gap-2">
              {onScanClick && (
                <button
                  onClick={onScanClick}
                  className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors"
                >
                  <FileText size={12} className="text-ink-3" /> Scan
                </button>
              )}
              <button
                onClick={onUploadClick}
                className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors"
              >
                <Upload size={12} className="text-gold" /> Upload
              </button>
            </div>
          }
        />
        {queue.length === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-10 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">All clear</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No pending invoices — your inbox is empty.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {queue.map((session, idx) => {
              const isActive = session.status === 'PROCESSING' || session.status === 'UPLOADING' || session.status === 'APPROVING'
              const isError  = session.status === 'ERROR'
              const canOpen  = session.status === 'REVIEW' || session.status === 'ERROR'
              const tint = STATUS_TINT[session.status] ?? { bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
              const isLast = idx === queue.length - 1

              return (
                <div
                  key={session.id}
                  onClick={() => canOpen && onSelectSession(session.id)}
                  className={`group grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3.5 transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${canOpen ? 'cursor-pointer hover:bg-bg-2/40' : 'cursor-default'} ${isError ? 'bg-red-soft/30' : ''}`}
                >
                  {/* Status icon */}
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${tint.bg}`}>
                    {isActive
                      ? <Loader2 size={15} className={`${tint.text} animate-spin`} />
                      : isError
                        ? <AlertTriangle size={15} className={tint.text} />
                        : <FileText size={15} className={tint.text} />
                    }
                  </div>

                  {/* Content */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-ink tracking-[-0.01em] truncate">
                        {session.supplierName ?? 'Unknown supplier'}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${tint.bg} ${tint.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${tint.dot}`} />
                        {STATUS_LABEL[session.status] ?? session.status}
                      </span>
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0]">
                      {session.invoiceNumber && <><span className="text-ink-2">#{session.invoiceNumber}</span> · </>}
                      {session.invoiceDate && <>{fmtDate(session.invoiceDate)} · </>}
                      <b className="text-ink-2 font-medium">{session._count.scanItems}</b> {session._count.scanItems === 1 ? 'line' : 'lines'}
                      {(session._count.priceAlerts > 0 || session._count.recipeAlerts > 0) && (
                        <> · <span className="text-gold-2 font-semibold">{session._count.priceAlerts + session._count.recipeAlerts} alert{session._count.priceAlerts + session._count.recipeAlerts === 1 ? '' : 's'}</span></>
                      )}
                      <> · <span className="text-ink-4">{fmtAge(session.createdAt)}</span></>
                    </div>
                  </div>

                  {/* Total */}
                  {session.total && (
                    <div className="font-mono text-[13.5px] font-semibold text-ink tabular-nums tracking-[-0.01em] text-right whitespace-nowrap">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </div>
                  )}

                  {/* CTA */}
                  {canOpen ? (
                    <button className="font-mono text-[11px] px-3 py-1.5 rounded-full bg-ink text-paper font-medium hover:bg-[#27272a] transition-colors whitespace-nowrap">
                      {isError ? 'Retry' : 'Review'}
                    </button>
                  ) : (
                    <span className="w-7" />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Price & recipe alerts ───────────────────────────────────────── */}
      <section>
        <SectionHead
          label="Active alerts"
          count={alertCount}
          action={alertCount > 0 ? (
            <button
              onClick={dismissAll}
              className="font-mono text-[10.5px] text-ink-3 hover:text-ink-2 transition-colors uppercase tracking-[0.04em]"
            >
              Dismiss all
            </button>
          ) : null}
        />
        {alertCount === 0 ? (
          <div className="bg-paper border border-line rounded-[12px] px-6 py-8 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.04em] text-green-text">Costs stable</p>
            <p className="text-[13px] text-ink-3 mt-1.5">No price or recipe alerts.</p>
          </div>
        ) : (
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {priceAlerts.map((alert, idx) => {
              const up = alert.direction === 'UP'
              const isLast = idx === priceAlerts.length - 1 && recipeAlerts.length === 0
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${up ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'}`}>
                    {up ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.inventoryItem.itemName}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {formatCurrency(Number(alert.previousPrice))} <span className="text-ink-4">→</span> <span className="text-ink-2">{formatCurrency(Number(alert.newPrice))}</span>
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <div className={`font-mono text-[13px] font-semibold tabular-nums whitespace-nowrap ${up ? 'text-red-text' : 'text-green-text'}`}>
                    {up ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                  </div>
                  <button
                    onClick={() => dismissPriceAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}

            {recipeAlerts.map((alert, idx) => {
              const isLast = idx === recipeAlerts.length - 1
              const sev    = alert.exceededThreshold
              return (
                <div key={alert.id}
                  className={`grid grid-cols-[40px_1fr_auto_auto] gap-3.5 items-center px-[18px] py-3 ${isLast ? '' : 'border-b border-line'}`}>
                  <div className={`w-9 h-9 rounded-[9px] grid place-items-center shrink-0 ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    <ChefHat size={15} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">{alert.recipe.name}</div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {sev && alert.newFoodCostPct !== null && (
                        <span className="text-red-text font-semibold">FC {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% over target · </span>
                      )}
                      Cost {Number(alert.changePct) > 0 ? '+' : ''}{Number(alert.changePct).toFixed(1)}%
                      {alert.session.supplierName && <> · {alert.session.supplierName}</>}
                    </div>
                  </div>
                  <span className={`font-mono text-[10.5px] uppercase tracking-[0.04em] font-semibold px-2 py-0.5 rounded-full ${sev ? 'bg-red-soft text-red-text' : 'bg-gold-soft text-gold-2'}`}>
                    Recipe
                  </span>
                  <button
                    onClick={() => dismissRecipeAlert(alert.id)}
                    disabled={dismissing.has(alert.id)}
                    title="Dismiss"
                    className="w-7 h-7 rounded-md grid place-items-center text-ink-3 hover:text-ink hover:bg-bg-2 disabled:opacity-40 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ── Recent activity ─────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section>
          <SectionHead label="Recently approved" count={0} />
          <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
            {recent.map((session, idx) => {
              const isLast = idx === recent.length - 1
              return (
                <button
                  key={session.id}
                  onClick={() => onSelectSession(session.id)}
                  className={`group w-full grid grid-cols-[28px_1fr_auto_auto] gap-3 items-center px-[18px] py-2.5 text-left hover:bg-bg-2/40 transition-colors ${isLast ? '' : 'border-b border-line'}`}
                >
                  <CheckCircle2 size={14} className="text-green-text shrink-0" />
                  <span className="text-[13px] text-ink-2 truncate">
                    {session.supplierName ?? 'Unknown'}
                    {session.invoiceDate ? <span className="font-mono text-[10.5px] text-ink-3"> · {fmtDate(session.invoiceDate)}</span> : ''}
                  </span>
                  {session.total ? (
                    <span className="font-mono text-[12.5px] text-ink tabular-nums shrink-0">
                      {formatCurrency(parseFloat(String(session.total)))}
                    </span>
                  ) : <span />}
                  <span className="font-mono text-[10.5px] text-ink-3 shrink-0 inline-flex items-center gap-1">
                    <Clock size={10} /> {fmtAge(session.createdAt)}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-2">
        <span>QUEUE REFRESHES EVERY 30S · OCR THEN REVIEW THEN APPROVE</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD
        </span>
      </div>

      <ArrowRight className="hidden" /> {/* preserve import (used elsewhere historically) */}
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceListV2.tsx`

```tsx
'use client'
import { useState, useMemo } from 'react'
import { Trash2, X, ChevronsUpDown, ChevronUp, ChevronDown, Search, FileText, Upload, MoreHorizontal, RotateCcw } from 'lucide-react'
import { SessionSummary, SessionStatus } from './types'
import { formatCurrency } from '@/lib/utils'

type Tab    = 'all' | 'REVIEW' | 'APPROVED' | 'REJECTED'
type ColKey = 'supplier' | 'date' | 'total' | 'items' | 'status'
type ColDir = 'asc' | 'desc'

// First-click direction: text cols A→Z, numeric/date cols newest/highest first
const COL_DEFAULT_DIR: Record<ColKey, ColDir> = {
  supplier: 'asc',
  date:     'desc',
  total:    'desc',
  items:    'desc',
  status:   'asc',
}

const STATUS_ORDER: Record<string, number> = {
  REVIEW: 0, PROCESSING: 1, APPROVING: 1, UPLOADING: 2, APPROVED: 3, REJECTED: 4, ERROR: 5,
}

interface Props {
  sessions: SessionSummary[]
  onSelect: (id: string) => void
  onUploadClick: () => void
  onScanClick?: () => void
  onDelete: (id: string, status: SessionStatus) => Promise<void>
  onBulkDelete: (ids: string[]) => Promise<void>
  onRetry: (id: string) => Promise<void>
}

// ── Branded status badge ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SessionStatus }) {
  const map: Partial<Record<SessionStatus, { label: string; bg: string; text: string; dot: string; pulse?: boolean }>> = {
    REVIEW:     { label: 'Review',     bg: 'bg-gold-soft',  text: 'text-gold-2',    dot: 'bg-gold' },
    APPROVED:   { label: 'Approved',   bg: 'bg-green-soft', text: 'text-green-text', dot: 'bg-green' },
    REJECTED:   { label: 'Rejected',   bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
    PROCESSING: { label: 'Processing', bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    APPROVING:  { label: 'Applying',   bg: 'bg-blue-soft',  text: 'text-blue-text', dot: 'bg-blue', pulse: true },
    UPLOADING:  { label: 'Uploading',  bg: 'bg-bg-2',       text: 'text-ink-3',     dot: 'bg-ink-4', pulse: true },
    ERROR:      { label: 'Error',      bg: 'bg-red-soft',   text: 'text-red-text',  dot: 'bg-red' },
  }
  const t = map[status] ?? { label: String(status), bg: 'bg-bg-2', text: 'text-ink-3', dot: 'bg-ink-4' }
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] font-medium px-2 py-0.5 rounded-full ${t.bg} ${t.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot} ${t.pulse ? 'animate-pulse' : ''}`} />
      {t.label}
    </span>
  )
}

function SortIcon({ col, colSort }: { col: ColKey; colSort: { col: ColKey; dir: ColDir } | null }) {
  if (!colSort || colSort.col !== col)
    return <ChevronsUpDown size={10} className="text-ink-4 ml-0.5 inline-block shrink-0" />
  return colSort.dir === 'asc'
    ? <ChevronUp   size={10} className="text-gold ml-0.5 inline-block shrink-0" />
    : <ChevronDown size={10} className="text-gold ml-0.5 inline-block shrink-0" />
}

function SortTh({ col, label, colSort, onSort, className = '' }: {
  col: ColKey; label: string
  colSort: { col: ColKey; dir: ColDir } | null
  onSort: (c: ColKey) => void
  className?: string
}) {
  const active = colSort?.col === col
  return (
    <button
      onClick={() => onSort(col)}
      className={`inline-flex items-center gap-0.5 font-mono text-[10px] uppercase tracking-[0.04em] rounded transition-colors whitespace-nowrap
        ${active ? 'text-gold' : 'text-ink-3 hover:text-ink-2'} ${className}`}
    >
      {label}
      <SortIcon col={col} colSort={colSort} />
    </button>
  )
}

function Checkbox({ checked, indeterminate, onChange }: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange() }}
      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
        checked || indeterminate
          ? 'bg-ink border-ink text-paper'
          : 'border-line bg-paper hover:border-ink-3'
      }`}
    >
      {checked && <span className="text-[10px] leading-none">✓</span>}
      {indeterminate && !checked && <span className="block w-2 h-0.5 bg-paper" />}
    </button>
  )
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function InvoiceListV2({ sessions, onSelect, onUploadClick, onScanClick, onDelete, onBulkDelete, onRetry }: Props) {
  const [tab, setTab]                     = useState<Tab>('all')
  const [search, setSearch]               = useState('')
  const [openMenu, setOpenMenu]           = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting]       = useState(false)
  const [colSort, setColSort]             = useState<{ col: ColKey; dir: ColDir } | null>(null)

  const [selectedIds, setSelectedIds]             = useState<Set<string>>(new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [isBulkDeleting, setIsBulkDeleting]       = useState(false)

  const reviewCount = sessions.filter(s => s.status === 'REVIEW').length

  const handleSort = (col: ColKey) => {
    setColSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: COL_DEFAULT_DIR[col] }
      return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const filtered = useMemo(() => {
    let rows = sessions.filter(s => {
      if (tab !== 'all' && s.status !== tab) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          (s.supplierName?.toLowerCase().includes(q) ?? false) ||
          (s.invoiceNumber?.toLowerCase().includes(q) ?? false)
        )
      }
      return true
    })

    if (colSort) {
      const { col, dir } = colSort
      const sign = dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        switch (col) {
          case 'supplier': {
            const aName = (a.supplierName ?? '').toLowerCase()
            const bName = (b.supplierName ?? '').toLowerCase()
            return sign * aName.localeCompare(bName)
          }
          case 'date': {
            const aD = a.invoiceDate ?? a.createdAt
            const bD = b.invoiceDate ?? b.createdAt
            return sign * aD.localeCompare(bD)
          }
          case 'total': return sign * (Number(a.total ?? 0) - Number(b.total ?? 0))
          case 'items': return sign * (a._count.scanItems - b._count.scanItems)
          case 'status': return sign * ((STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
          default: return 0
        }
      })
    }

    return rows
  }, [sessions, tab, search, colSort])

  const allSelected  = filtered.length > 0 && filtered.every(s => selectedIds.has(s.id))
  const someSelected = filtered.some(s => selectedIds.has(s.id))
  const selectedInView = filtered.filter(s => selectedIds.has(s.id))
  const hasApproved    = selectedInView.some(s => s.status === 'APPROVED')

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.delete(s.id)); return n })
    } else {
      setSelectedIds(prev => { const n = new Set(prev); filtered.forEach(s => n.add(s.id)); return n })
    }
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleDelete = async (id: string, status: SessionStatus) => {
    setIsDeleting(true)
    await onDelete(id, status)
    setIsDeleting(false)
    setDeleteConfirm(null)
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const handleBulkDelete = async () => {
    setIsBulkDeleting(true)
    await onBulkDelete(selectedInView.map(s => s.id))
    setIsBulkDeleting(false)
    setBulkDeleteConfirm(false)
    clearSelection()
  }

  return (
    <div className="space-y-3">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Filter pills */}
        <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px] gap-0.5">
          {(['all', 'REVIEW', 'APPROVED', 'REJECTED'] as Tab[]).map(t => (
            <button key={t} onClick={() => { setTab(t); clearSelection() }}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                tab === t ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              {t === 'all' ? 'All' : t === 'REVIEW' ? 'Review' : t === 'APPROVED' ? 'Approved' : 'Rejected'}
              {t === 'REVIEW' && reviewCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${tab === t ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{reviewCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1 min-w-[200px] relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); clearSelection() }}
            placeholder="Search supplier or invoice #…"
            className="w-full bg-paper border border-line rounded-[9px] pl-8 pr-3 py-[7px] text-[13px] text-ink placeholder-ink-4 focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {onScanClick && (
            <button onClick={onScanClick}
              className="inline-flex items-center gap-1.5 border border-line bg-paper text-ink-2 px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:border-ink-3 transition-colors">
              <FileText size={12} className="text-ink-3" /> Scan
            </button>
          )}
          <button onClick={onUploadClick}
            className="inline-flex items-center gap-1.5 bg-ink text-paper px-3 py-[7px] rounded-[8px] text-[12.5px] font-medium hover:bg-[#18181b] transition-colors">
            <Upload size={12} className="text-gold" /> Upload
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selectedInView.length > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-ink text-paper rounded-[10px]">
          <span className="font-mono text-[11px] uppercase tracking-[0.04em]">
            <span className="text-gold font-semibold">{selectedInView.length}</span> selected
          </span>
          <div className="flex-1" />
          <button onClick={clearSelection}
            className="font-mono text-[11px] uppercase tracking-[0.04em] text-zinc-400 hover:text-paper inline-flex items-center gap-1 transition-colors">
            <X size={11} /> Clear
          </button>
          <button onClick={() => setBulkDeleteConfirm(true)}
            className="inline-flex items-center gap-1.5 bg-red-600 text-white text-[12px] font-medium px-3 py-1.5 rounded-[8px] hover:bg-red-700 transition-colors">
            <Trash2 size={11} /> Delete {selectedInView.length}
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="bg-paper border border-line rounded-[12px] overflow-hidden">
        {/* Desktop column headers */}
        <div className="hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-2.5 bg-bg-2 border-b border-line items-center">
          <Checkbox checked={allSelected} indeterminate={someSelected && !allSelected} onChange={toggleAll} />
          <SortTh col="supplier" label="Supplier / Invoice" colSort={colSort} onSort={handleSort} />
          <SortTh col="date"     label="Date"               colSort={colSort} onSort={handleSort} />
          <SortTh col="total"    label="Total"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="items"    label="Items"              colSort={colSort} onSort={handleSort} className="justify-self-end" />
          <SortTh col="status"   label="Status"             colSort={colSort} onSort={handleSort} />
          <div />
        </div>

        <div onClick={() => setOpenMenu(null)}>
          {filtered.length === 0 && (
            <div className="py-12 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">No invoices found</div>
          )}

          {filtered.map((s, idx) => {
            const isSelected = selectedIds.has(s.id)
            const isInflight = s.status === 'PROCESSING' || s.status === 'APPROVING' || s.status === 'ERROR'
            const canOpen    = !isInflight
            const isLast     = idx === filtered.length - 1
            return (
              <div key={s.id}>
                {/* Desktop row */}
                <div
                  className={`hidden sm:grid grid-cols-[36px_1fr_110px_120px_70px_110px_36px] gap-2 px-[18px] py-3 items-center transition-colors ${
                    isLast ? '' : 'border-b border-line'
                  } ${
                    isInflight ? 'opacity-70 cursor-default'
                    : isSelected ? 'bg-gold-soft/40 hover:bg-gold-soft/60 cursor-pointer'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30 hover:bg-gold-soft/50 cursor-pointer'
                    : 'hover:bg-bg-2/40 cursor-pointer'
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                        {s.supplierName ?? 'Unknown supplier'}
                      </span>
                      {s.parentSessionId && (
                        <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                      )}
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-0.5 tracking-[0]">
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''} · </span>
                      )}
                      {s.invoiceNumber ?? 'No invoice #'}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-0.5 tracking-[0]" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2">{s.invoiceDate ?? '—'}</div>
                  <div className="font-mono text-[13px] font-semibold text-ink tabular-nums text-right tracking-[-0.01em]">
                    {s.total ? formatCurrency(Number(s.total)) : '—'}
                  </div>
                  <div className="font-mono text-[12px] text-ink-2 text-right tabular-nums">{s._count.scanItems}</div>
                  <div><StatusBadge status={s.status} /></div>
                  <div className="relative justify-self-end" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-7 h-7 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-0 top-8 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Mobile row */}
                <div
                  className={`sm:hidden flex items-stretch transition-colors ${isLast ? '' : 'border-b border-line'} ${
                    isInflight ? 'opacity-70'
                    : isSelected ? 'bg-gold-soft/40'
                    : s.status === 'REVIEW' ? 'bg-gold-soft/30' : ''
                  }`}
                  onClick={() => canOpen && onSelect(s.id)}
                >
                  <div className="flex items-center pl-3 pr-1 shrink-0" onClick={e => { e.stopPropagation(); toggleOne(s.id) }}>
                    <Checkbox checked={isSelected} onChange={() => toggleOne(s.id)} />
                  </div>
                  <div className="flex-1 min-w-0 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13.5px] font-medium text-ink tracking-[-0.005em] truncate">
                          {s.supplierName ?? 'Unknown supplier'}
                        </span>
                        {s.parentSessionId && (
                          <span className="font-mono text-[9px] uppercase tracking-[0.04em] font-semibold bg-bg-2 text-ink-3 px-1.5 py-0.5 rounded-[4px] shrink-0">Copy</span>
                        )}
                      </div>
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-3 mt-1 tracking-[0] flex items-center gap-2 flex-wrap">
                      {s.total && <span className="font-medium text-ink-2">{formatCurrency(Number(s.total))}</span>}
                      <span>{s.invoiceDate ?? '—'}</span>
                      {s._count.priceAlerts > 0 && (
                        <span className="text-gold-2 font-semibold">⚠ {s._count.priceAlerts} alert{s._count.priceAlerts !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                    {s.status === 'ERROR' && s.errorMessage && (
                      <div className="font-mono text-[10.5px] text-red-text truncate mt-1" title={s.errorMessage}>
                        {s.errorMessage}
                      </div>
                    )}
                  </div>
                  <div className="relative flex items-center pr-2 shrink-0" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => setOpenMenu(openMenu === s.id ? null : s.id)}
                      className="w-8 h-8 grid place-items-center rounded-md text-ink-3 hover:text-ink hover:bg-bg-2 transition-colors"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                    {openMenu === s.id && (
                      <div className="absolute right-2 top-9 z-10 bg-paper rounded-[10px] shadow-lg border border-line py-1 min-w-[140px]">
                        {s.status === 'ERROR' && (
                          <button
                            onClick={() => { onRetry(s.id); setOpenMenu(null) }}
                            className="w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-bg-2 inline-flex items-center gap-2"
                          >
                            <RotateCcw size={12} /> Retry scan
                          </button>
                        )}
                        <button
                          onClick={() => { setDeleteConfirm({ id: s.id, status: s.status }); setOpenMenu(null) }}
                          className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer hint */}
      <div className="flex justify-between font-mono text-[10.5px] text-ink-3 tracking-wide pt-1">
        <span>SHOWING {filtered.length} OF {sessions.length} {sessions.length === 1 ? 'INVOICE' : 'INVOICES'}</span>
        <span>
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2">⌘U</kbd> UPLOAD ·
          <kbd className="font-mono text-[10px] bg-bg-2 border border-line rounded px-1 py-px text-ink-2 ml-1">⌘F</kbd> SEARCH
        </span>
      </div>

      {/* ── Single delete confirmation modal ── */}
      {deleteConfirm && (
        <ConfirmModal
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={() => handleDelete(deleteConfirm.id, deleteConfirm.status)}
          confirming={isDeleting}
          title="Delete invoice?"
          body={
            deleteConfirm.status === 'APPROVED'
              ? 'This will remove the approved invoice and reverse its price updates.'
              : 'This will permanently delete the invoice session.'
          }
          confirmLabel="Delete"
        />
      )}

      {/* ── Bulk delete confirmation ── */}
      {bulkDeleteConfirm && (
        <ConfirmModal
          onCancel={() => setBulkDeleteConfirm(false)}
          onConfirm={handleBulkDelete}
          confirming={isBulkDeleting}
          title={`Delete ${selectedInView.length} invoice${selectedInView.length !== 1 ? 's' : ''}?`}
          body={
            hasApproved
              ? `${selectedInView.filter(s => s.status === 'APPROVED').length} approved invoice(s) selected — their price updates will be reversed.`
              : 'All selected invoice sessions will be permanently deleted.'
          }
          warning={hasApproved}
          confirmLabel={`Delete ${selectedInView.length}`}
        />
      )}
    </div>
  )
}

function ConfirmModal({ onCancel, onConfirm, confirming, title, body, warning = false, confirmLabel }: {
  onCancel: () => void
  onConfirm: () => void
  confirming: boolean
  title: string
  body: string
  warning?: boolean
  confirmLabel: string
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-paper border border-line rounded-[14px] p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div className="w-9 h-9 rounded-[9px] grid place-items-center shrink-0 bg-red-soft text-red-text">
            <Trash2 size={15} />
          </div>
          <div className="flex-1">
            <h3 className="text-[16px] font-semibold text-ink tracking-[-0.015em]">{title}</h3>
            <p className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-3 mt-0.5">This cannot be undone</p>
          </div>
        </div>
        {warning ? (
          <div className="bg-gold-soft border border-[#fcd34d]/60 rounded-[8px] px-3 py-2.5 text-[12.5px] text-gold-2 mb-4">
            {body}
          </div>
        ) : (
          <p className="text-[13px] text-ink-2 leading-[1.5] mb-4">{body}</p>
        )}
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 px-3 py-2 rounded-[9px] border border-line bg-paper text-[13px] text-ink-2 hover:border-ink-3 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={confirming}
            className="flex-1 px-3 py-2 rounded-[9px] bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 disabled:opacity-50 transition-colors">
            {confirming ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceKpiStripV2.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { KpiData } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  refreshKey: number  // increment to trigger a refetch
  activeRcId: string | null
  isDefault: boolean
}

/**
 * Branded invoice KPI strip — matches the /pass and /cost pattern.
 *
 * 1.4fr 1fr 1fr 1fr grid:
 *   - Hero (ink bg): This week spend with WoW delta and gold dollar accent
 *   - This month: ink-2 neutral with invoice count
 *   - Awaiting approval: gold-soft when > 0, neutral otherwise
 *   - Price alerts: red-soft when > 0, neutral otherwise
 *
 * Replaces the legacy InvoiceKpiStrip (gray-* tokens, 5-cell horizontal layout
 * including a sparkline that turned into clutter).
 */
export function InvoiceKpiStripV2({ refreshKey, activeRcId, isDefault }: Props) {
  const [kpis, setKpis] = useState<KpiData | null>(null)

  useEffect(() => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    fetch(`/api/invoices/kpis${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(data => data && setKpis(data))
      .catch(() => {})
  }, [refreshKey, activeRcId, isDefault])

  return (
    <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: '1.4fr 1fr 1fr 1fr' }}>
      <Hero kpis={kpis} />
      <Card
        label="This month"
        value={kpis ? formatCurrency(kpis.monthSpend) : '—'}
        delta={kpis ? <><b>{kpis.monthInvoiceCount}</b> {kpis.monthInvoiceCount === 1 ? 'invoice' : 'invoices'}</> : <>—</>}
      />
      <Card
        label="Awaiting approval"
        value={kpis ? String(kpis.awaitingApprovalCount) : '—'}
        valueClass={kpis && kpis.awaitingApprovalCount > 0 ? 'text-gold-2' : ''}
        delta={
          kpis && kpis.awaitingApprovalCount > 0
            ? <><b>{kpis.awaitingApprovalCount === 1 ? 'session' : 'sessions'}</b> in queue</>
            : <>all caught up</>
        }
        tint={kpis && kpis.awaitingApprovalCount > 0 ? 'warn' : 'neutral'}
      />
      <Card
        label="Price alerts"
        value={kpis ? String(kpis.priceAlertCount) : '—'}
        valueClass={kpis && kpis.priceAlertCount > 0 ? 'text-red-text' : ''}
        delta={
          kpis && kpis.priceAlertCount > 0
            ? <><b>review</b> · open Price alerts</>
            : <>none active</>
        }
        tint={kpis && kpis.priceAlertCount > 0 ? 'bad' : 'neutral'}
      />
    </div>
  )
}

function Hero({ kpis }: { kpis: KpiData | null }) {
  if (!kpis) {
    return (
      <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px]">
        <div>
          <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
          <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 text-zinc-600">—</div>
        </div>
        <div className="font-mono text-[11px] text-zinc-500">loading…</div>
      </div>
    )
  }

  const pct = kpis.weekSpendChangePct
  const trendIs = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'
  const trendCls = trendIs === 'up' ? 'text-red-300' : trendIs === 'down' ? 'text-green-400' : 'text-zinc-400'
  const arrow = trendIs === 'up' ? '↑' : trendIs === 'down' ? '↓' : '·'

  const formatted = formatCurrency(kpis.weekSpend)
  const [whole, cents] = formatted.split('.')

  return (
    <div className="bg-ink text-paper rounded-[12px] border border-ink p-5 flex flex-col justify-between min-h-[128px] relative overflow-hidden">
      <div>
        <div className="font-mono text-[10.5px] text-zinc-500 tracking-[0.01em]">THIS WEEK · INVOICE SPEND</div>
        <div className="text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2">
          {whole}
          <sub className="text-[18px] font-medium text-gold tracking-[-0.02em] align-baseline">.{cents ?? '00'}</sub>
        </div>
      </div>
      <div className="font-mono text-[11px] text-zinc-500 tracking-[0] flex items-center gap-1.5">
        <span className={`font-semibold ${trendCls}`}>{arrow} {Math.abs(pct).toFixed(1)}%</span>
        <span>vs last week</span>
      </div>
    </div>
  )
}

function Card({
  label, value, delta, valueClass = '', tint = 'neutral',
}: {
  label: string
  value: string
  delta: React.ReactNode
  valueClass?: string
  tint?: 'neutral' | 'warn' | 'bad'
}) {
  const cardCls = tint === 'warn'
    ? 'bg-gold-soft border-[#fcd34d]/60'
    : tint === 'bad'
      ? 'bg-red-soft border-red-200'
      : 'bg-paper border-line'
  const accent = tint === 'warn' ? 'bg-gold-2' : tint === 'bad' ? 'bg-red' : 'bg-gold'

  return (
    <div className={`border rounded-[12px] p-5 flex flex-col justify-between min-h-[128px] relative ${cardCls}`}>
      <div className={`absolute top-0 left-0 w-8 h-0.5 ${accent}`} />
      <div>
        <div className="font-mono text-[10.5px] text-ink-3 tracking-[0.01em] uppercase">{label}</div>
        <div className={`text-[34px] font-semibold tracking-[-0.04em] leading-none mt-2 ${valueClass || 'text-ink'}`}>{value}</div>
      </div>
      <div className="font-mono text-[11px] text-ink-3 tracking-[0] [&_b]:text-ink [&_b]:font-medium">{delta}</div>
    </div>
  )
}

```


---

## `src/components/invoices/InvoiceUploadModal.tsx`

```tsx
'use client'
import { useState, useRef } from 'react'
import {
  Upload, ScanLine, X, Loader2,
  Image, FileText, FileSpreadsheet,
} from 'lucide-react'
import { useUploadThing } from '@/lib/uploadthing-client'

interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
  activeRcId: string | null
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

export function InvoiceUploadModal({ onClose, onComplete, activeRcId }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [uploadStep, setUploadStep] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const utErrorRef = useRef<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => {
      utErrorRef.current = err.message ?? 'Upload service error'
    },
  })

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type === 'application/pdf' ||
      f.type === 'text/csv' || f.name.endsWith('.csv')
    )
    setFiles(prev => [...prev, ...dropped])
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files
    if (!picked || picked.length === 0) {
      console.warn('[upload] file input fired with no files')
      return
    }
    const arr = Array.from(picked)
    console.log('[upload] received', arr.length, 'file(s):', arr.map(f => `${f.name} (${f.type}, ${f.size}b)`).join(', '))
    setFiles(prev => [...prev, ...arr])
    e.target.value = ''
  }

  // Compress an image file to ≤1 MB at ≤2000 px using Canvas.
  // Non-image files (PDF, CSV) are returned as-is.
  const compressImageFile = (file: File): Promise<File> => {
    if (!file.type.startsWith('image/') || file.size <= 1 * 1024 * 1024) return Promise.resolve(file)
    return new Promise((resolve) => {
      const img = new window.Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const MAX_DIM = 2000
        let { width, height } = img
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height)
          width  = Math.round(width  * scale)
          height = Math.round(height * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width  = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return }
            const name = file.name.replace(/\.[^.]+$/, '.jpg')
            resolve(new File([blob], name, { type: 'image/jpeg' }))
          },
          'image/jpeg',
          0.82,
        )
      }
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
      img.src = objectUrl
    })
  }

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setUploadStep(null)
    setNoApiKey(false)

    try {
      // 0. Compress images client-side so large photos become ~0.5-1 MB.
      //    PDFs and CSVs are passed through unchanged.
      setUploadStep('Preparing files…')
      const compressedFiles = await Promise.all(files.map(compressImageFile))

      // 1. Create session
      setUploadStep('Creating session…')
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!sessRes.ok) {
        setScanError(`Session error (${sessRes.status}). Please try again.`)
        return
      }
      const sess = await sessRes.json()

      // 2a. Try UploadThing CDN (8s timeout — fail fast so local fallback kicks in)
      let uploadOk = false
      utErrorRef.current = null
      setUploadStep('Uploading to cloud…')
      try {
        const uploaded = await Promise.race([
          startUpload(compressedFiles),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('Cloud upload timed out')), 8_000)),
        ])
        if (uploaded?.length) {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: uploaded.map(f => ({ url: f.ufsUrl ?? f.url, fileName: f.name, fileType: f.type })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch (utErr) {
        utErrorRef.current = utErr instanceof Error ? utErr.message : 'Upload service error'
        // fall through to local
      }

      // 2b. Local fallback — stores compressed files as base64 in DB.
      //    Compressed images are typically <1 MB, well inside Vercel's 4.5 MB body limit.
      if (!uploadOk) {
        const totalBytes = compressedFiles.reduce((s, f) => s + f.size, 0)
        const limitBytes = 4 * 1024 * 1024
        if (totalBytes > limitBytes) {
          setScanError(
            `Files are too large to upload (${(totalBytes / 1024 / 1024).toFixed(1)} MB total after compression). ` +
            `Try using fewer pages, or upload a smaller PDF. ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '')
          )
          return
        }
        setUploadStep('Uploading…')
        const fd = new FormData()
        compressedFiles.forEach(f => fd.append('files', f))
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const errBody = await localRes.json().catch(() => ({}))
          setScanError(
            errBody.error ??
            `Upload failed (${localRes.status}). ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '') +
            `Please try again.`
          )
          return
        }
      }

      // 3. Fire process as fire-and-forget (drawer will poll for status updates)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 4. Close modal and open drawer on new session
      onComplete(sess.id)
    } catch (err) {
      setScanError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
      setUploadStep(null)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                <ScanLine size={16} className="text-gold" />
              </div>
              <h2 className="text-base font-bold text-gray-900">Upload Invoice</h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {scanError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
                <strong>Upload error:</strong> {scanError}
              </div>
            )}

            {noApiKey && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
                <strong>ANTHROPIC_API_KEY not set.</strong> Add your key to <code className="bg-amber-100 px-1 rounded">.env</code> and restart the server to enable OCR scanning.
              </div>
            )}

            {/* File upload */}
            {(
              <>
                {/* Dropzone is a <label> so the OS file picker is opened by HTML
                    semantics, not a JS click chain. Wrapping the input in an
                    onClick div caused iOS Safari (and some Chromium builds) to
                    re-fire the wrapper's click after the picker closed, silently
                    discarding the selection. */}
                <label
                  htmlFor="invoice-file-input"
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                    isDragging ? 'border-blue-400 bg-gold/10' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                  }`}
                >
                  <Upload size={32} className="text-gray-300" />
                  <div className="text-center">
                    <p className="font-medium text-gray-700">Drop files here or click to browse</p>
                    <p className="text-xs text-gray-400 mt-1">JPEG, PNG, PDF, CSV supported</p>
                  </div>
                  <input
                    id="invoice-file-input"
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.csv,text/csv"
                    className="sr-only"
                    onChange={handleFileInput}
                    onClick={e => e.stopPropagation()}
                  />
                </label>

                {files.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-3">
                        {fileIcon(f.type)}
                        <span className="flex-1 text-sm text-gray-700 truncate">{f.name}</span>
                        <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} KB</span>
                        <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}>
                          <X size={14} className="text-gray-300 hover:text-red-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer with Scan button */}
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            <button
              onClick={handleStartScan}
              disabled={files.length === 0 || isCreating}
              className="w-full bg-gold text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {uploadStep ?? (isCreating ? 'Starting…' : `Upload${files.length > 0 ? ` ${files.length} ${files.length > 1 ? 'files' : 'file'}` : ' Invoice'}`)}
            </button>
          </div>
        </div>
      </div>

    </>
  )
}

```


---

## `src/components/invoices/ProcessingToast.tsx`

```tsx
'use client'
import { useEffect, useRef } from 'react'
import { CheckCircle2, X } from 'lucide-react'

interface Props {
  supplierName: string | null
  invoiceNumber: string | null
  onReview: () => void
  onDismiss: () => void
  label?: string
  actionLabel?: string
}

export function ProcessingToast({ supplierName, invoiceNumber, onReview, onDismiss, label: toastLabel, actionLabel }: Props) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    const t = setTimeout(() => onDismissRef.current(), 6000)
    return () => clearTimeout(t)
  }, []) // intentionally empty — timer starts once on mount

  const name = supplierName ?? invoiceNumber ?? 'Invoice'
  const statusLabel = toastLabel ?? 'Ready for review'
  const ctaLabel = actionLabel ?? 'Review'

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-6 sm:bottom-8 z-[70] w-[calc(100vw-32px)] sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-xl flex items-start gap-3 p-4 toast-enter">
      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
        <CheckCircle2 size={16} className="text-green-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{statusLabel}</p>
        <button
          onClick={onReview}
          className="mt-2 text-xs font-semibold text-gold hover:text-blue-800"
        >
          {ctaLabel} →
        </button>
      </div>
      <button onClick={onDismiss} className="text-gray-300 hover:text-gray-500 shrink-0">
        <X size={14} />
      </button>
    </div>
  )
}

```


---

## `src/components/invoices/InboxSubNav.tsx`

```tsx
'use client'
import { useEffect, useState } from 'react'
import { Mail, AlertCircle, AlertTriangle } from 'lucide-react'
import { SubNav } from '@/components/layout/SubNav'

interface Counts {
  invoices: number      // awaiting approval
  priceAlerts: number   // unacknowledged
  exceptions: number    // unmatched lines + dupes
}

export function InboxSubNav() {
  const [counts, setCounts] = useState<Counts>({ invoices: 0, priceAlerts: 0, exceptions: 0 })

  useEffect(() => {
    const load = async () => {
      try {
        const [k, a] = await Promise.all([
          fetch('/api/invoices/kpis', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch('/api/invoices/alerts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        ])
        setCounts({
          invoices:    k?.awaitingApprovalCount ?? 0,
          priceAlerts: a?.priceAlerts?.length ?? 0,
          exceptions:  k?.exceptionsCount ?? 0,
        })
      } catch {}
    }
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <SubNav
      tabs={[
        { href: '/invoices',                label: 'Invoices',     icon: <BadgeIcon icon={<Mail size={13} />}        n={counts.invoices} /> },
        { href: '/invoices/price-alerts',   label: 'Price alerts', icon: <BadgeIcon icon={<AlertTriangle size={13} />} n={counts.priceAlerts} /> },
        { href: '/invoices/exceptions',     label: 'Exceptions',   icon: <BadgeIcon icon={<AlertCircle size={13} />}  n={counts.exceptions} /> },
      ]}
    />
  )
}

function BadgeIcon({ icon, n }: { icon: React.ReactNode; n: number }) {
  return (
    <span className="relative inline-flex items-center">
      {icon}
      {n > 0 && (
        <span className="font-mono text-[9.5px] bg-gold text-ink font-semibold ml-1.5 px-1.5 py-px rounded-full leading-none">
          {n > 99 ? '99+' : n}
        </span>
      )}
    </span>
  )
}

```
