// Received-quantity math for an invoice line — the "total" an RC split must sum to.
// Mirrors the purchase-quantity logic in count-expected.ts so the split editor,
// approve-time validation, and theoretical receiving all agree. Pure + client-safe.

import { convertQty, convertQtyBridged, canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { asChainItem, basePerUnit, dimensionOf, type ChainItem } from '@/lib/item-model'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
import { resolveLineFormat, type OfferFormat } from '@/lib/invoice/line-format'

/** Fields of a scan line that determine how much was received. */
export interface LineQtyInput {
  rawQty?: number | string | null
  rawUnit?: string | null
  totalQty?: number | string | null
  totalQtyUOM?: string | null
  /** $/uom unit on a per-weight line — the best evidence of what totalQty is in. */
  rateUOM?: string | null
  invoicePackQty?: number | string | null
  invoicePackSize?: number | string | null
  invoicePackUOM?: string | null
  /** Frozen at approve. When > 0 it IS the answer — the live rules below are only
   *  for lines not yet approved (or not yet backfilled). Callers computing the
   *  value to freeze must NOT pass it. */
  receivedQtyBase?: number | string | null
  /** The three money fields. Together they prove whether a billed weight was the
   *  PRICED quantity (price × weight = total) or a column that merely sits on the
   *  invoice (Sysco per-case lines). A caller that omits them never takes the
   *  billed-weight step — safe, but wrong: pass them everywhere. */
  rawUnitPrice?: number | string | null
  rate?: number | string | null
  rawLineTotal?: number | string | null
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * Convert a billed quantity into the item's base unit — or **null** when the two
 * cannot honestly be reconciled.
 *
 * Returning null is the whole point. Bare `convertQty` passes a value through
 * UNCHANGED across dimensions (uom.ts), which is how 2 cases of 8 × 1100 g bread
 * came to credit "17,600 each". A null tells the caller to fall back to the item's
 * own pack structure instead of crediting a number wearing the wrong unit.
 *
 * Cross-dimension conversion is allowed only through a bridge the item actually
 * carries — the SAME density / each-measure bridges costing uses, so stock and
 * cost can no longer disagree about one line.
 */
function toBaseUnits(qty: number, unit: string | null | undefined, item: ChainItem): number | null {
  if (!unit || !(qty > 0)) return null
  const canon = canonicalUom(unit)
  // Container units (case/box/tray…) carry no fixed factor — they resolve only
  // through a pack structure, never here.
  if (!UNIT_FACTORS[canon]) return null

  const base = item.baseUnit
  const from = dimensionOf(canon)
  const to   = dimensionOf(base)
  if (from === to) return convertQty(qty, canon, base)

  // convertQtyBridged silently falls back to a 1:1 passthrough when it has no
  // bridge, so test that a real bridge spans this gap BEFORE trusting it.
  const density = item.densityGPerMl ?? null
  const each    = item.eachMeasure ?? null
  const hasDensityBridge = from !== 'COUNT' && to !== 'COUNT' && !!density && density > 0
  const hasPackBridge =
    (from === 'COUNT') !== (to === 'COUNT') &&
    !!each && each.qty > 0 &&
    dimensionOf(each.unit) === (from === 'COUNT' ? to : from)
  if (!hasDensityBridge && !hasPackBridge) return null

  return convertQtyBridged(qty, canon, base, each, density)
}

export type ReceivedVia = 'frozen' | 'billed-weight' | 'rate' | 'shipped-unit' | 'printed-pack' | 'item-pack' | 'none'
export interface Received { base: number; via: ReceivedVia; needsBridge: boolean }

/** A weight/volume unit the generic table knows — never a count or a container. */
const isMeasureUnit = (u: string | null | undefined): boolean => {
  if (!u) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}
const moneyAgrees = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.02)

/**
 * Was the billed weight the quantity the line was PRICED on? True only when
 * price × billed reproduces the line total AND price × cases does not. 2026-09-21,
 * 1,773 approved lines: zero disagreements with the OCR pricing mode, and it also
 * covers lines scanned before a mode was recorded. The per-case Sysco lines that
 * carry a stray weight column (Butter "2.86 kg" on 2 × 25 × 454 g) reconcile by
 * CASE and stay on the pack. When both reconcile the line is ambiguous → false.
 */
export function billedWeightIsPriced(line: LineQtyInput): boolean {
  const billed = num(line.totalQty), total = num(line.rawLineTotal)
  if (!(billed > 0) || !(total > 0) || !isMeasureUnit(line.totalQtyUOM)) return false
  const price = num(line.rate) || num(line.rawUnitPrice)
  if (!(price > 0)) return false

  // Price is per rateUOM; express the billed quantity in that unit first. A rate
  // unit that is present but is NOT a weight/volume of the same dimension ($/case,
  // an unknown token) can never prove a weight — refuse before multiplying.
  let billedInRateUnit = billed
  if (line.rateUOM) {
    if (!isMeasureUnit(line.rateUOM)) return false
    if (dimensionOf(canonicalUom(line.rateUOM)) !== dimensionOf(canonicalUom(line.totalQtyUOM!))) return false
    billedInRateUnit = convertQty(billed, canonicalUom(line.totalQtyUOM!), canonicalUom(line.rateUOM))
  }
  const byWeight = moneyAgrees(price * billedInRateUnit, total)
  const casePrice = num(line.rawUnitPrice), cases = num(line.rawQty)
  const byCase = casePrice > 0 && cases > 0 && moneyAgrees(casePrice * cases, total)
  return byWeight && !byCase
}

/** Base units (g/ml/each) received by a line, for the line's matched item.
 *  THE single receiving rule — `buildPurchaseMap` in count-expected.ts calls this
 *  rather than reimplementing it, so theoretical stock, the RC split editor and
 *  the approved-invoice report can never drift apart again. */
export function lineReceivedBaseUnits(line: LineQtyInput, chainItem: ChainItem): number {
  return lineReceived(line, chainItem).base
}

/** THE receiving rule, with its provenance. Order matters:
 *  frozen → billed weight proven by the money → RATE (billed, then shipped) →
 *  shipped unit is a measure → printed pack → the resolved chain. */
export function lineReceived(line: LineQtyInput, chainItem: ChainItem): Received {
  const frozen = num(line.receivedQtyBase)
  if (frozen > 0) return { base: frozen, via: 'frozen', needsBridge: false }

  const qty    = num(line.rawQty)
  const billed = num(line.totalQty)
  const isRate = chainItem.pricing?.mode === 'RATE'
  let needsBridge = false
  // `got` reads needsBridge AT CALL TIME: a fallback path reports that a weight
  // step matched but could not convert. The two weight successes return an
  // explicit `false` instead — a resolved weight never needs a bridge.
  const got = (base: number, via: ReceivedVia): Received => ({ base, via, needsBridge })

  // ── The LINE says it was billed by weight, and its own money proves it. The
  //    item's / offer's pricing mode is irrelevant: a pack chain means nothing for
  //    a purchase made by weight.
  if (billedWeightIsPriced(line)) {
    const r = toBaseUnits(billed, line.totalQtyUOM, chainItem)
    if (r !== null) return { base: r, via: 'billed-weight', needsBridge: false }
    needsBridge = true   // a weight on an item with no bridge to it — fall through, say so
  }

  // ── RATE (per-weight / catch-weight): the invoice bills a measured quantity
  //    directly. Never multiply it by a case size (that was a 10× inflation).
  if (isRate) {
    // Unit resolution order matters. The quantity's OWN unit first, then the rate's
    // unit, then the unit the item is priced in. baseUnit is the LAST resort — it
    // used to be the first fallback, silently reading "20.51" billed in kg as 20.51 g.
    const pricedUnit = chainItem.pricing.mode === 'RATE' ? chainItem.pricing.rateUnit : null
    if (billed > 0) {
      const r = toBaseUnits(billed, line.totalQtyUOM ?? line.rateUOM ?? pricedUnit ?? line.rawUnit, chainItem)
      if (r !== null) return got(r, 'rate')
    }
    if (qty > 0) {
      const r = toBaseUnits(qty, line.rawUnit ?? line.rateUOM ?? pricedUnit, chainItem)
      if (r !== null) return got(r, 'rate')
    }
  }

  // Everything below expands a count of purchase units, so without one there is
  // nothing left to expand.
  if (qty <= 0) return got(0, 'none')

  // ── The shipped quantity's OWN unit is a weight/volume ("12 lb"): that is what
  //    arrived, whatever the item's pack says.
  if (isMeasureUnit(line.rawUnit)) {
    const r = toBaseUnits(qty, line.rawUnit, chainItem)
    if (r !== null) return { base: r, via: 'shipped-unit', needsBridge: false }
    needsBridge = true
  }

  // CASE pricing (or a RATE line billed in a container unit): expand via the
  // invoice's own pack format when it can reach the base unit…
  const packQty  = num(line.invoicePackQty)
  const packSize = num(line.invoicePackSize)
  const packUOM  = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM) {
    const r = toBaseUnits(qty * packQty * packSize, packUOM, chainItem)
    if (r !== null) return got(r, 'printed-pack')
  }

  // …otherwise fall back to the item's OWN chain, which is always denominated in
  // the base unit.
  const top = chainItem.packChain?.[0]?.unit
  const perCase = top ? basePerUnit(chainItem, top) : 1
  return got(qty * perCase, 'item-pack')
}

