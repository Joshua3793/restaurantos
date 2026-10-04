// ONE per-line approve decision. Pure and client-safe (no Prisma, no
// '@/lib/supplier-offers'): the review screen, the approve preflight and approve
// itself all read a line through this, so they can never disagree about whether
// a line is priced, refused, or can only be received.
// (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 2; audit 2026-10-04 §5
// bugs A and B.)
//
// The decision is lifted from the approve route's per-line loop; the only
// behaviour changes are:
//  • a weight the invoice prints without a unit is read in the unit THIS
//    supplier's box is priced in (`weightUnitFor`), not the item's base unit —
//    Cleveland's bison "15.775 @ $25" is $25/kg and 15,775 g, not $25/g;
//  • a priced line with NO price at all is refused (`NO_PRICE`) instead of
//    falling through every branch — never approved, never counted (Limes);
//  • a per-weight price 20× or more off the box's current $/base is flagged
//    (`implausible`) so the reviewer confirms it before it is written.

import {
  type ChainItem, type Dimension, type PackLink, type Pricing,
  asChainItem, dimensionOf, eachMeasureOf, invoicePackBaseTotal,
  packFormatsDisagree, pricePerBaseUnit, rateIsCostable, ratePerBase, DIMENSION_BASE,
} from '@/lib/item-model'
import { lineReceived, lineReceivedBaseUnits, type LineQtyInput, type Received } from '@/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer, IMPLAUSIBLE_PRICE_RATIO, type OfferFormat, type SupplierRef } from '@/lib/invoice/line-format'
import { packReference, casePricePerBase, freezeFormat, pricingBasisFor, weightBasisRate } from '@/lib/invoice/approve-format'
import { weightUnitFor, type WeightUnit } from '@/lib/invoice/weight-unit'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { seedFromScanLine, validateCreateNew, createNewName } from '@/lib/invoice/create-new-seed'
import { formToChain, type ChainShape } from '@/lib/item-model-form'
import { lookupDensity } from '@/lib/density'
import { getUnitConv, formatCurrency, priceDisplayScale } from '@/lib/utils'
import { canonicalUom } from '@/lib/uom'
import type { ScanItem } from '@/components/invoices/types'

export type BlockReason =
  | 'PACK_DISAGREES'     // printed case ≠ this supplier's box (or the item's) by > 25 %  (packFormatsDisagree)
  | 'RATE_UNCOSTABLE'    // a $/kg rate on an item that can't take it (rateIsCostable false)
  | 'NO_PRICE'           // the line works out at $0 / NaN, or carries no price at all
  | 'PRICE_IMPLAUSIBLE'  // per-weight line ≥ 20× (IMPLAUSIBLE_PRICE_RATIO) above or below the box's current $/base
  | 'NOT_LINKED'         // UPDATE_PRICE / ADD_SUPPLIER with no matched item
  | 'CREATE_NEW_NOT_SET_UP' | 'CREATE_NEW_NAME' | 'CREATE_NEW_SHAPE'   // the three CREATE_NEW refusals

/** Prisma `Decimal`, a JSON string, a number, or nothing. */
type Num = number | string | { toString(): string } | null | undefined

/** The scan-line fields the decision reads (a Prisma row or a client ScanItem both fit). */
export interface ApproveLineInput {
  rawQty: Num
  rawUnit: string | null
  rawUnitPrice: Num
  rawLineTotal: Num
  newPrice: Num
  totalQty: Num
  totalQtyUOM: string | null
  rate: Num
  rateUOM: string | null
  pricingMode: string | null
  qtyOrdered?: Num
  invoicePackQty: Num
  invoicePackSize: Num
  invoicePackUOM: string | null
  supplierItemCode: string | null
  rawDescription: string
  action: string
  matchedItemId: string | null
  newItemData: string | null
}

/** The matched item's row (PRICING_SELECT + id + name). */
export interface ApproveItemInput {
  id: string
  itemName: string
  dimension: string
  baseUnit: string | null
  countUnit: string | null
  packChain: unknown
  pricing: unknown
  eachMeasureQty: unknown
  eachMeasureUnit: string | null
  densityGPerMl?: unknown
}

