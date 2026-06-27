'use client'
// LineItemCard — the redesigned per-line review card (Invoice Drawer mock §2/§5).
// Matched lines render as a single collapsed row; attention lines expand into a
// link-row, stacked `.issue` blocks, the invoice-math block, and an optional
// inventory-cost comparison. Reads shared state from DrawerContext.

import { useRef, useState, useEffect } from 'react'
import { ChevronDown, ExternalLink, Ban, Undo2, Check, ArrowUp, ArrowDown, Boxes, Calculator, Scale, Building2, Split, Plus, X, type LucideIcon } from 'lucide-react'
import { rcHex } from '@/lib/rc-colors'
import { lineReceivedCountQty } from '@/lib/invoice/line-qty'
import type { RevenueCenter } from '@/contexts/RevenueCenterContext'
import { useDrawerContext } from './context'
import { LineNumberChip } from './atoms'
import {
  LinkPicker,
  CaseStructureEditor,
  InvoiceMathFields,
  type InventorySearchResult,
} from './composites'
import { DimensionConflictIssue, NewSkuIssue, PriceIssue, ConfIssue, SupplierSwitchNote } from './issues'
import {
  derivePricingMode, isCatchweight, hasDimensionConflict,
  hasMathCheck, isUnlinked, needsTrustCheck, hasUnknownUom,
} from '@/lib/invoice/predicates'
import { isBigPriceChange, lineUnresolved, hasInvalidRcSplit } from '@/lib/invoice/resolution'
import { isBridgeable } from '@/lib/invoice/classify'
import { formatPackSummary, formatRateLabel, formatCurrency } from '@/lib/invoice/formatters'
import { computeNormalisedPrices, computeDisplayVariance } from '@/lib/invoice/calculations'
import { priceDisplayScale } from '@/lib/utils'
import { formatPurchaseDisplay } from '@/lib/count-uom'
import type { ScanItem } from '@/components/invoices/types'

// ─── Zone ────────────────────────────────────────────────────────────────────
// One delineated band inside an expanded line: an icon-led label header + body.
// Solid top border + alternating tone make Pack structure / Invoice math /
// Inventory comparison read as distinct sections instead of one fused block.