/** Matched-item row shape (Prisma JSON-serialised) needed to resolve units. */
export interface MatchedItemLike {
  dimension: string
  baseUnit: string | null
  packChain: unknown
  pricing: unknown
  countUnit: string | null
}

/** Received quantity expressed in the item's COUNT UOM — the number the split
 *  must add up to. Returns { qty, countUom }. `offer` is the line's supplier
 *  offer (Task 2's resolveLineFormat) — when it carries a usable pack, the line
 *  is read through THAT pack rather than the item's (which is only the primary
 *  supplier's). */
export function lineReceivedCountQty(
  line: LineQtyInput, matched: MatchedItemLike, offer?: OfferFormat | null,
): { qty: number; countUom: string } {
  const chainItem = asChainItem({
    dimension: matched.dimension,
    baseUnit:  matched.baseUnit ?? 'each',
    packChain: matched.packChain,
    pricing:   matched.pricing,
    countUnit: matched.countUnit ?? undefined,
  })
  const dims = { dimension: matched.dimension, baseUnit: matched.baseUnit ?? 'each', packChain: matched.packChain, countUnit: matched.countUnit }
  const countUom = resolveCountUom(dims) || chainItem.baseUnit
  const base = lineReceivedBaseUnits(line, resolveLineFormat(chainItem, offer))
  return { qty: convertBaseToCountUom(base, countUom, dims), countUom }
}
