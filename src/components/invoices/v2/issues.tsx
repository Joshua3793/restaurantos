'use client'
// Issue blocks for the redesigned line card. One `.issue` primitive — a coloured
// badge + plain-English description + a row of decision buttons — replaces the
// three different warning languages the old drawer used (mock §1, §3, §7).

import { useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { IssueBadge, ActButton, VariancePill, type IssueKind } from './atoms'
import { useDrawerContext } from './context'
import { computeNormalisedPrices } from '@/lib/invoice/calculations'
import { classifyDimensionRelationship } from '@/lib/invoice/classify'
import { costDriftWithinBand } from '@/lib/invoice/cost-sanity'
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
// Verdict-driven resolver for a line whose pricing dimension (mass / volume /
// count) doesn't match the linked item's. classifyDimensionRelationship sorts
// the gap into four cases:
//   • DENSITY_BRIDGE — same liquid, weight↔volume — a BLUE recoverable bridge:
//     confirm the density (g/ml) and the spine converts both sides.
//   • PACK_BRIDGE    — count↔measured — a BLUE recoverable bridge: teach how
//     1 each is measured (the existing count↔weight each-measure form).
//   • TRUE_CONFLICT  — the names don't even look like the same product — a RED
//     blocker that leads with re-link.
//   • IDENTICAL      — already bridged / no gap — renders nothing.
// In every branch the destructive "change the item to match the invoice"
// (resets stock, re-costs recipes) is demoted behind an "Advanced" disclosure.

const DIM_LABEL: Record<string, string> = { MASS: 'weight', VOLUME: 'volume', COUNT: 'count' }

// The destructive adopt path — same markup reused under "Advanced" in every
// branch so it's never the lead action.
function AdoptAdvanced({ item, itemName, dimLabel, onAdopt }: {
  item: ScanItem
  itemName: string
  dimLabel: string
  onAdopt: () => void
}) {
  return (
    <details className="mt-2.5" onClick={e => e.stopPropagation()}>
      <summary className="cursor-pointer text-[11px] text-ink-4 hover:text-ink-2 select-none list-none [&::-webkit-details-marker]:hidden">
        Advanced
      </summary>
      <div className="mt-2">
        <ActButton variant="danger" onClick={onAdopt}>
          Change {itemName} to {dimLabel} (resets stock, re-costs recipes)
        </ActButton>
      </div>
    </details>
  )
}

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
  const offerDimLabel = DIM_LABEL[offer.dimension] ?? offer.dimension
  // Item side.
  const itemDim = (md?.dimension as string | undefined) ?? dimensionOf(md?.baseUnit ?? 'each')
  const itemDimLabel = DIM_LABEL[itemDim] ?? itemDim
  const itemUnit = md?.countUnit || md?.baseUnit || 'each'

  const rel = classifyDimensionRelationship(item)

  // ── Bridge state (PACK_BRIDGE — count↔weight each-measure form) ──────────────
  // Works in EITHER direction; the bridge's unit always belongs to the MEASURED
  // side. Forward (measured line on a COUNT item) knows the per-each weight from
  // the invoice pack; reverse (count line on a measured item) starts blank.
  const isCountItem = itemDim === 'COUNT'
  const fwdBridge = isCountItem && (offer.dimension === 'MASS' || offer.dimension === 'VOLUME')
  const bridgeDim = isCountItem ? offer.dimension : itemDim     // measured dimension
  const countLabel = isCountItem ? itemUnit : 'each'            // left of "1 ___ ="
  // Prefill: prefer the classifier's perEach, then the invoice-derived pack.
  const perEachQty = rel.verdict === 'PACK_BRIDGE' && rel.perEach
    ? rel.perEach.qty
    : (fwdBridge && item.invoicePackSize != null ? Number(item.invoicePackSize) : null)
  const perEachUnit = rel.verdict === 'PACK_BRIDGE' && rel.perEach
    ? rel.perEach.unit
    : (fwdBridge ? (item.invoicePackUOM ?? item.rateUOM ?? null)?.toLowerCase() ?? null : null)

  const [bq, setBq] = useState(perEachQty != null ? String(perEachQty) : '')
  const [bu, setBu] = useState(perEachUnit ?? (bridgeDim === 'VOLUME' ? 'ml' : 'lb'))
  const [saving, setSaving] = useState(false)
  const unitOpts = bridgeDim === 'VOLUME' ? ['ml', 'l', 'oz'] : ['lb', 'kg', 'g', 'oz']
  if (bu && !unitOpts.includes(bu)) unitOpts.unshift(bu)
  const canSave = Number(bq) > 0 && !!bu && !saving
  const saveBridge = async () => {
    setSaving(true)
    try { await ctx.bridgeAndReceiveAsCount(item, { qty: Number(bq), unit: bu }) }
    finally { setSaving(false) }
  }

  // ── Density state (DENSITY_BRIDGE — weight↔volume) ───────────────────────────
  const densityDefault = rel.verdict === 'DENSITY_BRIDGE' ? String(rel.density) : '1'
  const [dq, setDq] = useState(densityDefault)
  const [savingD, setSavingD] = useState(false)
  const norm = computeNormalisedPrices(item)
  const driftOk = norm ? costDriftWithinBand(norm.invoicePPB * Number(dq || 0), norm.inventoryPPB) : true
  const canSaveDensity = Number(dq) > 0 && !savingD
  const saveDensity = async () => {
    setSavingD(true)
    try { await ctx.setItemDensity(item, Number(dq)) }
    finally { setSavingD(false) }
  }

  const advanced = (
    <AdoptAdvanced item={item} itemName={itemName} dimLabel={offerDimLabel} onAdopt={() => ctx.adoptInvoiceFormat(item)} />
  )

  // ── A) DENSITY_BRIDGE — blue, recoverable ────────────────────────────────────
  if (rel.verdict === 'DENSITY_BRIDGE') {
    return (
      <IssueShell
        kind="bridge"
        label="Confirm the bridge"
        actions={
          <>
            <ActButton variant="primary" disabled={!canSaveDensity} onClick={saveDensity}>
              {savingD ? 'Saving…' : `Confirm · 1 ml = ${dq || '?'} g`}
            </ActButton>
            <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Wrong item → re-link</ActButton>
          </>
        }
      >
        <span className="font-medium">{itemName}</span> is billed by{' '}
        <b className="font-semibold text-ink">{offerDimLabel}</b> ({invUnit}) but tracked by{' '}
        <b className="font-semibold text-ink">{itemDimLabel}</b> ({itemUnit}) — they’re the same liquid. Bridge by density.
        {rel.source === 'fallback' && <i className="text-ink-3"> Estimate — confirm before saving.</i>}
        <div className="mt-2.5 rounded-lg border border-line bg-bg px-3 py-2.5" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12.5px] text-ink-2">1 ml =</span>
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={dq}
              onChange={e => setDq(e.target.value)}
              className="w-20 h-8 px-2 text-center border border-line rounded bg-paper text-sm tabular-nums focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
            />
            <span className="text-[12.5px] text-ink-2">g</span>
          </div>
          {!driftOk && <div className="mt-1.5"><i className="text-[11.5px] text-red-text">This factor swings cost &gt;25% — check it.</i></div>}
        </div>
        {advanced}
      </IssueShell>
    )
  }

  // ── B) PACK_BRIDGE — blue, recoverable (count↔weight each-measure) ────────────
  if (rel.verdict === 'PACK_BRIDGE') {
    return (
      <IssueShell
        kind="bridge"
        label="Confirm the bridge"
        actions={
          <>
            <ActButton variant="primary" disabled={!canSave} onClick={saveBridge}>
              {saving ? 'Saving…' : 'Save & receive as units'}
            </ActButton>
            <ActButton onClick={() => ctx.startLinkPicker(lineId)}>Link a different item</ActButton>
          </>
        }
      >
        <span className="font-medium">{itemName}</span> is billed by{' '}
        <b className="font-semibold text-ink">{offerDimLabel}</b> ({invUnit}) but tracked by{' '}
        <b className="font-semibold text-ink">{itemDimLabel}</b> ({itemUnit}). Bridge by teaching how the package is made.
        <div className="mt-2.5 rounded-lg border border-line bg-bg px-3 py-2.5" onClick={e => e.stopPropagation()}>
          <div className="text-[11.5px] text-ink-3 mb-2">
            Keeps <span className="font-medium text-ink-2">{itemName}</span>{' '}
            {fwdBridge
              ? <>counted by <b>{itemUnit}</b> and converts weight invoices into units</>
              : <>measured by <b>{itemUnit}</b> and lets count invoices cost via the per-each weight</>}
            {' '}(no stock reset, no recipe flip).
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12.5px] text-ink-2">1 {countLabel} =</span>
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={bq}
              onChange={e => setBq(e.target.value)}
              className="w-20 h-8 px-2 text-center border border-line rounded bg-paper text-sm tabular-nums focus:outline-none focus:border-blue focus:ring-[3px] focus:ring-blue/10"
            />
            <select
              value={bu}
              onChange={e => setBu(e.target.value)}
              className="h-8 px-1.5 border border-line rounded bg-paper text-sm font-medium focus:outline-none focus:border-blue"
            >
              {unitOpts.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
        {advanced}
      </IssueShell>
    )
  }

  // ── C) TRUE_CONFLICT — red, leads with re-link ───────────────────────────────
  if (rel.verdict === 'TRUE_CONFLICT') {
    return (
      <IssueShell
        kind="conflict"
        label="Dimension conflict"
        actions={
          <>
            <ActButton variant="primary" onClick={() => ctx.startLinkPicker(lineId)}>Link a different item</ActButton>
            <ActButton onClick={onFixUom}>Scan error → fix the line</ActButton>
          </>
        }
      >
        <span className="font-medium">{itemName}</span> is billed by{' '}
        <b className="font-semibold text-ink">{offerDimLabel}</b> ({invUnit}) but set up by{' '}
        <b className="font-semibold text-ink">{itemDimLabel}</b> ({itemUnit}), and the names don’t look like the
        same product — link the right item.
        {advanced}
      </IssueShell>
    )
  }

  // ── D) IDENTICAL — no issue ──────────────────────────────────────────────────
  return null
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
