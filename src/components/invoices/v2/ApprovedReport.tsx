'use client'
// ─── ApprovedReport ────────────────────────────────────────────────────────────
// Read-only report for APPROVED / REJECTED sessions. This is the permanent record
// of what an invoice actually did: what was ordered, what was received, at what
// pack format and rate, where the stock landed, and what it changed downstream.
//
// It reads only fields already captured by OCR + approve (InvoiceScanItem /
// InvoiceSession) — nothing here is computed and stored. Stock effect derives
// from the same lineReceivedCountQty() the approve route and the RC split editor
// use, so the report can never disagree with what receiving actually credited.

import { useState } from 'react'
import {
  X, Check, ChevronUp, ChevronDown, TrendingUp, TrendingDown,
  BookOpen, RotateCcw, Loader2, ArrowRight,
} from 'lucide-react'
import type { Session, ScanItem } from '@/components/invoices/types'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { formatCurrency } from '@/lib/invoice/formatters'
import { derivePricingMode, isCatchweight } from '@/lib/invoice/predicates'
import { computeCostPerUOM, reconcileInvoiceTotals } from '@/lib/invoice/calculations'
import { lineReceivedCountQty } from '@/lib/invoice/line-qty'

// ── small helpers ─────────────────────────────────────────────────────────────

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Trim trailing zeros: 4 → "4", 40.02 → "40.02", 3.500 → "3.5" */
const qty = (v: number, dp = 2): string =>
  v === Math.floor(v) ? String(v) : String(Number(v.toFixed(dp)))

const money4 = (v: number): string =>
  v >= 0.1 ? formatCurrency(v) : `$${v.toFixed(4)}`