export type LineDecision =
  | { ok: true
      speaks: ChainItem; received: Received; pricedByWeight: boolean; isUomMode: boolean
      /** Set on the weight path: the unit the rate is stored per, and where it came from. */
      weightUnit: WeightUnit | null
      resolvedRateUnit: string; density: number; itemForRate: ChainItem
      reverseBridge: boolean; reverseBasePerCase: number
      newPurchasePrice: number; newPricePerBase: number; spineNewPpb: number | null; newPricing: Pricing
      /** Base units approve freezes for this line: the weight the price was derived
       *  over, else the line read through the pricing this approval writes. */
      receiveBase: number
      /** Non-null ⇒ PRICE_IMPLAUSIBLE unless the reviewer confirmed the price.
       *  `assumed`: the weight unit was assumed (the line prints none), so the
       *  check fires at 3× instead of 20×. */
      implausible: { ratio: number; currentPpb: number; assumed: boolean } | null }
  | { ok: false; reason: Exclude<BlockReason, 'PRICE_IMPLAUSIBLE'>; message: string
      speaks: ChainItem | null; received: Received | null; receivable: boolean; receiveBase: number }

export interface BlockedLine {
  scanItemId: string
  description: string
  itemName: string | null
  reason: BlockReason
  message: string
  /** The stock can be received with the old price kept (PACK_DISAGREES, RATE_UNCOSTABLE, NO_PRICE — when
   *  there is stock to receive AND the item can convert the line's quantity). Never PRICE_IMPLAUSIBLE:
   *  a price that looks off usually means the unit is wrong, so the quantity is too. */
  canReceiveWithoutPrice: boolean
  /** Only PRICE_IMPLAUSIBLE: the reviewer may say "the price is right" — the ONLY way it clears. */
  canConfirmPrice: boolean
}

const RECEIVABLE_REASONS: ReadonlySet<BlockReason> = new Set(['PACK_DISAGREES', 'RATE_UNCOSTABLE', 'NO_PRICE'])

/** The 20× rule for a unit the line prints; an ASSUMED unit asks at 3×. */
export const ASSUMED_UNIT_PRICE_RATIO = 3

const str = (v: Num): string | null => (v == null ? null : v.toString())

/**
 * The receiving-rule inputs of a scan line. Deliberately WITHOUT receivedQtyBase:
 * that column is approve's own output, and echoing it back would make a
 * re-approve freeze the stale value instead of recomputing it.
 */
export function lineQtyOf(line: ApproveLineInput): LineQtyInput {
  return {
    rawQty:          str(line.rawQty),
    rawUnit:         line.rawUnit,
    totalQty:        str(line.totalQty),
    totalQtyUOM:     line.totalQtyUOM,
    rateUOM:         line.rateUOM,
    invoicePackQty:  str(line.invoicePackQty),
    invoicePackSize: str(line.invoicePackSize),
    invoicePackUOM:  line.invoicePackUOM,
    rawUnitPrice:    str(line.rawUnitPrice),
    rate:            str(line.rate),
    rawLineTotal:    str(line.rawLineTotal),
  }
}

/** The item row as the pricing engine reads it (same normalisation as the route). */
export function itemChainOf(item: ApproveItemInput): ChainItem {
  return asChainItem({
    dimension:       item.dimension,
    baseUnit:        item.baseUnit ?? 'each',
    packChain:       item.packChain,
    pricing:         item.pricing,
    countUnit:       item.countUnit ?? undefined,
    eachMeasureQty:  item.eachMeasureQty,
    eachMeasureUnit: item.eachMeasureUnit,
    densityGPerMl:   item.densityGPerMl,
  })
}

// ── Plain-English pieces ──────────────────────────────────────────────────────

/** "Cleveland Meats'", "Sysco's". */
function possessive(name: string): string {
  const n = name.trim()
  return /s$/i.test(n) ? `${n}'` : `${n}'s`
}

const plainNum = (n: number, dp = 2) => (+n.toFixed(dp)).toLocaleString('en-CA')

/** An amount of base units the way a cook says it: "1.81 kg", "454 g", "1.5 L", "48 each". */
function amountText(base: number, baseUnit: string): string {
  const u = canonicalUom(baseUnit) || baseUnit
  if (u === 'g')  return base >= 1000 ? `${plainNum(base / 1000)} kg` : `${plainNum(+base.toPrecision(3))} g`
  if (u === 'ml') return base >= 1000 ? `${plainNum(base / 1000)} L` : `${plainNum(+base.toPrecision(3))} ml`
  return `${plainNum(base)} ${u}`
}

