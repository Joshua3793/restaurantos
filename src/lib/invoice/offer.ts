// src/lib/invoice/offer.ts
//
// OCR line → pack-chain OfferDraft → reconcile against the matched item.
// Mirrors Controla OS (2)/item-model-redesign/invoice-engine.js onto the real
// item-model helpers. This is THE single place OCR pack data becomes a chain;
// the matcher, approve route, and drawer all go through it. There is no
// "format reconciliation" — a chain is built from the OCR hierarchy and the two
// sides are compared at the base unit. The only hard blocker is a dimension
// conflict (e.g. kg priced onto an `each` item).

import {
  type Dimension, type PackLink, type Pricing, type ChainItem,
  DIMENSION_BASE, dimensionOf, basePerPurchase, pricePerBaseUnit,
} from '@/lib/item-model'
import { getUnitConv } from '@/lib/utils'

/** Flat OCR pack fields, normalised. Both OcrLineItem and InvoiceScanItem map onto this. */
export interface OfferInput {
  pricingMode: 'per_case' | 'per_weight' | 'unknown' | null
  qtyShipped: number | null
  qtyShippedUOM: string | null
  packQty: number | null
  packSize: number | null
  packUOM: string | null
  unitPrice: number | null      // per_case: the case price
  rate: number | null           // per_weight: $/rateUOM
  rateUOM: string | null
  totalQty: number | null       // per_weight: actual received weight/volume
  totalQtyUOM: string | null
  isCatchweight: boolean | null
}

export interface OfferDraft {
  dimension: Dimension
  baseUnit: string
  packChain: PackLink[]
  pricing: Pricing
  isCatchweight: boolean
  receivedBase: number          // quantity received, in base units
  receivedLabel: string
}

export type ReconcileStatus = 'NEW' | 'MATCH' | 'PRICE_DELTA' | 'CONFLICT'
export interface ReconcileResult {
  status: ReconcileStatus
  newPpb: number
  oldPpb: number | null
  deltaPct: number | null
  dimensionConflict: boolean
}

const PRICE_ALERT_PCT = 5

const norm = (u: string | null | undefined) => (u ?? '').trim().toLowerCase()
const toBase = (qty: number | null | undefined, unit: string | null | undefined) =>
  Number(qty || 0) * getUnitConv(unit || 'each')

/** Build the pack chain from the OCR CASE/PKG/UNIT fields. Leaf carries base content. */
export function chainFromOcr(
  o: OfferInput, dimension: Dimension,
  bridge?: { qty: number; unit: string } | null,
): PackLink[] {
  const topUnit = norm(o.qtyShippedUOM) || 'case'
  const packQty = Number(o.packQty || 1)
  const packSize = Number(o.packSize || 1)
  const packUOM = norm(o.packUOM) || 'each'

  if (dimension === 'COUNT') {
    // Bridged normalization of a measured line with NO explicit count:
    // derive the count from the received total weight ÷ bridge, rounded to whole.
    if (bridge && bridge.qty > 0 && packQty <= 1 && norm(packUOM) !== 'each') {
      const totalInBridge = toBase(o.totalQty ?? o.qtyShipped, o.totalQtyUOM || packUOM)
      const count = Math.max(1, Math.round(totalInBridge / bridge.qty))
      return [{ unit: topUnit, per: count }]
    }
    // Explicit count present (e.g. 8 × 1100 g) → use packQty directly; never divide.
    const leafPer = 1
    const leafUnit = 'each'
    if (packQty > 1) return [{ unit: topUnit, per: packQty }, { unit: leafUnit, per: leafPer }]
    return [{ unit: topUnit, per: leafPer }]
  }

  const leafPer = packSize * getUnitConv(packUOM)
  const leafUnit = packUOM === 'each' ? 'each' : packUOM
  if (packQty > 1) return [{ unit: topUnit, per: packQty }, { unit: leafUnit, per: leafPer }]
  return [{ unit: topUnit, per: leafPer }]
}

