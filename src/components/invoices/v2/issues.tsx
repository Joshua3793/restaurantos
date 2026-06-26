'use client'
// Issue blocks for the redesigned line card. One `.issue` primitive — a coloured
// badge + plain-English description + a row of decision buttons — replaces the
// three different warning languages the old drawer used (mock §1, §3, §7).

import { ArrowRight, Check } from 'lucide-react'
import { IssueBadge, ActButton, VariancePill, type IssueKind } from './atoms'
import { useDrawerContext } from './context'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import { buildOffer, scanItemToOfferInput } from '@/lib/invoice/offer'
import { dimensionOf } from '@/lib/item-model'
import { formatCurrency } from '@/lib/invoice/formatters'
import { priceDisplayScale } from '@/lib/utils'
import { offerForSupplier, cheapestOtherOffer } from '@/lib/invoice/resolution'
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

// ─── DimensionConflictIssue ──────────────────────────────────────────────────
// The invoice line is priced by a unit whose dimension (mass / volume / count)
// doesn't match the linked item's. This is the sole hard blocker under the
// pack-chain model. It names BOTH sides of the mismatch and offers the three
// ways to resolve it: fix the line (OCR misread the units), re-link to a
// different item, or change the item itself to match the invoice.

const DIM_LABEL: Record<string, string> = { MASS: 'weight', VOLUME: 'volume', COUNT: 'count' }

export function DimensionConflictIssue({
  item,
  lineId,
  onFixUom,
}: {
  item: ScanItem
  lineId: string
  onFixUom: () => void
}) {
  const ctx = useDrawerContext()
  const md = item.matchedItem
  const itemName = md?.itemName ?? 'this item'
  // Invoice side: the SAME offer the conflict detector builds.
  const offer = buildOffer(scanItemToOfferInput(item))
  const invUnit = offer.pricing.mode === 'RATE' ? offer.pricing.rateUnit : offer.baseUnit
  // Item side.
  const itemDim = (md?.dimension as string | undefined) ?? dimensionOf(md?.baseUnit ?? 'each')
  const itemUnit = md?.countUnit || md?.baseUnit || 'each'
  // Bridge resolver: only shown when the matched item is COUNT and the line is measured.
  const isCountItem    = itemDim === 'COUNT'
  const offerIsMeasured = offer.dimension === 'MASS' || offer.dimension === 'VOLUME'
  const perEachQty  = item.invoicePackSize != null ? Number(item.invoicePackSize) : null
  const perEachUnit = (item.invoicePackUOM ?? item.rateUOM ?? null)?.toLowerCase() ?? null
  const perEachLabel = perEachQty != null && perEachUnit ? `${perEachQty} ${perEachUnit}` : null
  return (
    <IssueShell
      kind="conflict"
      label="Dimension conflict"
      actions={
        <>
          <ActButton onClick={onFixUom}>Scan error → fix the line</ActButton>
          <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Link a different item</ActButton>
          {isCountItem && offerIsMeasured && perEachLabel && (
            <ActButton variant="primary" onClick={() => ctx.bridgeAndReceiveAsCount(item)}>
              Set 1 each = {perEachLabel} and receive as units
            </ActButton>
          )}
          <ActButton variant="primary" onClick={() => ctx.adoptInvoiceFormat(item)}>
            Change {itemName} to {DIM_LABEL[offer.dimension] ?? offer.dimension}
          </ActButton>
        </>
      }
    >
      This line is priced by <b className="font-semibold text-ink">{DIM_LABEL[offer.dimension] ?? offer.dimension}</b> ({invUnit}),
      but <span className="font-medium">{itemName}</span> is set up by{' '}
      <b className="font-semibold text-ink">{DIM_LABEL[itemDim] ?? itemDim}</b> ({itemUnit}). Pick the side that’s wrong.
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
  const { factor, rateUnit } = priceDisplayScale(norm.baseUnit)
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
  const { factor, rateUnit } = norm ? priceDisplayScale(norm.baseUnit) : { factor: 1, rateUnit: '' }

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

// ── ConfIssue ────────────────────────────────────────────────────────────────
// Low-trust line: Claude flagged the OCR as low confidence (ocrNotes says why),
// or the link is only a fuzzy MEDIUM match. One decision: confirm it looks
// right (the user can first fix the line via the existing link/math editors).
export function ConfIssue({ item, lineId }: { item: ScanItem; lineId: string }) {
  const ctx = useDrawerContext()
  const acked = ctx.acknowledgedConfLines.has(lineId)
  const fuzzyMatch = item.ocrConfidence !== 'low'
  const reason = item.ocrConfidence === 'low'
    ? `The scanner wasn't sure about this line${item.ocrNotes ? ` — ${item.ocrNotes}` : ''}.`
    : `This was matched to "${item.matchedItem?.itemName ?? 'an item'}" by description similarity only — confirm it's the right product.`
  return (
    <IssueShell
      kind="conf"
      label="Check line"
      resolved={acked}
      actions={
        <>
          <ActButton variant={acked ? 'primary' : 'default'} onClick={() => ctx.acknowledgeConf(lineId)}>
            {acked ? 'Confirmed ✓' : 'Looks right'}
          </ActButton>
          {fuzzyMatch && (
            <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Change link</ActButton>
          )}
        </>
      }
    >
      {reason}
    </IssueShell>
  )
}

// ─── SupplierSwitchNote ────────────────────────────────────────────────────────
// Info-tone note when the spine price moved only because the purchase switched
// suppliers: this supplier's own price is steady, but another supplier set the
// current costing price. Not an issue — needs no decision.
export function SupplierSwitchNote({ item, sessionSupplier }: { item: ScanItem; sessionSupplier: { supplierId: string | null; supplierName: string | null } }) {
  const norm  = computeNormalisedPrices(item)
  const offer = offerForSupplier(item, sessionSupplier)
  if (!norm || !offer) return null
  const offerPPB = Number(offer.pricePerBaseUnit)
  if (offerPPB <= 0) return null
  const vsSelf  = Math.abs(((norm.invoicePPB - offerPPB) / offerPPB) * 100)
  const vsSpine = Math.abs(norm.pctDiff)
  // Only when the apparent move is a supplier artifact: steady vs self, ≥3% vs spine.
  if (vsSelf >= 3 || vsSpine < 3) return null
  const other = cheapestOtherOffer(item, sessionSupplier)
  const { factor, rateUnit: unit } = priceDisplayScale(norm.baseUnit)
  return (
    <div className="mx-4 my-2.5 flex items-start gap-2.5 bg-blue-soft border border-blue-soft rounded-lg px-3 py-2.5">
      <span className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.02em] px-2 py-[3px] rounded-full bg-blue-soft text-blue-text shrink-0">
        Supplier switch
      </span>
      <span className="text-[12.5px] text-ink-2 leading-[1.45]">
        {sessionSupplier.supplierName ?? 'This supplier'}&rsquo;s price is steady at{' '}
        <b className="font-semibold text-ink">{formatCurrency(norm.invoicePPB * factor)}/{unit}</b> — your costing price
        currently comes from a different supplier
        {other ? <> ({other.supplierName} <b className="font-semibold text-ink">{formatCurrency(Number(other.pricePerBaseUnit) * factor)}/{unit}</b>)</> : null}.
        Approving will re-cost at this supplier&rsquo;s price.
      </span>
    </div>
  )
}