/** A $/base price in the friendliest unit: "$25.00 per kg", "$0.42 each". */
function pricePerText(ppb: number, baseUnit: string): string {
  const { factor, rateUnit } = priceDisplayScale(baseUnit)
  const money = formatCurrency(ppb * factor)
  return rateUnit === 'each' ? `${money} each` : `${money} per ${rateUnit}`
}

/** Whose box: "Sysco's box for Cilantro" (the supplier's own), "Cilantro's box" (the item's). */
function boxOwner(against: 'offer' | 'item', supplierName: string | null, itemName: string): string {
  return against === 'offer' && supplierName?.trim()
    ? `${possessive(supplierName)} box for ${itemName}`
    : `${possessive(itemName)} box`
}

/** The reference box as a pack: "a case of 4 × 1 lb (1.81 kg)", else "a case of 3 kg". */
function boxPackText(chain: PackLink[], total: number, baseUnit: string, triple: { packQty?: unknown; packSize?: unknown; packUOM?: unknown } | null): string {
  const top = chain[0]?.unit || 'case'
  const q = Number(triple?.packQty), s = Number(triple?.packSize)
  const u = typeof triple?.packUOM === 'string' ? triple.packUOM : ''
  if (q > 0 && s > 0 && u) {
    const claimed = invoicePackBaseTotal({ packQty: q, packSize: s, packUOM: u }, baseUnit)
    // The provenance triple is only quoted when it still describes this chain.
    if (claimed > 0 && Math.abs(claimed - total) <= total * 0.01) {
      return `a ${top} of ${plainNum(q, 3)} × ${plainNum(s, 3)} ${canonicalUom(u) || u} (${amountText(total, baseUnit)})`
    }
  }
  return `a ${top} of ${amountText(total, baseUnit)}`
}

/** The line's printed pack: "1 × 1 lb (454 g)", or just "1 × 20 kg" when the bracket would repeat it. */
function linePackText(line: ApproveLineInput, total: number, baseUnit: string): string {
  const q = Number(line.invoicePackQty), s = Number(line.invoicePackSize)
  const u = canonicalUom(line.invoicePackUOM ?? '') || (line.invoicePackUOM ?? '')
  const printed = `${plainNum(q, 3)} × ${plainNum(s, 3)} ${u}`
  const amount = amountText(total, baseUnit)
  return q === 1 && amount === `${plainNum(s, 3)} ${u}` ? printed : `${printed} (${amount})`
}

const RECEIVE_OR = 'or receive the stock and keep the old price.'

export const NO_PRICE_MESSAGE = `This line has no price. Enter the price, ${RECEIVE_OR}`
export const NOT_LINKED_MESSAGE = "This line isn't linked to a product. Link it, create a product, or skip it."
/** A refused line whose quantity is a weight the item can't convert: receive-only is not offered. */
export const NEEDS_WEIGHT_MESSAGE = "Can't receive this without knowing how much one weighs — add it in Edit."

function rateUncostableMessage(rateUnit: string, item: ApproveItemInput): string {
  const dim = String(item.dimension ?? '').toUpperCase() || dimensionOf(item.baseUnit ?? 'each')
  if (dim === 'COUNT') {
    const counted = canonicalUom(item.baseUnit ?? 'each') || 'each'
    return `This line is priced per ${rateUnit}, but ${item.itemName} is counted in ${counted} and has no weight per ${counted}. ` +
      `Set how much one weighs, ${RECEIVE_OR}`
  }
  return `This line is priced per ${rateUnit}, but ${item.itemName} can't be priced that way. ` +
    `Set how much one weighs, ${RECEIVE_OR}`
}

/** The refusal sentence once receive-only is off the table: the advice to set the
 *  weight (or receive anyway) is replaced by why it can't be received. */
function withoutReceiveOnly(message: string): string {
  const cut = message.indexOf('Set how much one weighs, ' + RECEIVE_OR)
  if (cut >= 0) return `${message.slice(0, cut)}${NEEDS_WEIGHT_MESSAGE}`
  const tail = message.lastIndexOf(', ' + RECEIVE_OR)
  return tail >= 0 ? `${message.slice(0, tail)}. ${NEEDS_WEIGHT_MESSAGE}` : `${message} ${NEEDS_WEIGHT_MESSAGE}`
}

/** "about 1,000×" — the bigger way up, rounded to 2 significant figures. */
function timesText(ratio: number): string {
  const up = ratio >= 1 ? ratio : 1 / ratio
  return `${(+up.toPrecision(2)).toLocaleString('en-CA')}×`
}

