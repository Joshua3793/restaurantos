// The review screen's reading of a line through the approve decision itself.
// Pure and client-safe: it adapts a review-UI `ScanItem` to the inputs
// `decideLinePrice` takes on the server, so the screen, the approve preflight
// (409 LINES_BLOCKED) and the approval can never disagree about whether a line
// is priced, refused, or 1,000× off.
// (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 4)

import type { InventoryMatch, ScanItem } from '@/components/invoices/types'
import {
  decideLinePrice, createNewRefusal, itemChainOf, lineQtyOf,
  type ApproveItemInput, type ApproveLineInput, type BlockReason, type LineDecision,
} from '@/lib/invoice/approve-outcome'
import { pickOffer, resolveLineFormat, type OfferFormat, type SupplierRef } from '@/lib/invoice/line-format'
import { lineReceived } from '@/lib/invoice/line-qty'
import { matchedLikeOf } from '@/lib/invoice/matched-like'
import { isMeasureUnit } from '@/lib/invoice/approve-format'
import { weightUnitFor, assumedUnitNote, type WeightUnit } from '@/lib/invoice/weight-unit'
import { canonicalUom } from '@/lib/uom'
import { dimensionOf } from '@/lib/item-model'

/** The scan-line fields the decision reads, exactly as the approve route reads the row. */
export function lineInputOf(item: ScanItem): ApproveLineInput {
  return {
    rawQty:          item.rawQty,
    rawUnit:         item.rawUnit,
    rawUnitPrice:    item.rawUnitPrice,
    rawLineTotal:    item.rawLineTotal,
    newPrice:        item.newPrice,
    totalQty:        item.totalQty,
    totalQtyUOM:     item.totalQtyUOM,
    rate:            item.rate ?? null,
    rateUOM:         item.rateUOM ?? null,
    pricingMode:     item.pricingMode ?? null,
    qtyOrdered:      item.qtyOrdered ?? null,
    invoicePackQty:  item.invoicePackQty,
    invoicePackSize: item.invoicePackSize,
    invoicePackUOM:  item.invoicePackUOM,
    supplierItemCode: item.supplierItemCode ?? null,
    rawDescription:  item.rawDescription ?? '',
    action:          item.action,
    matchedItemId:   item.matchedItemId,
    newItemData:     item.newItemData,
  }
}

/** The matched item as the decision reads it — through `matchedLikeOf`, so its bridges come along. */
export function itemInputOf(m: InventoryMatch): ApproveItemInput {
  const like = matchedLikeOf(m)
  return {
    id: m.id,
    itemName: m.itemName,
    dimension: like.dimension,
    baseUnit: like.baseUnit,
    countUnit: like.countUnit,
    packChain: like.packChain,
    pricing: like.pricing,
    eachMeasureQty: like.eachMeasureQty,
    eachMeasureUnit: like.eachMeasureUnit ?? null,
    densityGPerMl: like.densityGPerMl,
  }
}

/** The supplier's box this line speaks — `offerForSupplier`'s rule (resolution.ts), inlined
 *  here because resolution.ts imports this module. */
function lineOfferOf(item: ScanItem, ref: SupplierRef): OfferFormat | null {
  return pickOffer(item.matchedItem?.supplierPrices ?? null, { ...ref, itemCode: item.supplierItemCode ?? null })
}

const supplierNameOf = (ref: SupplierRef) => ref.canonicalName ?? ref.supplierName ?? null

/**
 * What approve would do with this line, or null when approve does not price it
 * (skipped, pending, a new product, or not linked yet — the existing link/create
 * reasons cover those).
 */
export function decisionForScanItem(item: ScanItem, ref: SupplierRef): LineDecision | null {
  if (item.action !== 'UPDATE_PRICE' && item.action !== 'ADD_SUPPLIER') return null
  const m = item.matchedItem
  if (!m || !item.matchedItemId) return null
  return decideLinePrice({
    line: lineInputOf(item),
    item: itemInputOf(m),
    lineOffer: lineOfferOf(item, ref),
    itemHasOffers: (m.supplierPrices ?? []).length > 0,
    sessionHasSupplier: !!ref.supplierId,
    supplierName: supplierNameOf(ref),
  })
}

/** A configured new product that approve would still refuse (a shouty name, a contradictory shape). */
export function createNewRefusalFor(item: ScanItem): { reason: BlockReason; message: string } | null {
  if (item.action !== 'CREATE_NEW' || !item.newItemData) return null
  return createNewRefusal(lineInputOf(item))
}

/** The unit an unlabelled weight on this line is read in, with the plain-English note
 *  the card shows while the line has no unit of its own (null once it does). */
export function weightUnitForScanItem(item: ScanItem, ref: SupplierRef): WeightUnit & { note: string | null } {
  const m = item.matchedItem
  let speaks = null as ReturnType<typeof resolveLineFormat> | null
  let pricedByWeight = false
  if (m) {
    speaks = resolveLineFormat(itemChainOf(itemInputOf(m)), lineOfferOf(item, ref))
    const via = lineReceived(lineQtyOf(lineInputOf(item)), speaks).via
    pricedByWeight = via === 'billed-weight' || via === 'shipped-unit'
  }
  const w = weightUnitFor({
    rateUOM: item.rateUOM, totalQtyUOM: item.totalQtyUOM, rawUnit: item.rawUnit,
    pricedByWeight,
    boxPricing: speaks?.pricing ?? null,
    item: { countUnit: m?.countUnit ?? null, baseUnit: m?.baseUnit ?? null },
  })
  return { ...w, note: assumedUnitNote(w, { supplierName: supplierNameOf(ref), itemName: m?.itemName ?? item.rawDescription ?? 'this item' }) }
}

/** The staged edit "It's per {unit}" makes: the rate's unit, and the billed weight's
 *  when the line prints a weight without one. A normal staged line edit. */
export function unitFixPatch(item: ScanItem, unit: string): Partial<ScanItem> {
  const patch: Partial<ScanItem> = { rateUOM: unit }
  if (item.totalQty != null && String(item.totalQty).trim() !== '' && !item.totalQtyUOM) patch.totalQtyUOM = unit
  return patch
}

const FALLBACK_UNITS = ['kg', 'lb', 'g', 'oz', 'l', 'ml']

/**
 * The unit that makes a flagged price plausible, for the "It's per kg" quick fix:
 * the box's rate unit first, then the unit the item is counted in, then the
 * usual weights and volumes — the first one under which approve would no longer
 * flag the line. Null when the line isn't flagged or no unit clears it.
 */
export function unitCheckSuggestion(item: ScanItem, ref: SupplierRef): string | null {
  const d = decisionForScanItem(item, ref)
  if (!d?.ok || !d.implausible) return null
  const current = d.weightUnit?.unit ?? null
  const dim = item.matchedItem?.dimension ?? null
  const candidates: string[] = []
  const add = (u: string | null | undefined) => {
    if (!isMeasureUnit(u)) return
    const c = canonicalUom(u!) || u!
    if (c === current || candidates.includes(c)) return
    // Stay in the item's own measure where it has one (a volume item suggests L, not kg).
    if (dim && (dim === 'MASS' || dim === 'VOLUME') && dimensionOf(c) !== dim) return
    candidates.push(c)
  }
  const box = d.speaks.pricing
  if (box?.mode === 'RATE') add(box.rateUnit)
  add(item.matchedItem?.countUnit)
  FALLBACK_UNITS.forEach(add)
  for (const u of candidates) {
    const next = decisionForScanItem({ ...item, ...unitFixPatch(item, u) }, ref)
    if (next?.ok && !next.implausible) return u
  }
  return null
}
