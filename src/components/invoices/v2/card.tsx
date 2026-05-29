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