type ImplausibleArgs = {
  newPricePerBase: number; currentPpb: number; ratio: number
  baseUnit: string; itemName: string; supplierName: string | null; boxIsSuppliers: boolean
  /** The weight unit was assumed (the line prints none) — the 3× check. */
  assumed?: boolean
}

/** The PRICE_IMPLAUSIBLE sentence in two parts: what to do (`head`) and the two prices (`detail`). */
export function implausibleParts(a: ImplausibleArgs): { head: string; detail: string } {
  const whose = a.boxIsSuppliers && a.supplierName?.trim() ? `${possessive(a.supplierName)} box` : `${possessive(a.itemName)} box`
  const head = a.assumed
    ? `The unit was assumed; the price is ${timesText(a.ratio)} off the box — confirm the unit.`
    : `Price looks about ${timesText(a.ratio)} off — check the unit.`
  return { head, detail: `This line works out at ${pricePerText(a.newPricePerBase, a.baseUnit)}; ${whose} is ${pricePerText(a.currentPpb, a.baseUnit)}.` }
}

/** The PRICE_IMPLAUSIBLE sentence. `boxIsSuppliers`: the current price came from this supplier's own box. */
export function implausibleMessage(a: ImplausibleArgs): string {
  const { head, detail } = implausibleParts(a)
  return `${head} ${detail}`
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * What approve does with ONE priced line (UPDATE_PRICE / ADD_SUPPLIER) on its
 * matched item: the price it writes, or why it refuses and how much stock the
 * line could still put in.
 */
export function decideLinePrice(a: {
  line: ApproveLineInput
  item: ApproveItemInput
  /** pickOffer(offers, { supplierId, supplierName, canonicalName, itemCode }) — null on an unlinked session. */
  lineOffer: OfferFormat | null
  itemHasOffers: boolean
  sessionHasSupplier: boolean
  supplierName: string | null
}): LineDecision {
  const { line, item, lineOffer } = a
  const itemAsChain = itemChainOf(item)
  const qtyIn = lineQtyOf(line)

  // ── Which pack does THIS line speak? This supplier's box (when usable), else the item.
  const speaks = resolveLineFormat(itemAsChain, lineOffer)

  // How the line was RECEIVED decides how it is PRICED (pricingBasisFor).
  const received = lineReceived(qtyIn, speaks)
  const pricedByWeight = received.via === 'billed-weight' || received.via === 'shipped-unit'
  const itemBridge = eachMeasureOf(item)
  const isUomMode = pricingBasisFor({
    via: received.via,
    ocrPerWeight: derivePricingMode(line as unknown as ScanItem) === 'per_weight',
    itemHasEachMeasure: !!itemBridge,
  }) === 'WEIGHT'

  // A refusal writes no price, so the receipt is read through the PRE-write format.
  // It can be received only when there is stock AND the quantity is real: a weight
  // the item has no bridge to (`needsBridge` — Eggplant "12 lb" on an each-item
  // with no weight per each) falls back to counting cases, which is a guess
  // (12 "cases" = 288 each). Then receive-only is not offered at all.
  const refuse = (reason: Exclude<BlockReason, 'PRICE_IMPLAUSIBLE'>, message: string): LineDecision => {
    const receiveBase = received.base   // === lineReceivedBaseUnits(qtyIn, speaks) on every path
    const receivable = receiveBase > 0 && !received.needsBridge
    return {
      ok: false, reason, message: received.needsBridge ? withoutReceiveOnly(message) : message,
      speaks, received, receivable, receiveBase,
    }
  }

  // NEW: a priced line carrying no price at all (Limes). Today it fell through
  // the route's loop: never approved, never counted as skipped.
  if (line.rawUnitPrice == null && line.rate == null && line.newPrice == null) {
    return refuse('NO_PRICE', NO_PRICE_MESSAGE)
  }

  // ── Reverse bridge: a MEASURED item receiving a COUNT line ("1 cs = 70 each"
  // on a g item) converts through the each-measure.
  const reverseBridge =
    !!itemBridge && item.dimension !== 'COUNT' &&
    dimensionOf(line.invoicePackUOM ?? line.rawUnit ?? 'each') === 'COUNT' &&
    dimensionOf(itemBridge.unit) === item.dimension
  const reverseBasePerCase = reverseBridge
    ? ((Number(line.invoicePackQty) || 1) * (Number(line.invoicePackSize) || 1))
      * (itemBridge!.qty * getUnitConv(itemBridge!.unit) / getUnitConv(item.baseUnit ?? itemBridge!.unit))
    : 0

  // The price comes from the RAW, user-editable fields — never the stored
  // `newPrice` while a raw one exists (an OCR-time newPrice can be inflated).
  let newPurchasePrice = isUomMode
    ? (line.rate != null ? Number(line.rate)
      : (pricedByWeight && line.rawUnitPrice != null) ? Number(line.rawUnitPrice)
      : Number(line.newPrice))
    : (line.rawUnitPrice != null ? Number(line.rawUnitPrice) : Number(line.newPrice))

  let newPricePerBase: number
  let spineNewPpb: number | null = null
  let density = 0
  let resolvedRateUnit = 'kg'   // only meaningful on the weight path
  let weightUnit: WeightUnit | null = null
  let itemForRate = itemAsChain

  if (isUomMode) {
    // NEW (bug A): weightUnitFor is THE rule — the line's own printed unit
    // first; when it shows none, the unit this supplier's box is priced in,
    // then the item's weight count unit, its base unit, kg. Canonical token.
    weightUnit = weightUnitFor({
      rateUOM:        line.rateUOM,
      totalQtyUOM:    line.totalQtyUOM,
      rawUnit:        line.rawUnit,
      pricedByWeight,
      boxPricing:     speaks.pricing,
      item:           { countUnit: item.countUnit, baseUnit: item.baseUnit },
    })
    resolvedRateUnit = weightUnit.unit
    // Weight↔volume density bridge: learned on the item > library by name > 1.0.
    const rateDim = dimensionOf(resolvedRateUnit)
    const baseDim = dimensionOf(item.baseUnit ?? 'each')
    const crossesWV = (rateDim === 'MASS' && baseDim === 'VOLUME') || (rateDim === 'VOLUME' && baseDim === 'MASS')
    if (crossesWV) {
      const learned = item.densityGPerMl != null ? Number(item.densityGPerMl) : null
      density = (learned && learned > 0) ? learned : lookupDensity(item.itemName ?? line.rawDescription ?? '').gPerMl
      itemForRate = { ...itemAsChain, densityGPerMl: density }
    }
    // On a line received by weight, is the printed "rate" really per this unit?
    if (pricedByWeight) {
      newPurchasePrice = weightBasisRate({
        rate:         line.rate != null ? Number(line.rate) : null,
        rateUOM:      line.rateUOM,
        rawLineTotal: line.rawLineTotal != null ? Number(line.rawLineTotal) : null,
        receivedBase: received.base,
        rateUnit:     resolvedRateUnit,
        item:         itemForRate,
        fallback:     newPurchasePrice,
      }).rate
    }
    newPricePerBase = ratePerBase(newPurchasePrice, resolvedRateUnit, itemForRate)
  } else if (reverseBridge && reverseBasePerCase > 0) {
    newPricePerBase = newPurchasePrice / reverseBasePerCase
  } else {
    // CASE: per-case price over the pack this line speaks — only while the
    // invoice's case and THIS supplier's box (or the item's) hold the same amount.
    const baseUnit = item.baseUnit ?? 'each'
    const invoiceBaseTotal = invoicePackBaseTotal(
      {
        packQty:  line.invoicePackQty  != null ? Number(line.invoicePackQty)  : null,
        packSize: line.invoicePackSize != null ? Number(line.invoicePackSize) : null,
        packUOM:  line.invoicePackUOM,
      },
      baseUnit,
    )
    const itemChain = (item.packChain as PackLink[]) ?? []
    const ref = packReference(itemChain, lineOffer, a.sessionHasSupplier && a.itemHasOffers)
    const packs = ref ? packFormatsDisagree(invoiceBaseTotal, ref.baseTotal) : { disagree: false, ratio: 1 }
    if (packs.disagree) {
      const refChain = ref!.against === 'offer' ? (lineOffer!.packChain as PackLink[]) : itemChain
      const triple = ref!.against === 'offer' ? (lineOffer as { packQty?: unknown; packSize?: unknown; packUOM?: unknown }) : null
      return refuse('PACK_DISAGREES',
        `${boxOwner(ref!.against, a.supplierName, item.itemName)} is ${boxPackText(refChain, ref!.baseTotal, baseUnit, triple)}. ` +
        `This line says ${linePackText(line, invoiceBaseTotal, baseUnit)}. Fix the case size, ${RECEIVE_OR}`)
    }
    newPricePerBase = casePricePerBase(speaks, newPurchasePrice)
    spineNewPpb = casePricePerBase(itemAsChain, newPurchasePrice)
  }

  // A rate the item cannot be costed in ($/kg on an each-item with no weight per each).
  if (isUomMode && item.baseUnit && !rateIsCostable(resolvedRateUnit, itemForRate)) {
    return refuse('RATE_UNCOSTABLE', rateUncostableMessage(resolvedRateUnit, item))
  }

  // Never write a zero/NaN price — it silently zeroes every recipe that reads it.
  if (!Number.isFinite(newPricePerBase) || newPricePerBase <= 0) {
    return refuse('NO_PRICE', NO_PRICE_MESSAGE)
  }

  const newPricing: Pricing = isUomMode
    ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: resolvedRateUnit }
    : { mode: 'PACK', purchasePrice: newPurchasePrice }

  // What approve freezes: on the weight path the price was derived over
  // received.base, so that is the quantity; otherwise read through the pricing
  // this approval writes (freezeFormat).
  const receiveBase = pricedByWeight
    ? received.base
    : lineReceivedBaseUnits(qtyIn, freezeFormat(speaks, newPricing))

  // NEW: a per-weight price 20× or more off the box's current $/base — or 3× when
  // the unit was ASSUMED (the line prints none): a guessed unit is the likeliest
  // reason for a price that far off, so the reviewer confirms it sooner.
  let implausible: { ratio: number; currentPpb: number; assumed: boolean } | null = null
  if (isUomMode) {
    const currentPpb = pricePerBaseUnit(speaks)
    if (currentPpb > 0 && newPricePerBase > 0) {
      const ratio = newPricePerBase / currentPpb
      const assumed = !!weightUnit?.assumed
      const off = assumed
        ? ratio >= ASSUMED_UNIT_PRICE_RATIO || ratio <= 1 / ASSUMED_UNIT_PRICE_RATIO
        : ratio > IMPLAUSIBLE_PRICE_RATIO || ratio < 1 / IMPLAUSIBLE_PRICE_RATIO
      if (off) implausible = { ratio, currentPpb, assumed }
    }
  }

  return {
    ok: true, speaks, received, pricedByWeight, isUomMode, weightUnit,
    resolvedRateUnit, density, itemForRate, reverseBridge, reverseBasePerCase,
    newPurchasePrice, newPricePerBase, spineNewPpb, newPricing, receiveBase, implausible,
  }
}

