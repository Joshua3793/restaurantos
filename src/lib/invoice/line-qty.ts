// Received-quantity math for an invoice line — the "total" an RC split must sum to.
// Mirrors the purchase-quantity logic in count-expected.ts so the split editor,
// approve-time validation, and theoretical receiving all agree. Pure + client-safe.

import { convertQty, convertQtyBridged, canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { asChainItem, basePerUnit, dimensionOf, type ChainItem } from '@/lib/item-model'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'

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

/** Base units (g/ml/each) received by a line, for the line's matched item.
 *  THE single receiving rule — `buildPurchaseMap` in count-expected.ts calls this
 *  rather than reimplementing it, so theoretical stock, the RC split editor and
 *  the approved-invoice report can never drift apart again. */
export function lineReceivedBaseUnits(line: LineQtyInput, chainItem: ChainItem): number {
  const qty    = num(line.rawQty)
  const billed = num(line.totalQty)
  const isRate = chainItem.pricing?.mode === 'RATE'

  // ── RATE (per-weight / catch-weight): the invoice bills a measured quantity
  //    directly. Never multiply it by a case size (that was a 10× inflation).
  if (isRate) {
    // Unit resolution order matters. The quantity's OWN unit first, then the rate's
    // unit, then the unit the item is priced in. baseUnit is the LAST resort — it
    // used to be the first fallback, silently reading "20.51" billed in kg as 20.51 g.
    const pricedUnit = chainItem.pricing.mode === 'RATE' ? chainItem.pricing.rateUnit : null
    if (billed > 0) {
      const r = toBaseUnits(billed, line.totalQtyUOM ?? line.rateUOM ?? pricedUnit ?? line.rawUnit, chainItem)
      if (r !== null) return r
    }
    if (qty > 0) {
      const r = toBaseUnits(qty, line.rawUnit ?? line.rateUOM ?? pricedUnit, chainItem)
      if (r !== null) return r
    }
  }

  // Everything below expands a count of purchase units, so without one there is
  // nothing left to expand.
  if (qty <= 0) return 0

  // CASE pricing (or a RATE line billed in a container unit): expand via the
  // invoice's own pack format when it can reach the base unit…
  const packQty  = num(line.invoicePackQty)
  const packSize = num(line.invoicePackSize)
  const packUOM  = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM) {
    const r = toBaseUnits(qty * packQty * packSize, packUOM, chainItem)
    if (r !== null) return r
  }

  // …otherwise fall back to the item's OWN chain, which is always denominated in
  // the base unit.
  const top = chainItem.packChain?.[0]?.unit
  const perCase = top ? basePerUnit(chainItem, top) : 1
  return qty * perCase
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
 *  must add up to. Returns { qty, countUom }. */
export function lineReceivedCountQty(line: LineQtyInput, matched: MatchedItemLike): { qty: number; countUom: string } {
  const chainItem = asChainItem({
    dimension: matched.dimension,
    baseUnit:  matched.baseUnit ?? 'each',
    packChain: matched.packChain,
    pricing:   matched.pricing,
    countUnit: matched.countUnit ?? undefined,
  })
  const dims = { dimension: matched.dimension, baseUnit: matched.baseUnit ?? 'each', packChain: matched.packChain, countUnit: matched.countUnit }
  const countUom = resolveCountUom(dims) || chainItem.baseUnit
  const base = lineReceivedBaseUnits(line, chainItem)
  return { qty: convertBaseToCountUom(base, countUom, dims), countUom }
}