type ZoneTone = 'paper' | 'bg' | 'gold'
function Zone({ icon: Icon, label, right, tone = 'paper', innerRef, children }: {
  icon: LucideIcon
  label: string
  right?: React.ReactNode
  tone?: ZoneTone
  innerRef?: React.Ref<HTMLDivElement>
  children: React.ReactNode
}) {
  const bg    = tone === 'bg' ? 'bg-bg' : tone === 'gold' ? 'bg-gold-soft/60' : 'bg-paper'
  const accent = tone === 'gold' ? 'text-gold-2' : 'text-ink-3'
  const iconC  = tone === 'gold' ? 'text-gold-2' : 'text-ink-4'
  return (
    <div ref={innerRef} className={`px-4 py-3 border-t border-line ${bg}`}>
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className={`flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] font-semibold ${accent}`}>
          <Icon size={12} className={iconC} />
          {label}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

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
  // Green "+ new item on approve" only when the user configured the item —
  // an unconfigured CREATE_NEW (legacy auto-match) renders as unlinked instead.
  const isCreateNew = item.action === 'CREATE_NEW' && !!item.newItemData

  const unlinked       = !isSkipped && isUnlinked(item)
  const dimConflict    = !isSkipped && hasDimensionConflict(item)
  const bridge         = !isSkipped && isBridgeable(item)
  const uomReview      = !isSkipped && hasUnknownUom(item)
  const mathCheck      = !isSkipped && hasMathCheck(item)
  const bigPrice       = !isSkipped && isBigPriceChange(item, { supplierId: ctx.sessionSupplierId, supplierName: ctx.sessionSupplierName })
  const trustCheck     = !isSkipped && needsTrustCheck(item)
  const badSplit       = !isSkipped && hasInvalidRcSplit(item)
  const isAttention    = unlinked || dimConflict || bridge || mathCheck || bigPrice || trustCheck || badSplit
  const isCatch        = isCatchweight(item)

  // RC split: the line's received quantity (count UOM) is the target the split
  // must sum to; the line total is what the money shares must reconcile to.
  const received = item.matchedItem
    ? lineReceivedCountQty(item as unknown as Parameters<typeof lineReceivedCountQty>[0], {
        dimension: item.matchedItem.dimension ?? 'COUNT',
        baseUnit:  item.matchedItem.baseUnit ?? 'each',
        packChain: item.matchedItem.packChain,
        pricing:   item.matchedItem.pricing,
        countUnit: item.matchedItem.countUnit ?? null,
      })
    : null
  const lineTotalNum = item.rawLineTotal != null ? Number(item.rawLineTotal) : 0
  const splitActive  = Array.isArray(item.rcSplit) && item.rcSplit.length > 0
  const canSplit     = !!item.matchedItem && !!received && received.qty > 0 && ctx.revenueCenters.length > 1

  // A line that surfaced an issue but whose decisions are all made now reads as
  // resolved — flips the card from amber attention to green acknowledgment.
  const resolved = isAttention && !lineUnresolved(item, {
    priceAck:      ctx.acknowledgedPriceLines.has(lineId),
    confAck:       ctx.acknowledgedConfLines.has(lineId),
  }, { supplierId: ctx.sessionSupplierId, supplierName: ctx.sessionSupplierName })

  // data-task for the footer's goToTask() targeting (highest-priority first).
  const dataTask = isSkipped ? undefined
    : unlinked       ? 'link'
    : mathCheck      ? 'math'
    : dimConflict    ? 'conflict'
    : bridge         ? 'bridge'
    : undefined

  const handleToggle = () => ctx.toggleExpand(lineId)
  const handleChangeLink = () => ctx.startLinkPicker(lineId)

  const handleSelectLink = (result: InventorySearchResult) => {
    ctx.updateLine(lineId, {
      matchedItemId: result.id,
      matchedItem: {
        id: result.id,
        itemName: result.itemName,
        purchasePrice: String(result.purchasePrice),
        pricePerBaseUnit: String(result.pricePerBaseUnit),
        baseUnit: result.baseUnit,
        // Carry the chain so pack display + format prefill + pricing mode derive from it.
        dimension: result.dimension,
        packChain: result.packChain,
        pricing: result.pricing,
        countUnit: result.countUnit,
      },
      action: 'UPDATE_PRICE',
      // A hand-picked link is no longer a fuzzy match — clear the MEDIUM-match
      // trust check so ConfIssue stops claiming "description similarity only".
      matchConfidence: 'HIGH',
      matchScore: 100,
    })
    ctx.closeLinkPicker()
  }

  const handleMathChange = (patch: Partial<ScanItem>) => ctx.updateLine(lineId, patch)
  const defaultRcId = ctx.sessionRcId ?? ctx.revenueCenters.find(r => r.isDefault)?.id ?? ''

  const total = item.rawLineTotal ? Number(item.rawLineTotal) : null
  const rate  = formatRateLabel(item)
  // Price movement vs. the linked inventory item — surfaced on the collapsed row
  // so a rising/falling cost is visible without expanding the line.
  const variance = item.matchedItem ? computeDisplayVariance(item) : null

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
        {uomReview && (
          <span title="A unit on this line isn't recognized — purchase qty falls back to the pack structure. Fix the unit for exactness."
            className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-gold-soft text-gold-2 shrink-0">
            UOM review
          </span>
        )}
        {variance && <VariancePill variance={variance} />}
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
      className={`shrink-0 bg-paper border rounded-lg overflow-hidden transition-shadow ${
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
          {uomReview && (
            <span title="A unit on this line isn't recognized — purchase qty falls back to the pack structure. Fix the unit for exactness."
              className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-gold-soft text-gold-2 self-center">
              UOM review
            </span>
          )}
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

      {/* mobile: jump to the invoice image with this line's row highlighted.
          md:hidden — the drawer's mobile tab bar exists below md; at md+ the
          image viewer is already side-by-side. */}
      {!isPicking && item.bbox != null && (
        <div className="md:hidden px-4 pt-2.5 flex">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); ctx.showLineOnImage(lineId) }}
            className="inline-flex items-center gap-1.5 self-start px-3 py-[7px] text-[12px] font-medium rounded-[7px] bg-paper text-ink-2 border border-line hover:border-ink-4 transition-colors"
          >
            View on invoice
          </button>
        </div>
      )}

      {/* issue blocks */}
      {!isPicking && (
        <>
          {unlinked && <NewSkuIssue item={item} lineId={lineId} />}
          {(dimConflict || bridge) && <DimensionConflictIssue item={item} lineId={lineId} onFixUom={() => mathRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />}
          {bigPrice && <PriceIssue item={item} lineId={lineId} onFixUom={() => mathRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />}
          {!bigPrice && <SupplierSwitchNote item={item} sessionSupplier={{ supplierId: ctx.sessionSupplierId, supplierName: ctx.sessionSupplierName }} />}
          {trustCheck && <ConfIssue item={item} lineId={lineId} />}
        </>
      )}

      {/* invoice math */}
      {!isPicking && (
        <>
          {pricingMode === 'per_case' && (
            <Zone icon={Boxes} label="Pack structure" tone="paper">
              <CaseStructureEditor item={item} onChange={patch => ctx.updateLine(lineId, patch)} />
            </Zone>
          )}

          <Zone icon={Calculator} label="Invoice math" tone="bg" innerRef={mathRef}>
            <InvoiceMathFields
              item={item}
              mode={pricingMode}
              onMode={m => ctx.updateLine(lineId, { pricingMode: m })}
              onChange={handleMathChange}
            />
          </Zone>

          {/* inventory cost comparison — hidden when the price issue already shows it */}
          {item.matchedItem && !isCreateNew && !bigPrice && (
            <InventoryComparisonCard item={item} />
          )}

          {/* Revenue center — the primary allocation decision, given a prominent
              gold band with colour-dot chips instead of a buried dropdown. */}
          <div
            className="px-4 py-3 border-t border-line bg-gold-soft/60"
            onClick={e => e.stopPropagation()}
            role="presentation"
          >
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] font-semibold text-gold-2">
                <Building2 size={12} className="text-gold-2" />
                Revenue center{splitActive ? ' · split' : ''}
              </div>
              <div className="flex items-center gap-1">
                {canSplit && (
                  <button
                    type="button"
                    onClick={() => ctx.updateLine(lineId, {
                      rcSplit: splitActive
                        ? null
                        : [{ rcId: item.revenueCenterId ?? defaultRcId, qty: received!.qty }],
                    })}
                    title={splitActive ? 'Use a single revenue center' : 'Split this quantity across revenue centers'}
                    className={`inline-flex items-center gap-1 font-mono text-[10.5px] px-2 py-[3px] rounded transition-colors ${
                      splitActive ? 'bg-white text-gold-2 border border-[#fcd34d]' : 'text-gold-2 hover:bg-white/60'
                    }`}
                  >
                    <Split size={11} /> {splitActive ? 'Single' : 'Split'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => ctx.updateLine(lineId, { action: 'SKIP' })}
                  title="Skip this line — won't affect COGS"
                  className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-4 hover:text-ink-2 hover:bg-white/60 px-2 py-[3px] rounded transition-colors"
                >
                  <Ban size={11} /> Skip
                </button>
              </div>
            </div>

            {splitActive && received ? (
              <RcSplitEditor
                rcSplit={item.rcSplit as Array<{ rcId: string; qty: number }>}
                received={received}
                lineTotal={lineTotalNum}
                revenueCenters={ctx.revenueCenters}
                onChange={split => ctx.updateLine(lineId, { rcSplit: split })}
              />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {ctx.revenueCenters.map(r => {
                  const sel = (item.revenueCenterId ?? defaultRcId) === r.id
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => ctx.setLineRc(lineId, r)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-medium border transition-colors ${
                        sel ? 'bg-white border-[#fcd34d] text-ink shadow-sm' : 'bg-white/40 border-transparent text-ink-3 hover:bg-white/70'
                      }`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(r.color) }} />
                      {r.name}{r.isDefault && <span className="text-ink-4 font-normal ml-0.5">· default</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}
    </article>
  )
}

