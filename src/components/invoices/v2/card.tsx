'use client'
// Phase 4 — LineItemCard: the full per-line review card.
// Reads shared state from DrawerContext; owns only local animation state.

import { useState } from 'react'
import { AlertTriangle, ChevronDown, ExternalLink, Ban, Undo2 } from 'lucide-react'
import { useDrawerContext } from './context'
import { ModeIcon, Pill, VariancePill } from './atoms'
import {
  LineAmounts,
  LinkInfoRow,
  LinkPicker,
  CaseStructureEditor,
  InvoiceMathFields,
  type InventorySearchResult,
} from './composites'
import {
  derivePricingMode,
  isCatchweight,
  hasModeMismatch,
  hasFormatMismatch,
  hasMathCheck,
  isUnlinked,
  pickAccent,
} from '@/lib/invoice/predicates'
import { formatPackSummary, formatRateLabel, formatCurrency } from '@/lib/invoice/formatters'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import type { ScanItem } from '@/components/invoices/types'

// ─── Accent helpers ────────────────────────────────────────────────────────────

const ACCENT_STRIPE: Record<string, string> = {
  danger:  'bg-red-400',
  warn:    'bg-amber-400',
  info:    'bg-blue-400',
  success: 'bg-green-400',
}

const ACCENT_BORDER: Record<string, string> = {
  danger:  'border-red-200',
  warn:    'border-amber-200',
  info:    'border-blue-200',
  success: 'border-green-200',
}

// ─── LineItemCard ──────────────────────────────────────────────────────────────