// ── CREATE_NEW ───────────────────────────────────────────────────────────────

/**
 * The chain a CREATE_NEW line's product is born with — exactly as approve builds
 * it: the modal's chain-shaped newItemData, else the legacy pack fields over the
 * line's own seed (formToChain).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createNewChain(line: ApproveLineInput, newData: any): ChainShape {
  if (Array.isArray(newData.packChain)) {
    const dimension = (newData.dimension ?? dimensionOf(newData.baseUnit ?? 'each')) as Dimension
    return {
      dimension,
      baseUnit: DIMENSION_BASE[dimension],
      packChain: newData.packChain as PackLink[],
      pricing: newData.pricing as Pricing,
      countUnit: newData.countUnit || 'each',
    }
  }
  return formToChain({
    ...seedFromScanLine(line),
    ...(newData.purchaseUnit ? { purchaseUnit: newData.purchaseUnit } : {}),
    ...(newData.purchasePrice ? { purchasePrice: Number(newData.purchasePrice) } : {}),
    ...(newData.qtyPerPurchaseUnit ? { qtyPerPurchaseUnit: Number(newData.qtyPerPurchaseUnit) } : {}),
    ...(newData.packSize ? { packSize: Number(newData.packSize) } : {}),
    ...(newData.packUOM ? { packUOM: newData.packUOM } : {}),
    ...(newData.priceType ? { priceType: newData.priceType === 'UOM' ? 'UOM' as const : 'CASE' as const } : {}),
    ...(newData.countUOM ? { countUOM: newData.countUOM } : {}),
    ...(newData.baseUnit ? { baseUnit: newData.baseUnit } : {}),
  })
}

/** Approve's three CREATE_NEW refusals, in its order; null when the product can be created. */
export function createNewRefusal(line: ApproveLineInput):
  { reason: 'CREATE_NEW_NOT_SET_UP' | 'CREATE_NEW_NAME' | 'CREATE_NEW_SHAPE'; message: string } | null {
  const notSetUp = { reason: 'CREATE_NEW_NOT_SET_UP' as const, message: `"${line.rawDescription}" was never set up in the Add new product form. Open it and fill it in, or skip it.` }
  if (!line.newItemData) return notSetUp
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let newData: any
  try { newData = JSON.parse(line.newItemData) } catch { return notSetUp }
  if (!newData || typeof newData !== 'object') return notSetUp
  const name = createNewName({ itemName: newData.itemName, rawDescription: line.rawDescription, allowShouty: newData.allowShouty })
  if (!name.ok) return { reason: 'CREATE_NEW_NAME', message: `"${line.rawDescription}": ${name.error}` }
  const chain = createNewChain(line, newData)
  const gate = validateCreateNew({ line, dimension: chain.dimension, eachMeasureQty: newData.eachMeasureQty })
  if (!gate.ok) return { reason: 'CREATE_NEW_SHAPE', message: `"${line.rawDescription}": ${gate.error}` }
  return null
}

