// Pure display copy for a supplier offer's price and how it derives to the
// item's own $/base-unit — pure, client-safe (only imports `@/lib/utils` and
// `@/lib/item-model`, both of which are themselves pure). No JSX, no Prisma.

import { formatCurrency } from '@/lib/utils'
import { dimensionOf } from '@/lib/item-model'

interface OfferPricingShape {
  mode?: string
  rate?: number
  rateUnit?: string
  purchasePrice?: number
}

/** The item facts needed to explain a RATE offer's derivation: its base unit,
 *  and the count↔weight bridge (each-measure) a cross-dimension rate prices
 *  through. Decimal fields may arrive as strings from Prisma JSON. */
export interface ItemForOfferCopy {
  baseUnit: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
}

/**
 * "$3.49/lb" for a RATE offer (its own real quoted unit) — never the item's
 * base unit, which may be a different dimension entirely. "$70.30/case" for a
 * PACK offer (or anything else): the case price is all a pack offer has.
 */
export function offerPriceLabel(o: { lastPrice: number; pricing: unknown }): string {
  const p = o.pricing as OfferPricingShape | null
  if (p?.mode === 'RATE') return `${formatCurrency(Number(p.rate))}/${p.rateUnit}`
  return `${formatCurrency(Number(o.lastPrice))}/case`
}

/**
 * Explains how a RATE offer's real price becomes the item's $/base-unit — or
 * why it can't. Returns null when there is nothing to explain:
 *  • a PACK offer already shows its price per case (no bridge involved), and
 *  • a same-dimension RATE (e.g. a $/kg offer on a gram item) is a plain unit
 *    conversion, not a bridge — showing the math would just be noise.
 * Otherwise: a usable bridge on the item explains the derivation; no bridge
 * (or a bridge that still prices at 0) reports the item as unpriced, in
 * `text-red-text` per the caller's styling.
 */
export function offerDerivation(
  o: { pricing: unknown },
  item: ItemForOfferCopy,
  ppb: number,
): string | null {
  const p = o.pricing as OfferPricingShape | null
  if (p?.mode !== 'RATE' || !p.rateUnit) return null

  const itemDim = item.baseUnit ? dimensionOf(item.baseUnit) : null
  if (itemDim === null || dimensionOf(p.rateUnit) === itemDim) return null // nothing to explain

  const emQty = item.eachMeasureQty != null ? Number(item.eachMeasureQty) : NaN
  const emUnit = item.eachMeasureUnit ?? null
  const hasBridge = Number.isFinite(emQty) && emQty > 0 && !!emUnit

  if (!hasBridge || !(ppb > 0)) return 'Unpriced — add a weight per each to this item'

  return `${formatCurrency(Number(p.rate))}/${p.rateUnit} × ${emQty} ${emUnit} each = ${formatCurrency(ppb)}/each`
}