/** OCR line → OfferDraft. One branch on the mode the OCR already decided. */
export function buildOffer(
  o: OfferInput,
  opts?: { bridge?: { qty: number; unit: string } | null },
): OfferDraft {
  const sigUnit = o.pricingMode === 'per_weight'
    ? (o.rateUOM || o.totalQtyUOM || 'kg')
    : (o.packUOM || o.qtyShippedUOM || 'each')
  const rawDimension = dimensionOf(sigUnit)
  // When the matched item is a bridged COUNT item and the line is measured,
  // normalize the offer to COUNT (the weight is per-each size, not the dimension).
  const bridge = opts?.bridge ?? null
  const dimension: Dimension =
    bridge && bridge.qty > 0 && rawDimension !== 'COUNT' ? 'COUNT' : rawDimension
  const baseUnit = DIMENSION_BASE[dimension]
  const packChain = chainFromOcr(o, dimension, bridge)

  if (o.pricingMode === 'per_weight') {
    const receivedBase = toBase(o.totalQty, o.totalQtyUOM || o.rateUOM)
    return {
      dimension, baseUnit, packChain,
      pricing: { mode: 'RATE', rate: Number(o.rate || 0), rateUnit: norm(o.rateUOM) || baseUnit },
      isCatchweight: !!o.isCatchweight,
      receivedBase,
      receivedLabel: `${Number(o.totalQty || 0)} ${o.totalQtyUOM || o.rateUOM || ''} actual`,
    }
  }
  const basePerPurchaseUnit = basePerPurchase(packChain)
  const receivedBase = Number(o.qtyShipped || 0) * basePerPurchaseUnit
  return {
    dimension, baseUnit, packChain,
    pricing: { mode: 'PACK', purchasePrice: Number(o.unitPrice || 0) },
    isCatchweight: false,
    receivedBase,
    receivedLabel: `${Number(o.qtyShipped || 0)} ${norm(o.qtyShippedUOM) || 'case'} × ${basePerPurchaseUnit} ${baseUnit}`,
  }
}

/** Reconcile against the matched item — one subtraction at the base unit. */
export function reconcileOffer(offer: OfferDraft, matched: ChainItem | null): ReconcileResult {
  const newPpb = pricePerBaseUnit({ ...offer, countUnit: undefined, stockOnHand: 0 })
  if (!matched) {
    return { status: 'NEW', newPpb, oldPpb: null, deltaPct: null, dimensionConflict: false }
  }
  const oldPpb = pricePerBaseUnit(matched)
  const dimensionConflict = offer.dimension !== matched.dimension
  const deltaPct = oldPpb > 0 ? ((newPpb - oldPpb) / oldPpb) * 100 : null
  let status: ReconcileStatus = 'MATCH'
  if (dimensionConflict) status = 'CONFLICT'
  else if (deltaPct != null && Math.abs(deltaPct) >= PRICE_ALERT_PCT) status = 'PRICE_DELTA'
  return { status, newPpb, oldPpb, deltaPct, dimensionConflict }
}

/** Adapter: an OcrLineItem (matcher input) → OfferInput. Field names already align. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ocrLineToOfferInput(o: any): OfferInput {
  return {
    pricingMode: o.pricingMode ?? null,
    qtyShipped: o.qtyShipped ?? null,
    qtyShippedUOM: o.qtyShippedUOM ?? null,
    packQty: o.packQty ?? null,
    packSize: o.packSize ?? null,
    packUOM: o.packUOM ?? null,
    unitPrice: o.unitPrice ?? null,
    rate: o.rate ?? null,
    rateUOM: o.rateUOM ?? null,
    totalQty: o.totalQty ?? null,
    totalQtyUOM: o.totalQtyUOM ?? null,
    isCatchweight: o.isCatchweight ?? null,
  }
}

/** Adapter: a persisted InvoiceScanItem row → OfferInput (column names differ). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scanItemToOfferInput(s: any): OfferInput {
  return {
    pricingMode: s.pricingMode ?? null,
    qtyShipped: s.rawQty != null ? Number(s.rawQty) : null,
    qtyShippedUOM: s.rawUnit ?? null,
    packQty: s.invoicePackQty != null ? Number(s.invoicePackQty) : null,
    packSize: s.invoicePackSize != null ? Number(s.invoicePackSize) : null,
    packUOM: s.invoicePackUOM ?? null,
    unitPrice: s.rawUnitPrice != null ? Number(s.rawUnitPrice) : null,
    rate: s.rate != null ? Number(s.rate) : null,
    rateUOM: s.rateUOM ?? null,
    totalQty: s.totalQty != null ? Number(s.totalQty) : null,
    totalQtyUOM: s.totalQtyUOM ?? null,
    isCatchweight: s.isCatchweight ?? null,
  }
}