// ── The preflight ────────────────────────────────────────────────────────────

/** The preflight: every line approve would refuse, minus the ones the reviewer already decided. */
export function approveBlocks(a: {
  lines: Array<ApproveLineInput & { id: string; matchedItem: ApproveItemInput | null }>
  offersByItem: Map<string, OfferFormat[]>
  supplier: SupplierRef & { id: string | null }
  receiveWithoutPrice: Set<string>
  priceConfirmed: Set<string>
}): BlockedLine[] {
  const supplierId = a.supplier.supplierId ?? a.supplier.id ?? null
  const supplierName = a.supplier.canonicalName ?? a.supplier.supplierName ?? null
  const out: BlockedLine[] = []
  const block = (l: { id: string; rawDescription: string }, itemName: string | null, reason: BlockReason, message: string, receivable: boolean) =>
    out.push({
      scanItemId: l.id, description: l.rawDescription, itemName, reason, message,
      canReceiveWithoutPrice: RECEIVABLE_REASONS.has(reason) && receivable,
      canConfirmPrice: reason === 'PRICE_IMPLAUSIBLE',
    })

  for (const l of a.lines) {
    if (l.action === 'CREATE_NEW') {
      // No product exists to receive into, so neither choice clears these.
      const r = createNewRefusal(l)
      if (r) block(l, null, r.reason, r.message, false)
      continue
    }
    if (l.action !== 'UPDATE_PRICE' && l.action !== 'ADD_SUPPLIER') continue
    if (!l.matchedItemId || !l.matchedItem) {
      block(l, null, 'NOT_LINKED', NOT_LINKED_MESSAGE, false)
      continue
    }
    const offers = a.offersByItem.get(l.matchedItemId) ?? []
    const lineOffer = supplierId
      ? pickOffer(offers, { supplierId, supplierName: a.supplier.supplierName, canonicalName: a.supplier.canonicalName, itemCode: l.supplierItemCode })
      : null
    const d = decideLinePrice({
      line: l, item: l.matchedItem, lineOffer,
      itemHasOffers: offers.length > 0, sessionHasSupplier: !!supplierId, supplierName,
    })
    const itemName = l.matchedItem.itemName
    if (!d.ok) {
      if (d.receivable && a.receiveWithoutPrice.has(l.id)) continue
      block(l, itemName, d.reason, d.message, d.receivable)
      continue
    }
    // A price that looks off clears ONLY by "The price is right": a wrong unit
    // makes the quantity wrong too, so receiving it "without the price" would put
    // a 1,000×-off amount into stock. (receiveWithoutPrice is ignored here.)
    if (d.implausible && !a.priceConfirmed.has(l.id)) {
      const boxIsSuppliers = !!lineOffer && d.speaks.pricing === lineOffer.pricing
      block(l, itemName, 'PRICE_IMPLAUSIBLE', implausibleMessage({
        newPricePerBase: d.newPricePerBase, currentPpb: d.implausible.currentPpb, ratio: d.implausible.ratio,
        baseUnit: l.matchedItem.baseUnit ?? 'each', itemName, supplierName, boxIsSuppliers, assumed: d.implausible.assumed,
      }), false)
    }
  }
  return out
}