export function LineItemCard({ lineId }: { lineId: string }) {
  const ctx = useDrawerContext()
  const item = ctx.getEffectiveLine(lineId)

  const pricingMode  = derivePricingMode(item)
  const isOpen       = ctx.expandedLineIds.has(lineId)
  const isFlashing   = ctx.flashingLineIds.has(lineId)
  const isPicking    = ctx.pickingLinkForId === lineId
  const listHasOpen  = ctx.expandedLineIds.size > 0
  const rc           = ctx.getItemRc(lineId)
  const accent       = pickAccent(item)
  const isSkipped    = item.action === 'SKIP'

  const states = {
    isUnlinked:       !isSkipped && isUnlinked(item),
    hasModeMismatch:  !isSkipped && hasModeMismatch(item),
    hasFormatMismatch:!isSkipped && hasFormatMismatch(item),
    isCatchweight:    isCatchweight(item),
    hasMathCheck:     !isSkipped && hasMathCheck(item),
  }

  const handleSkip = () => {
    ctx.updateLine(lineId, { action: 'SKIP' })
  }
  const handleUnskip = () => {
    const restored = item.matchedItemId ? 'UPDATE_PRICE' : 'PENDING'
    ctx.updateLine(lineId, { action: restored })
  }

  // data-task for goToTask() footer targeting — highest priority outstanding issue
  // Skipped items are intentionally excluded from tasks
  const dataTask = isSkipped ? undefined
    : states.isUnlinked    ? 'link'
    : states.hasMathCheck  ? 'math'
    : states.hasModeMismatch || states.hasFormatMismatch ? 'mismatch'
    : undefined

  const stripeCls  = isSkipped ? 'bg-stone-300' : (accent ? ACCENT_STRIPE[accent] : 'bg-stone-200')
  const borderCls  = isSkipped ? 'border-stone-200' : (accent ? ACCENT_BORDER[accent] : 'border-stone-200')

  // When another card is open, non-open cards recede to 85% opacity
  const opacityCls = listHasOpen && !isOpen ? 'opacity-[0.85] hover:opacity-100' : ''

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
        priceType: 'CASE',  // default; mode toggle corrects this
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

  return (
    <article
      data-line-id={lineId}
      data-task={dataTask}
      className={`
        flex rounded-lg border bg-white mb-[5px] overflow-hidden
        transition-[opacity,box-shadow] duration-200
        ${borderCls} ${isSkipped ? 'opacity-50 hover:opacity-75' : opacityCls}
        ${isOpen ? 'shadow-md' : ''}
        ${isFlashing ? 'animate-flash-highlight' : ''}
      `}
    >
      {/* Left accent stripe */}
      <div className={`w-[3px] shrink-0 ${stripeCls}`} />

      {/* Card body */}
      <div className="flex-1 min-w-0">

        {/* ── Clickable summary (collapsed + expanded header) ─────────────── */}
        <div
          role="button"
          tabIndex={0}
          onClick={handleToggle}
          onKeyDown={e => e.key === 'Enter' || e.key === ' ' ? handleToggle() : undefined}
          className="px-[14px] pt-[12px] pb-[10px] cursor-pointer select-none"
        >
          {/* Line top: icon + title + amounts + chevron */}
          <div className="flex items-start gap-[10px]">
            <ModeIcon mode={pricingMode} />

            {/* Title block */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-baseline gap-[5px] mb-[3px]">
                <h3 className="text-[14px] font-semibold text-stone-900 leading-[1.25] truncate">
                  {item.rawDescription || '(no description)'}
                </h3>
                {states.isUnlinked                                    && <Pill variant="danger">needs link</Pill>}
                {states.hasModeMismatch                               && <Pill variant="warn">mode mismatch</Pill>}
                {states.hasFormatMismatch && !states.hasModeMismatch  && <Pill variant="neutral">format mismatch</Pill>}
                {states.hasMathCheck                                  && <Pill variant="warn">math check</Pill>}
                {item.ocrConfidence === 'low' && !isSkipped && (
                  <span
                    title={item.ocrNotes ?? 'OCR uncertain — double-check the values below'}
                    className="inline-flex items-center gap-[3px] px-[6px] py-[1px] rounded-full text-[10px] font-medium bg-orange-100 text-orange-700 border border-orange-200 cursor-help"
                  >
                    <AlertTriangle size={9} />
                    low confidence
                  </span>
                )}
              </div>

              {/* Subtitle: code · pack summary */}
              <div className="flex flex-wrap items-center gap-[5px] text-[11.5px] text-stone-400 leading-[1.4]">
                {item.supplierItemCode && (
                  <>
                    <code className="font-mono text-[10.5px] bg-stone-100 px-[5px] py-[1px] rounded text-stone-500">
                      #{item.supplierItemCode}
                    </code>
                    <span>·</span>
                  </>
                )}
                <span>{formatPackSummary(item)}</span>
                {/* Catchweight: show received weight inline */}
                {states.isCatchweight && item.qtyOrdered && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-[3px] px-[6px] py-[1px] rounded bg-blue-50 text-blue-700 text-[10.5px] font-medium">
                      {Number(item.qtyOrdered).toFixed(2)} {item.qtyOrderedUOM ?? item.rateUOM ?? 'lb'} received
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Amounts + chevron */}
            <LineAmounts
              total={item.rawLineTotal ? Number(item.rawLineTotal) : null}
              rate={formatRateLabel(item)}
              isOpen={isOpen}
            />
          </div>

          {/* Link row (stop propagation so clicks on buttons don't toggle card) */}
          <div
            className="flex items-center gap-2 mt-[9px] flex-wrap"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            role="presentation"
          >
            {isSkipped ? (
              /* ── Skipped state ─────────────────────────────────────────── */
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12px] text-stone-500 bg-stone-100 border border-stone-200 px-[10px] py-[4px] rounded font-medium">
                  <Ban size={11} className="shrink-0" />
                  Skipped — no COGS impact
                </span>
                <button
                  type="button"
                  onClick={handleUnskip}
                  className="inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-700 underline underline-offset-2 transition-colors"
                >
                  <Undo2 size={11} />
                  Undo
                </button>
              </div>
            ) : item.action === 'CREATE_NEW' ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[12px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-[10px] py-[4px] rounded font-medium">
                  + new item on approve
                </span>
                <button
                  type="button"
                  onClick={() => ctx.startLinkPicker(lineId)}
                  className="text-[11px] text-stone-400 hover:text-blue-600 underline underline-offset-2 transition-colors"
                >
                  change
                </button>
              </div>
            ) : !isPicking && item.matchedItem ? (
              <LinkInfoRow item={item} onChangeClick={handleChangeLink} />
            ) : !isPicking && states.isUnlinked ? (
              <button
                type="button"
                onClick={() => ctx.startLinkPicker(lineId)}
                className="inline-flex items-center gap-1.5 text-[12px] text-blue-600 border border-dashed border-blue-300 px-[10px] py-[4px] rounded hover:bg-blue-50 transition-colors"
              >
                Link product →
              </button>
            ) : null}

            <div className="ml-auto shrink-0 flex items-center gap-2">
              {/* Skip / undo button — only show when not already skipped */}
              {!isSkipped && !isPicking && (
                <button
                  type="button"
                  onClick={handleSkip}
                  title="Skip this line — won't affect COGS (use for cleaning products, tools, etc.)"
                  className="inline-flex items-center gap-1 text-[11px] text-stone-400 hover:text-stone-600 hover:bg-stone-100 px-[7px] py-[3px] rounded transition-colors"
                >
                  <Ban size={11} className="shrink-0" />
                  Skip
                </button>
              )}
              <select
                value={item.revenueCenterId ?? defaultRcId}
                onChange={handleRcChange}
                onClick={e => e.stopPropagation()}
                className="text-[11px] text-stone-600 bg-stone-50 border border-stone-200 rounded px-1.5 py-[3px] hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-blue-400 cursor-pointer"
              >
                {ctx.revenueCenters.map(r => (
                  <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* ── Expanded detail section ─────────────────────────────────────── */}
        {isOpen && (
          <div
            className="border-t border-stone-100 px-[14px] pt-[14px] pb-[16px] space-y-[11px]"
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            role="presentation"
          >
            {/* Link picker when searching */}
            {isPicking && (
              <div className="mb-1">
                <LinkPicker
                  defaultQuery={item.rawDescription ?? ''}
                  onSelect={handleSelectLink}
                  onCreateNew={() => { ctx.closeLinkPicker(); ctx.openCreateNew(item) }}
                />
                <button
                  type="button"
                  onClick={ctx.closeLinkPicker}
                  className="mt-2 text-[11px] text-stone-400 hover:text-stone-700 underline underline-offset-2"
                >
                  cancel
                </button>
              </div>
            )}

            {/* Case structure editor (per_case only) */}
            {pricingMode === 'per_case' && (
              <Card label="Pack structure">
                <CaseStructureEditor
                  item={item}
                  onChange={patch => ctx.updateLine(lineId, patch)}
                />
              </Card>
            )}

            {/* Invoice math */}
            <Card label="Invoice math" noPad>
              <InvoiceMathFields
                item={item}
                mode={pricingMode}
                onMode={m => ctx.updateLine(lineId, { pricingMode: m })}
                onChange={handleMathChange}
              />
            </Card>

            {/* Inventory comparison — hidden when flagged as new item */}
            {item.matchedItem && item.action !== 'CREATE_NEW' && (
              <InventoryComparisonCard item={item} />
            )}

            {/* Mode mismatch notice — not relevant for new items */}
            {states.hasModeMismatch && item.action !== 'CREATE_NEW' && (
              <ModeMismatchNotice item={item} lineId={lineId} pricingMode={pricingMode} />
            )}

            {/* Format mismatch notice */}
            {states.hasFormatMismatch && !states.hasModeMismatch && item.action !== 'CREATE_NEW' && (
              <FormatMismatchNotice item={item} lineId={lineId} />
            )}
          </div>
        )}
      </div>
    </article>
  )
}

// ─── Card shell ────────────────────────────────────────────────────────────────
// Thin white card with a labeled header, used inside the expanded detail section.

function Card({
  label,
  children,
  noPad,
}: {
  label: string
  children: React.ReactNode
  noPad?: boolean
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white">
      <div className={`px-[13px] pt-[10px] ${noPad ? '' : 'pb-[13px]'}`}>
        <div className="text-[10.5px] text-stone-400 uppercase tracking-[0.06em] font-medium mb-[9px]">
          {label}
        </div>
        <div className={noPad ? 'pb-[13px]' : ''}>{children}</div>
      </div>
    </div>
  )
}

// ─── InventoryComparisonCard ───────────────────────────────────────────────────
// Shows the linked product's current cost vs what this invoice would set it to.

function InventoryComparisonCard({ item }: { item: ScanItem }) {
  // Normalise both sides to a per-unit rate ($/kg, $/L, $/each) so the
  // comparison is always apples-to-apples even when pack formats differ.
  const norm = computeNormalisedPrices(item)

  let prevLabel = '—'
  let nextLabel = '—'
  let pct: number | null = null
  let rateUnit = ''

  if (norm) {
    // Convert from SI base (g/ml) to display unit (kg/L) for readability
    const factor = norm.baseUnit === 'g' || norm.baseUnit === 'ml' ? 1000 : 1
    rateUnit     = norm.baseUnit === 'g' ? 'kg' : norm.baseUnit === 'ml' ? 'L' : 'each'
    prevLabel    = `${formatCurrency(norm.inventoryPPB * factor)}/${rateUnit}`
    nextLabel    = `${formatCurrency(norm.invoicePPB   * factor)}/${rateUnit}`
    pct          = norm.pctDiff
  } else {
    // Fallback: show raw per-case prices when unit normalisation isn't possible
    const prev = item.previousPrice ? Number(item.previousPrice) : null
    const next = item.rawUnitPrice  ? Number(item.rawUnitPrice)  : null
    const bu   = item.matchedItem?.purchaseUnit ?? 'case'
    if (prev !== null) prevLabel = `${formatCurrency(prev)}/${bu}`
    if (next !== null) {
      nextLabel = `${formatCurrency(next)}/${bu}`
      if (prev !== null && prev > 0) pct = Math.round(((next - prev) / prev) * 10000) / 100
    }
  }

  const ctx2 = useDrawerContext()

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-[13px]">
      <div className="flex items-center justify-between mb-[9px]">
        <div className="text-[10.5px] text-stone-400 uppercase tracking-[0.06em] font-medium">
          Inventory comparison
        </div>
        {item.matchedItem?.id && (
          <button
            type="button"
            onClick={() => ctx2.openInventoryEdit(item.matchedItem!.id)}
            className="inline-flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
          >
            Edit <ExternalLink size={11} />
          </button>
        )}
      </div>
      <div className="text-[13px] font-medium text-stone-800 mb-2 truncate">
        {item.matchedItem?.itemName}
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <div className="text-stone-400 text-[11px] mb-[3px]">Current cost</div>
          <div className="font-medium tabular-nums text-stone-700">{prevLabel}</div>
        </div>
        <div>
          <div className="text-stone-400 text-[11px] mb-[3px]">Invoice cost</div>
          <div className="font-medium tabular-nums text-stone-900 flex items-center gap-1.5 flex-wrap">
            {nextLabel}
            {pct !== null && Math.abs(pct) >= 0.1 && (
              <VariancePill percent={Math.abs(pct)} direction={pct > 0 ? 'up' : 'down'} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── ModeMismatchNotice ────────────────────────────────────────────────────────
// Amber callout + writeback checkbox inside an expanded card that has a mode mismatch.

function ModeMismatchNotice({
  item,
  lineId,
  pricingMode,
}: {
  item: ScanItem
  lineId: string
  pricingMode: 'per_case' | 'per_weight'
}) {
  const { modeWritebackItems, toggleModeWriteback } = useDrawerContext()
  const invMode     = item.matchedItem?.priceType === 'UOM' ? 'per-weight' : 'per-case'
  const detectedLbl = pricingMode === 'per_weight' ? 'per-weight' : 'per-case'

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-[13px] text-[12px]">
      <div className="flex gap-[9px] items-start mb-[10px]">
        <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
        <div className="text-amber-800 leading-[1.5]">
          <span className="font-semibold">Mode mismatch</span>
          {' — '}invoice is <strong>{detectedLbl}</strong> but{' '}
          <strong>{item.matchedItem?.itemName}</strong> defaults to <strong>{invMode}</strong>.
        </div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer text-amber-700 hover:text-amber-900 transition-colors">
        <input
          type="checkbox"
          checked={modeWritebackItems.has(lineId)}
          onChange={() => toggleModeWriteback(lineId)}
          className="rounded border-amber-400 text-amber-600 focus:ring-amber-500 focus:ring-offset-0"
        />
        <span>Update product default to {detectedLbl} on approve</span>
      </label>
    </div>
  )
}

// ─── FormatMismatchNotice ──────────────────────────────────────────────────────
// Shows invoice vs inventory pack format with two resolution actions.

function FormatMismatchNotice({ item, lineId }: { item: ScanItem; lineId: string }) {
  const { updateLine } = useDrawerContext()
  const [resolved, setResolved] = useState<'invoice' | 'inventory' | null>(null)

  const inv = item.matchedItem
  const invFmt = inv
    ? `${inv.qtyPerPurchaseUnit} × ${inv.packSize}${inv.packUOM}`
    : null
  const invoiceFmt = item.invoicePackQty && item.invoicePackSize && item.invoicePackUOM
    ? `${item.invoicePackQty} × ${item.invoicePackSize}${item.invoicePackUOM}`
    : null

  if (resolved) {
    return (
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-[11px] text-[11.5px] text-stone-500 flex items-center gap-2">
        <span className="text-green-600">✓</span>
        Format resolved — using{' '}
        <strong className="text-stone-700">
          {resolved === 'invoice' ? invoiceFmt : invFmt}
        </strong>
        <button
          type="button"
          onClick={() => setResolved(null)}
          className="ml-auto text-[10px] text-stone-400 hover:text-stone-600 underline underline-offset-2"
        >
          undo
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-[13px] text-[12px]">
      <div className="flex gap-[9px] items-start mb-[10px]">
        <AlertTriangle size={14} className="text-blue-500 mt-0.5 shrink-0" />
        <div className="text-blue-800 leading-[1.5]">
          <span className="font-semibold">Format mismatch</span>
          {' — '}pack structure on this invoice doesn&apos;t match{' '}
          <strong>{inv?.itemName ?? 'the stored item'}</strong>.
        </div>
      </div>

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 gap-2 mb-[10px] text-[11.5px]">
        <div className="bg-white rounded border border-blue-100 px-[10px] py-[8px]">
          <div className="text-[10px] text-blue-400 font-medium uppercase tracking-wide mb-[3px]">Invoice</div>
          <div className="font-mono font-medium text-stone-800">{invoiceFmt ?? '—'}</div>
        </div>
        <div className="bg-white rounded border border-blue-100 px-[10px] py-[8px]">
          <div className="text-[10px] text-blue-400 font-medium uppercase tracking-wide mb-[3px]">Inventory</div>
          <div className="font-mono font-medium text-stone-800">{invFmt ?? '—'}</div>
        </div>
      </div>

      {/* Resolution actions */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => {
            updateLine(lineId, { formatMismatch: false })
            setResolved('invoice')
          }}
          className="text-[11px] px-[10px] py-[5px] bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors font-medium"
        >
          Use invoice format
        </button>
        <button
          type="button"
          onClick={() => {
            if (!inv) return
            updateLine(lineId, {
              formatMismatch:  false,
              invoicePackQty:  String(inv.qtyPerPurchaseUnit),
              invoicePackSize: String(inv.packSize),
              invoicePackUOM:  inv.packUOM ?? undefined,
            })
            setResolved('inventory')
          }}
          className="text-[11px] px-[10px] py-[5px] bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-50 transition-colors"
        >
          Revert to inventory format
        </button>
      </div>
    </div>
  )
}
