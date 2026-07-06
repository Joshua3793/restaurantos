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
import { canonicalUom } from '@/lib/uom'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InventorySearchResult {
  id: string
  itemName: string
  abbreviation?: string | null
  purchasePrice: number
  pricePerBaseUnit: number
  baseUnit: string
  category: string
  // Chain pricing facts (PRICING_SELECT) — flow through to matchedItem so pack
  // display + format prefill + pricing mode derive from the chain.
  dimension?: string
  packChain?: unknown
  pricing?: unknown
  countUnit?: string | null
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
  // Per-weight fields. A SINGLE weight unit governs both the qty shipped and the
  // rate denominator: `qty × rate = line total` is only dimensionally sound when
  // both share a unit, and the spine write (approve) + price comparison both read
  // `rateUOM` to convert to the item's base. So the weight dropdown IS the rate
  // unit — pick kg and the rate becomes $/kg (was hard-coded to $/lb, which
  // mislabelled every non-lb catch-weight line and corrupted the conversion).
  // Default to the invoice's own price basis (rateUOM), then the shipped-weight
  // unit, then the nominal-weight unit.
  const [wQty,      setWQty]      = useState(item.totalQty        ? String(Number(item.totalQty))        : '')
  const [weightUOM, setWeightUOM] = useState(item.rateUOM ?? item.totalQtyUOM ?? item.qtyOrderedUOM ?? 'lb')
  const [rate,      setRate]      = useState(item.rate            ? String(Number(item.rate))            : '')
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
    totalQtyUOM:   mode === 'per_weight' ? weightUOM         : item.totalQtyUOM,
    rate:          mode === 'per_weight' ? (rate    || null) : item.rate,
    rateUOM:       mode === 'per_weight' ? weightUOM         : item.rateUOM,
    pricingMode:   mode,
  }

  const math = computeLineMath(localItem)
  // Show the mismatch resolver whenever the numbers don't reconcile — not only
  // after the user edits a field. An OCR mismatch the user hasn't touched is
  // exactly the case that needs the loud fix panel (it's what the attention
  // strip's "fix ↓" jumps to); gating it behind edits kept it hidden on load.
  const showPanel = !panelDismissed && math !== null && !math.matches

  // Reset dismiss when item changes
  useEffect(() => { setPanelDismissed(false); setEdited(new Set()) }, [item.id])

  const inputBase = 'h-8 border rounded text-sm tabular-nums transition-colors focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10'
  const editedCls = (field: string) => edited.has(field) ? 'border-blue bg-blue-soft' : 'border-line bg-paper'

  return (
    <div>
      {/* Mode toggle — the "Invoice math" label is provided by the Zone header. */}
      <div className="flex items-center justify-end mb-3">
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
              {/* Shipped-container unit — reflects the line's actual purchase unit
                  (was a dead hard-coded "cs" that mislabelled every per-case line). */}
              <span className="h-8 px-2.5 inline-flex items-center border border-line rounded bg-bg text-sm font-medium text-ink-3 whitespace-nowrap">
                {canonicalUom(item.rawUnit) || 'cs'}
              </span>
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
                onBlur={() => onChange({ totalQty: wQty || null, totalQtyUOM: weightUOM, rateUOM: weightUOM })}
                className={`flex-1 px-2 text-center ${inputBase} ${editedCls('wQty')}`}
              />
              {/* One weight unit drives both qty shipped AND the rate denominator. */}
              <select
                value={weightUOM}
                onChange={e => { setWeightUOM(e.target.value); onChange({ totalQtyUOM: e.target.value, rateUOM: e.target.value }) }}
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
                onBlur={() => onChange({ rate: rate || null, rateUOM: weightUOM })}
                className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm font-medium tabular-nums"
              />
              <span className="text-ink-4 text-[12.5px] shrink-0">/ {weightUOM}</span>
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

const CHIP_ORDER: FilterKey[] = ['needsLink', 'dimensionConflict', 'mathCheck', 'priceDelta', 'catchweight']
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
        const isDanger = k === 'needsLink' || k === 'dimensionConflict'
        const isWarn   = k === 'mathCheck'
        const ringCls  = isDanger ? 'bg-red' : isWarn ? 'bg-gold' : 'bg-blue'
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