const shortDate = (d: string | null | undefined): string | null => {
  if (!d) return null
  const parsed = new Date(d)
  if (Number.isNaN(parsed.getTime())) return d   // OCR strings may be free-form
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** approvedBy stores the account email; the local part is enough to identify who. */
const personName = (v: string | null | undefined): string | null =>
  v ? (v.includes('@') ? v.split('@')[0] : v) : null

/** The billed container unit for a line — "cs" unless the invoice named one. */
const orderUnit = (item: ScanItem): string => item.rawUnit?.trim() || 'cs'

/** "4 × 5 kg per cs" / "12 ea per cs" — the purchase format, or null. */
function packFormat(item: ScanItem): string | null {
  const pq   = num(item.invoicePackQty)
  const ps   = num(item.invoicePackSize)
  const uom  = item.invoicePackUOM
  if (pq && ps && uom) return `${qty(pq)} × ${qty(ps)} ${uom} per ${orderUnit(item)}`
  if (pq && uom)       return `${qty(pq)} ${uom} per ${orderUnit(item)}`
  return null
}

/** The unit the linked item is priced in — the last honest fallback when OCR
 *  captured no unit for a weight. Guessing "lb" here printed "41.02 lb" next to a
 *  receipt of 41.02 kg on the same row. */
function pricedRateUnit(item: ScanItem): string | null {
  const p = item.matchedItem?.pricing as { mode?: string; rateUnit?: string } | undefined
  return p?.mode === 'RATE' && p.rateUnit ? p.rateUnit : null
}

/** The unit a weight-billed line is denominated in. Mirrors the resolution order
 *  in lineReceivedBaseUnits so the row's quantity and its receipt always agree. */
function weightUnit(item: ScanItem): string {
  return item.qtyOrderedUOM ?? item.totalQtyUOM ?? item.rateUOM ?? pricedRateUnit(item) ?? 'lb'
}

/** What was actually billed by weight on a per-weight line. */
function billedWeight(item: ScanItem): { qty: number; uom: string } | null {
  if (derivePricingMode(item) !== 'per_weight') return null
  const q = num(item.qtyOrdered) ?? num(item.totalQty)
  if (q === null) return null
  return { qty: q, uom: weightUnit(item) }
}

/** "$18.79/lb" or "$55.13/cs" — the per-unit price as the invoice charged it. */
function unitPriceLabel(item: ScanItem): string | null {
  if (derivePricingMode(item) === 'per_weight') {
    const rate = num(item.rate)
    if (rate !== null) return `${formatCurrency(rate)}/${item.rateUOM ?? pricedRateUnit(item) ?? 'lb'}`
  }
  const up = num(item.rawUnitPrice)
  return up !== null ? `${formatCurrency(up)}/${orderUnit(item)}` : null
}

/** Received quantity in the matched item's count UOM — what receiving credited.
 *  Returns qty 0 (rather than null) when the line credited nothing, so the report
 *  can say so out loud: a line with no billed quantity is invisible to theoretical
 *  stock, and that gap is exactly what an approved-invoice report should surface. */
function stockEffect(item: ScanItem): { qty: number; countUom: string } | null {
  if (!item.matchedItem || item.action === 'SKIP') return null
  const m = item.matchedItem
  try {
    return lineReceivedCountQty(item, {
      dimension: m.dimension ?? 'COUNT',
      baseUnit:  m.baseUnit ?? 'each',
      packChain: m.packChain,
      pricing:   m.pricing,
      countUnit: m.countUnit ?? null,
    })
  } catch {
    return null
  }
}

// ── layout atoms ──────────────────────────────────────────────────────────────

function SectionHeader({
  label, count, open, onToggle, right,
}: {
  label: string
  count?: number
  open?: boolean
  onToggle?: () => void
  right?: React.ReactNode
}) {
  const title = (
    <p className="text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
      {label}{count !== undefined ? ` (${count})` : ''}
    </p>
  )
  if (!onToggle) {
    return <div className="flex items-center justify-between mb-2">{title}{right}</div>
  }
  return (
    <div className="flex items-center justify-between mb-2">
      <button type="button" onClick={onToggle} className="flex items-center gap-1.5 group">
        {title}
        {open
          ? <ChevronUp   size={14} className="text-ink-4 group-hover:text-ink-3" />
          : <ChevronDown size={14} className="text-ink-4 group-hover:text-ink-3" />}
      </button>
      {right}
    </div>
  )
}

/** One label/value row in the money breakdown. */
function ChargeRow({ label, value, tone = 'normal' }: {
  label: string
  value: number
  tone?: 'normal' | 'muted' | 'credit' | 'total'
}) {
  return (
    <div className={`flex items-center justify-between px-4 py-[7px] ${tone === 'total' ? 'bg-bg' : ''}`}>
      <span className={`text-[12px] ${tone === 'total' ? 'font-semibold text-ink' : 'text-ink-3'}`}>{label}</span>
      <span className={`font-mono text-[12px] tabular-nums ${
        tone === 'total'  ? 'font-semibold text-ink' :
        tone === 'credit' ? 'text-green-text' :
        tone === 'muted'  ? 'text-ink-4' : 'text-ink-2'
      }`}>
        {tone === 'credit' ? `−${formatCurrency(Math.abs(value))}` : formatCurrency(value)}
      </span>
    </div>
  )
}

/** Definition row inside an expanded line's detail grid. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 items-baseline py-[3px]">
      <span className="text-[11px] text-ink-4">{label}</span>
      <span className="text-[11.5px] text-ink-2 min-w-0">{children}</span>
    </div>
  )
}

// ── line row ──────────────────────────────────────────────────────────────────

function LineRow({
  item, n, rcName, rcNameFor,
}: {
  item: ScanItem
  n: number
  /** RC this line's stock landed in (line override → session default). */
  rcName: string | null
  rcNameFor: (id: string) => string
}) {
  const [open, setOpen] = useState(false)

  const isSkip   = item.action === 'SKIP'
  const isNew    = item.isNewItem && item.approved
  const isUpdate = item.action === 'UPDATE_PRICE' && item.approved
  const mode     = derivePricingMode(item)
  const catch_   = isCatchweight(item)

  const orderedQty = num(item.rawQty)
  const weight     = billedWeight(item)
  const total      = num(item.rawLineTotal)
  const unitPrice  = unitPriceLabel(item)
  const pack       = packFormat(item)
  const stock      = stockEffect(item)
  const costPer    = computeCostPerUOM(item)
  const prevPrice  = num(item.previousPrice)
  const newPrice   = num(item.newPrice)
  const diffPct    = num(item.priceDiffPct)
  const nominal    = num(item.nominalWeight)
  const lineTax    = num(item.lineTaxAmount)
  const split      = Array.isArray(item.rcSplit) && item.rcSplit.length > 0 ? item.rcSplit : null

  const name = item.matchedItem?.itemName ?? item.rawDescription

  return (
    <div className={isSkip ? 'opacity-50' : ''}>
      {/* ── row head ── */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full text-left grid grid-cols-[20px_minmax(0,1fr)_auto] sm:grid-cols-[20px_minmax(0,1fr)_58px_78px_74px] gap-2 px-3 py-2.5 items-start hover:bg-bg/60 transition-colors"
      >
        {/* n + status dot */}
        <div className="pt-[1px]">
          <span className={`inline-flex w-[19px] h-[19px] rounded-md items-center justify-center font-mono text-[9.5px] font-semibold ${
            isNew    ? 'bg-green-soft text-green-text' :
            isUpdate ? 'bg-blue-soft text-blue-text'   :
            isSkip   ? 'bg-bg-2 text-ink-4'            : 'bg-bg text-ink-4'
          }`}>
            {n}
          </span>
        </div>

        {/* item + provenance */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-medium text-ink-2 leading-tight">{name}</span>
            {isNew && <span className="text-[9.5px] font-semibold px-1.5 py-[1px] rounded bg-green-soft text-green-text">NEW ITEM</span>}
            {isSkip && <span className="text-[9.5px] font-semibold px-1.5 py-[1px] rounded bg-bg-2 text-ink-4">NOT APPLIED</span>}
            {catch_ && <span className="text-[9.5px] font-semibold px-1.5 py-[1px] rounded bg-blue-soft text-blue-text">CATCHWEIGHT</span>}
          </div>

          {/* invoice-side facts: code · pack format */}
          <div className="font-mono text-[10.5px] text-ink-4 mt-[3px] flex items-center gap-1.5 flex-wrap">
            {item.supplierItemCode && <span>#{item.supplierItemCode}</span>}
            {item.supplierItemCode && pack && <span className="text-line-2">·</span>}
            {pack && <span>{pack}</span>}
            {!item.supplierItemCode && !pack && item.matchedItem && (
              <span className="truncate">{item.rawDescription}</span>
            )}
          </div>

          {/* Narrow screens have no room for the qty / unit-price columns, so the
              same two facts fold into the item block as one inline line. */}
          <div className="sm:hidden font-mono text-[10.5px] text-ink-3 tabular-nums mt-[3px] flex items-center gap-1.5 flex-wrap">
            <span>
              {orderedQty !== null
                ? `${qty(orderedQty)} ${orderUnit(item)}`
                : weight ? `${qty(weight.qty)} ${weight.uom}` : '—'}
            </span>
            {weight && orderedQty !== null && <span className="text-ink-4">({qty(weight.qty)} {weight.uom})</span>}
            {unitPrice && <><span className="text-line-2">·</span><span>{unitPrice}</span></>}
            {diffPct !== null && Math.abs(diffPct) >= 0.1 && (
              <span className={`font-semibold ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
                {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
              </span>
            )}
          </div>

          {/* stock-side facts: what receiving credited, and where */}
          {stock && (
            <div className="text-[10.5px] text-ink-3 mt-[3px] flex items-center gap-1">
              <ArrowRight size={10} className="text-ink-4 shrink-0" />
              {stock.qty > 0 ? (
                <>
                  <span className="font-mono">{qty(stock.qty)} {stock.countUom}</span>
                  <span className="text-ink-4">into stock</span>
                </>
              ) : (
                <span className="text-gold">nothing credited to stock — no billed quantity</span>
              )}
              {stock.qty > 0 && (split
                ? <span className="text-ink-4">· split {split.length} ways</span>
                : rcName && <span className="text-ink-4">· {rcName}</span>)}
            </div>
          )}
        </div>

        {/* purchased — containers billed, with the weight actually shipped beneath.
            Weight-priced lines often carry no container count at all; there the
            shipped weight IS the quantity, so it takes the primary slot. */}
        <div className="hidden sm:block text-right font-mono text-[11.5px] text-ink-3 tabular-nums pt-[1px]">
          {orderedQty !== null
            ? `${qty(orderedQty)} ${orderUnit(item)}`
            : weight ? `${qty(weight.qty)} ${weight.uom}` : '—'}
          {weight && orderedQty !== null && (
            <div className="text-[10px] text-ink-4 mt-[2px]">{qty(weight.qty)} {weight.uom}</div>
          )}
        </div>

        {/* unit price */}
        <div className="hidden sm:block text-right font-mono text-[11.5px] text-ink-3 tabular-nums pt-[1px]">
          {unitPrice ?? '—'}
          {diffPct !== null && Math.abs(diffPct) >= 0.1 && (
            <div className={`text-[10px] font-semibold mt-[2px] ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
              {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
            </div>
          )}
        </div>

        {/* total */}
        <div className="text-right font-mono text-[12.5px] font-semibold text-ink tabular-nums pt-[1px]">
          {total !== null ? formatCurrency(total) : '—'}
          <div className="flex items-center justify-end mt-[2px]">
            <ChevronDown size={11} className={`text-ink-4 transition-transform ${open ? 'rotate-180' : ''}`} />
          </div>
        </div>
      </button>

      {/* ── expanded detail ── */}
      {open && (
        <div className="px-3 pb-3 pl-[35px]">
          <div className="rounded-lg bg-bg border border-bg-2 px-3.5 py-2.5">

            <p className="text-[10px] font-semibold text-ink-4 uppercase tracking-wider mb-1">As invoiced</p>
            <DetailRow label="Description">
              <span className="font-mono text-[11px]">{item.rawDescription || '—'}</span>
            </DetailRow>
            {item.supplierItemCode && (
              <DetailRow label="Supplier code"><span className="font-mono text-[11px]">{item.supplierItemCode}</span></DetailRow>
            )}
            {item.lineCategory && <DetailRow label="Invoice section">{item.lineCategory}</DetailRow>}
            <DetailRow label="Qty purchased">
              {orderedQty !== null ? `${qty(orderedQty)} ${orderUnit(item)}` : '—'}
              {pack && <span className="text-ink-4"> · {pack}</span>}
            </DetailRow>
            {nominal !== null && (
              <DetailRow label="Nominal weight">
                <span className="font-mono">{qty(nominal)} {item.rateUOM ?? item.invoicePackUOM ?? ''}</span>
                <span className="text-ink-4"> (pack qty × pack size)</span>
              </DetailRow>
            )}
            {weight && (
              <DetailRow label="Qty shipped">
                <span className="font-mono">{qty(weight.qty)} {weight.uom}</span>
                {catch_ && nominal !== null && (
                  <span className={`ml-1.5 text-[10.5px] font-semibold ${weight.qty >= nominal ? 'text-ink-3' : 'text-gold'}`}>
                    {weight.qty >= nominal ? '+' : ''}{qty(weight.qty - nominal)} vs nominal
                  </span>
                )}
              </DetailRow>
            )}
            <DetailRow label={mode === 'per_weight' ? 'Rate' : 'Unit price'}>
              <span className="font-mono">{unitPrice ?? '—'}</span>
              <span className="text-ink-4"> · priced {mode === 'per_weight' ? 'by weight' : 'by case'}</span>
            </DetailRow>
            {costPer && (
              <DetailRow label="Cost per unit">
                <span className="font-mono">{money4(costPer.value)}/{costPer.uom}</span>
              </DetailRow>
            )}
            <DetailRow label="Line total">
              <span className="font-mono font-semibold text-ink">{total !== null ? formatCurrency(total) : '—'}</span>
              {item.taxFlag && <span className="text-ink-4"> · tax code {item.taxFlag}</span>}
              {lineTax !== null && lineTax > 0 && <span className="text-ink-4"> · tax {formatCurrency(lineTax)}</span>}
            </DetailRow>

            {!isSkip && (
              <>
                <div className="h-px bg-bg-2 my-2" />
                <p className="text-[10px] font-semibold text-ink-4 uppercase tracking-wider mb-1">What it did</p>

                <DetailRow label="Linked item">
                  {item.matchedItem
                    ? <>{item.matchedItem.itemName}
                        <span className="text-ink-4"> · {item.matchConfidence.toLowerCase()} match{item.matchScore ? ` (${item.matchScore})` : ''}</span>
                      </>
                    : <span className="text-ink-4">not linked</span>}
                </DetailRow>

                {stock && (
                  <DetailRow label="Received">
                    {stock.qty > 0
                      ? <>
                          <span className="font-mono">{qty(stock.qty)} {stock.countUom}</span>
                          <span className="text-ink-4"> credited to stock</span>
                        </>
                      : <span className="text-gold">nothing credited — the line carries no billed quantity</span>}
                  </DetailRow>
                )}

                {(split || rcName) && (
                  <DetailRow label="Revenue centre">
                    {split
                      ? (
                        <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                          {split.map(s => (
                            <span key={s.rcId} className="font-mono text-[11px]">
                              {rcNameFor(s.rcId)} {qty(Number(s.qty))}
                            </span>
                          ))}
                        </span>
                      )
                      : rcName}
                  </DetailRow>
                )}

                {prevPrice !== null && newPrice !== null && (
                  <DetailRow label="Price applied">
                    <span className="font-mono text-ink-4 line-through">{formatCurrency(prevPrice)}</span>
                    <span className="font-mono text-ink-2"> → {formatCurrency(newPrice)}</span>
                    {diffPct !== null && (
                      <span className={`ml-1.5 text-[10.5px] font-semibold ${diffPct > 0 ? 'text-red' : 'text-green-text'}`}>
                        {diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%
                      </span>
                    )}
                  </DetailRow>
                )}

                <DetailRow label="Action">
                  {isNew    ? 'created a new inventory item'
                  : isUpdate ? 'updated the item price'
                  : item.action === 'ADD_SUPPLIER' ? 'recorded a supplier offer'
                  : 'recorded as purchased'}
                </DetailRow>
              </>
            )}

            {item.ocrNotes && (
              <>
                <div className="h-px bg-bg-2 my-2" />
                <DetailRow label="Scan note">
                  <span className="text-ink-3">{item.ocrNotes}</span>
                  {item.ocrConfidence && <span className="text-ink-4"> · {item.ocrConfidence} confidence</span>}
                </DetailRow>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── ApprovedView ──────────────────────────────────────────────────────────────

export function ApprovedView({
  session,
  revenueCenters,
  onClose,
  onReviewAgain,
}: {
  session: Session
  revenueCenters: RevenueCenter[]
  onClose: () => void
  onReviewAgain: () => void
}) {
  const [chargesOpen,     setChargesOpen]     = useState(true)
  const [priceAlertsOpen, setPriceAlertsOpen] = useState(true)
  const [recipeAlertsOpen, setRecipeAlertsOpen] = useState(true)
  const [reverting,       setReverting]       = useState(false)

  const rejected = session.status === 'REJECTED'
  const total    = num(session.total)
  const subtotal = num(session.subtotal)
  const tax      = num(session.tax)

  const activeItems  = session.scanItems.filter(i => i.action !== 'SKIP')
  const updatedItems = session.scanItems.filter(i => i.action === 'UPDATE_PRICE' && i.approved)
  const newItems     = session.scanItems.filter(i => i.isNewItem && i.approved)

  // Goods = what the food itself cost, separate from freight/fees/tax in the
  // invoice total. Deliberately NOT a unit count: lines are billed in cases,
  // pounds and litres on the same invoice, so a summed quantity would be a lie.
  const goodsTotal = activeItems.reduce((s, i) => s + (num(i.rawLineTotal) ?? 0), 0)
  const reconcile  = reconcileInvoiceTotals(session.scanItems, subtotal)

  const rcNameFor = (id: string) => revenueCenters.find(r => r.id === id)?.name ?? 'Unknown RC'
  const sessionRcName = session.revenueCenterId ? rcNameFor(session.revenueCenterId) : null

  const metaParts: string[] = []
  if (session.invoiceNumber) metaParts.push(`#${session.invoiceNumber}`)
  if (session.invoiceDate)   metaParts.push(session.invoiceDate)
  if (session.poNumber)      metaParts.push(`PO ${session.poNumber}`)
  metaParts.push(`${activeItems.length} line${activeItems.length !== 1 ? 's' : ''}`)

  const approvedAt   = shortDate(session.approvedAt)
  const purchaseDate = shortDate(session.purchaseDate)

  // Charge rows — only the ones the invoice actually carried.
  const charges: Array<{ label: string; value: number; tone?: 'credit' | 'muted' }> = []
  const push = (label: string, v: number | null, tone?: 'credit' | 'muted') => {
    if (v !== null && v !== 0) charges.push({ label, value: v, tone })
  }
  push('Discount', num(session.discount), 'credit')
  push('Freight', num(session.freight))
  push('Fuel surcharge', num(session.fuelSurcharge))
  push('Minimum order fee', num(session.minimumOrderFee))
  for (const c of session.otherCharges ?? []) {
    if (c && Number.isFinite(Number(c.amount))) charges.push({ label: c.label || 'Other charge', value: Number(c.amount) })
  }
  const taxRows: Array<{ label: string; value: number }> = []
  const pushTax = (label: string, v: number | null) => { if (v !== null && v !== 0) taxRows.push({ label, value: v }) }
  pushTax('GST', num(session.gst))
  pushTax('PST', num(session.pst))
  pushTax('HST', num(session.hst))
  // Fall back to the legacy aggregate when the split taxes weren't captured.
  if (taxRows.length === 0 && tax !== null && tax !== 0) taxRows.push({ label: 'Tax', value: tax })

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
                rejected ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'
              }`}>
                {rejected ? <X size={10} /> : <Check size={10} />}
                {rejected ? 'Rejected' : 'Applied'}
              </div>
              {sessionRcName && (
                <span className="text-[10.5px] font-medium px-2 py-[2px] rounded-full bg-bg text-ink-3 border border-bg-2">
                  {sessionRcName}
                </span>
              )}
            </div>
            <h2 className="text-[19px] font-semibold text-ink leading-[1.2] truncate">
              {session.supplierName ?? 'Unknown supplier'}
            </h2>
            <p className="text-[12.5px] text-ink-4 mt-[3px]">{metaParts.join(' · ')}</p>
            {!rejected && (approvedAt || purchaseDate || session.approvedBy) && (
              <p className="text-[11px] text-ink-4 mt-[3px]">
                {[
                  session.approvedBy ? `Approved by ${personName(session.approvedBy)}` : approvedAt ? 'Approved' : null,
                  approvedAt,
                  purchaseDate ? `counts to ${purchaseDate}` : null,
                ].filter(Boolean).join(' · ')}
              </p>
            )}
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
            {[
              { v: formatCurrency(goodsTotal),         l: 'goods received', sm: true },
              { v: `${updatedItems.length}`,           l: 'prices updated' },
              { v: `${newItems.length}`,               l: 'new items' },
              { v: `${session.priceAlerts.length + session.recipeAlerts.length}`, l: 'alerts raised' },
            ].map(c => (
              <div key={c.l} className="bg-bg border border-bg-2 rounded-xl p-3 text-center">
                <div className={`font-semibold text-ink tabular-nums leading-none ${c.sm ? 'text-[15px] py-[3px]' : 'text-[22px]'}`}>{c.v}</div>
                <div className="text-[11px] text-ink-4 mt-1">{c.l}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Line items ── */}
        <div className="px-[18px] pt-[16px]">
          <SectionHeader
            label="Line items"
            count={session.scanItems.length}
            right={<span className="text-[10.5px] text-ink-4">tap a line for full detail</span>}
          />

          <div className="border border-bg-2 rounded-xl overflow-hidden">
            {/* column header */}
            <div className="hidden sm:grid grid-cols-[20px_minmax(0,1fr)_58px_78px_74px] gap-2 px-3 py-1.5 bg-bg border-b border-bg-2 text-[9.5px] font-semibold text-ink-4 uppercase tracking-wider">
              <div />
              <div>Item</div>
              <div className="text-right">Qty</div>
              <div className="text-right">Unit price</div>
              <div className="text-right">Total</div>
            </div>

            <div className="divide-y divide-bg-2">
              {session.scanItems.map((item, i) => (
                <LineRow
                  key={item.id}
                  item={item}
                  n={i + 1}
                  rcName={item.revenueCenterId ? rcNameFor(item.revenueCenterId) : sessionRcName}
                  rcNameFor={rcNameFor}
                />
              ))}
            </div>

            {/* goods total + reconciliation against the OCR'd subtotal */}
            <div className="border-t border-bg-2 bg-bg px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-ink-4">
                {activeItems.length} line{activeItems.length !== 1 ? 's' : ''} applied
                {reconcile.status === 'mismatch' && (
                  <span className="text-gold"> · {formatCurrency(Math.abs(reconcile.delta))} off the invoice subtotal</span>
                )}
              </span>
              <span className="font-mono text-[12.5px] font-semibold text-ink tabular-nums">
                {formatCurrency(goodsTotal)}
              </span>
            </div>
          </div>
        </div>

        {/* ── Charges & taxes ── */}
        {(charges.length > 0 || taxRows.length > 0 || subtotal !== null) && (
          <div className="px-[18px] pt-[16px]">
            <SectionHeader label="Charges & taxes" open={chargesOpen} onToggle={() => setChargesOpen(v => !v)} />
            {chargesOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {subtotal !== null && <ChargeRow label="Goods subtotal" value={subtotal} />}
                {charges.map((c, i) => <ChargeRow key={`${c.label}-${i}`} label={c.label} value={c.value} tone={c.tone} />)}
                {taxRows.map((t, i) => <ChargeRow key={`${t.label}-${i}`} label={t.label} value={t.value} tone="muted" />)}
                {total !== null && <ChargeRow label="Invoice total" value={total} tone="total" />}
              </div>
            )}
          </div>
        )}

        {/* ── Price alerts ── */}
        {session.priceAlerts.length > 0 && (
          <div className="px-[18px] pt-[16px]">
            <SectionHeader
              label="Price alerts"
              count={session.priceAlerts.length}
              open={priceAlertsOpen}
              onToggle={() => setPriceAlertsOpen(v => !v)}
            />
            {priceAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.priceAlerts.map(alert => {
                  const prev = Number(alert.previousPrice)
                  const next = Number(alert.newPrice)
                  const pct  = Number(alert.changePct)
                  const up   = alert.direction === 'UP'
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-red-soft' : 'bg-green-soft'}`}>
                        {up
                          ? <TrendingUp   size={13} className="text-red" />
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
            <SectionHeader
              label="Recipe impacts"
              count={session.recipeAlerts.length}
              open={recipeAlertsOpen}
              onToggle={() => setRecipeAlertsOpen(v => !v)}
            />
            {recipeAlertsOpen && (
              <div className="border border-bg-2 rounded-xl overflow-hidden divide-y divide-bg-2">
                {session.recipeAlerts.map(alert => {
                  const prevCost = Number(alert.previousCost)
                  const newCost  = Number(alert.newCost)
                  const pct      = Number(alert.changePct)
                  const foodCost = alert.newFoodCostPct != null ? Number(alert.newFoodCostPct) : null
                  const up       = pct > 0
                  return (
                    <div key={alert.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${up ? 'bg-gold-soft' : 'bg-green-soft'}`}>
                        <BookOpen size={13} className={up ? 'text-gold' : 'text-green-text'} />
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
                          <span className={`text-[11px] font-semibold ${up ? 'text-gold' : 'text-green-text'}`}>
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
            {reverting ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
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