// ─── RcSplitEditor ───────────────────────────────────────────────────────────
// Allocate a line's received quantity across multiple revenue centers, in the
// item's count UOM. Money per RC is derived proportionally from the line total;
// the footer enforces that the quantities sum to exactly what was received.

const SPLIT_TOL = (total: number) => Math.max(0.001, total * 0.005)

function RcSplitEditor({ rcSplit, received, lineTotal, revenueCenters, onChange }: {
  rcSplit: Array<{ rcId: string; qty: number }>
  received: { qty: number; countUom: string }
  lineTotal: number
  revenueCenters: RevenueCenter[]
  onChange: (split: Array<{ rcId: string; qty: number }>) => void
}) {
  // Local qty strings so decimals type cleanly; base values live in rcSplit.
  const [qtyStr, setQtyStr] = useState<Record<string, string>>(
    () => Object.fromEntries(rcSplit.map(e => [e.rcId, String(e.qty)])),
  )
  useEffect(() => {
    setQtyStr(prev => {
      const next: Record<string, string> = {}
      for (const e of rcSplit) next[e.rcId] = e.rcId in prev ? prev[e.rcId] : String(e.qty)
      return next
    })
  }, [rcSplit])

  const total   = received.qty
  const sum     = rcSplit.reduce((s, e) => s + (Number(e.qty) || 0), 0)
  const valid   = Math.abs(sum - total) <= SPLIT_TOL(total)
  const moneyOf = (q: number) => (total > 0 ? lineTotal * (q / total) : 0)
  const moneySum = moneyOf(sum)
  const rcOf = (id: string) => revenueCenters.find(r => r.id === id)
  const unused = revenueCenters.filter(r => !rcSplit.some(e => e.rcId === r.id))

  const setQty = (rcId: string, s: string) => {
    setQtyStr(p => ({ ...p, [rcId]: s }))
    onChange(rcSplit.map(e => (e.rcId === rcId ? { ...e, qty: parseFloat(s) || 0 } : e)))
  }
  const addRc    = () => { if (unused[0]) onChange([...rcSplit, { rcId: unused[0].id, qty: 0 }]) }
  const removeRc = (rcId: string) => onChange(rcSplit.filter(e => e.rcId !== rcId))

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {rcSplit.map(e => {
          const rc = rcOf(e.rcId)
          return (
            <div key={e.rcId} className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 min-w-0 flex-1 text-[12px] font-medium text-ink">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc?.color ?? 'gray') }} />
                <span className="truncate">{rc?.name ?? 'RC'}</span>
              </span>
              <div className="flex items-center">
                <input
                  type="number" step="any" min="0"
                  value={qtyStr[e.rcId] ?? ''}
                  onChange={ev => setQty(e.rcId, ev.target.value)}
                  className="w-20 text-right border border-line rounded-l-md px-2 py-1 text-[12px] tabular-nums bg-white focus:outline-none focus:ring-2 focus:ring-gold/40"
                />
                <span className="border border-line border-l-0 rounded-r-md px-1.5 py-1 text-[11px] text-ink-4 bg-bg">{received.countUom}</span>
              </div>
              <span className="font-mono text-[11.5px] text-ink-3 tabular-nums w-16 text-right">{formatCurrency(moneyOf(Number(e.qty) || 0))}</span>
              <button
                type="button"
                onClick={() => removeRc(e.rcId)}
                disabled={rcSplit.length <= 1}
                aria-label="Remove revenue center"
                className="w-6 h-6 grid place-items-center rounded text-ink-4 hover:text-red-text disabled:opacity-30"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {unused.length > 0 && (
        <button type="button" onClick={addRc} className="inline-flex items-center gap-1 text-[11px] font-medium text-gold-2 hover:text-gold">
          <Plus size={11} /> add revenue center
        </button>
      )}

      {/* reconciliation footer */}
      <div className={`flex items-center justify-between gap-2 mt-1 pt-2 border-t border-dashed text-[11.5px] font-mono tabular-nums ${valid ? 'border-line text-ink-3' : 'border-[#fecaca] text-red-text'}`}>
        <span className="inline-flex items-center gap-1.5">
          {valid ? <Check size={12} className="text-green-text" /> : <span className="text-red-text font-bold">!</span>}
          {sum.toLocaleString(undefined, { maximumFractionDigits: 2 })} / {total.toLocaleString(undefined, { maximumFractionDigits: 2 })} {received.countUom}
          {!valid && <span className="text-red-text">— must equal {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>}
        </span>
        <span className={valid ? 'text-ink-2' : 'text-red-text'}>
          {formatCurrency(moneySum)} / {formatCurrency(lineTotal)}
        </span>
      </div>
    </div>
  )
}

// ─── VariancePill ──────────────────────────────────────────────────────────────
// Compact up/down price-movement chip for the collapsed line row. Up (cost rose)
// reads red; down (cost fell) reads green — same colour convention as the
// expanded InventoryComparisonCard so the two never appear to disagree.

function VariancePill({ variance }: { variance: { percent: number; direction: 'up' | 'down' } }) {
  const up = variance.direction === 'up'
  return (
    <span
      title={`${up ? 'Up' : 'Down'} ${variance.percent.toFixed(1)}% vs current inventory cost`}
      className={`font-mono text-[10px] font-semibold tabular-nums shrink-0 inline-flex items-center gap-0.5 px-1.5 py-[2px] rounded-full ${
        up ? 'bg-red-soft text-red-text' : 'bg-green-soft text-green-text'
      }`}
    >
      {up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
      {variance.percent.toFixed(1)}%
    </span>
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
    const scale = priceDisplayScale(norm.baseUnit)
    const factor = scale.factor
    rateUnit  = scale.rateUnit
    prevLabel = `${formatCurrency(norm.inventoryPPB * factor)}/${rateUnit}`
    nextLabel = `${formatCurrency(norm.invoicePPB * factor)}/${rateUnit}`
    pct       = norm.pctDiff
  } else {
    const prev = item.previousPrice ? Number(item.previousPrice) : null
    const next = item.rawUnitPrice  ? Number(item.rawUnitPrice)  : null
    const bu   = item.matchedItem ? formatPurchaseDisplay(item.matchedItem) : 'case'
    if (prev !== null) prevLabel = `${formatCurrency(prev)}/${bu}`
    if (next !== null) {
      nextLabel = `${formatCurrency(next)}/${bu}`
      if (prev !== null && prev > 0) pct = Math.round(((next - prev) / prev) * 10000) / 100
    }
  }

  const ctx = useDrawerContext()
  const isBad = pct !== null && pct > 0

  return (
    <Zone
      icon={Scale}
      label="Inventory comparison"
      tone="paper"
      right={item.matchedItem?.id && (
        <button
          type="button"
          onClick={() => ctx.openInventoryEdit(item.matchedItem!.id)}
          className="inline-flex items-center gap-1 font-mono text-[10.5px] text-gold hover:text-gold-2 font-semibold border-b border-dashed border-gold/70"
        >
          Edit <ExternalLink size={11} />
        </button>
      )}
    >
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
    </Zone>
  )
}

