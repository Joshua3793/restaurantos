// The unit of a weight an invoice prints without one. Pure and client-safe:
// the approve route, the receipt it freezes and the review card's "assumed kg"
// note all read the SAME answer, so the price written and the stock received
// can never be read in two different units.
// (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 1; audit 2026-10-04 §5 bug A)
//
// Bug A: Cleveland Meats' bison prints "15.775 @ $25" — no unit anywhere. The
// old fallback was the item's BASE unit (g), so 15.775 kg went into stock as
// 15.775 g and the price as $25/g. The supplier's own box is priced per kg, and
// that is the best evidence of what the supplier means.

import type { Pricing } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { isMeasureUnit } from '@/lib/invoice/approve-format'

export type WeightUnitSource = 'line-rate' | 'line-weight' | 'box' | 'count-unit' | 'base-unit' | 'fallback'

export interface WeightUnit {
  /** Canonical token: 'kg', 'lb', 'g', 'l'… */
  unit: string
  source: WeightUnitSource
  /** True when the invoice line itself states no weight/volume unit. */
  assumed: boolean
}

const canon = (u: string) => canonicalUom(u) || u

/**
 * Exact order (steps 1–3 are the approve route's rule unchanged; 4–7 replace
 * its "item base unit, else kg" fallback):
 *  1. a printed rate unit that is a weight/volume            → 'line-rate'
 *  2. received by weight + a weight/volume billed-weight unit → 'line-weight'
 *  3. received by weight + a weight/volume shipped unit       → 'line-weight'
 *  4. the box this line speaks is RATE per a weight/volume    → 'box'        (assumed)
 *  5. the item is counted in a weight/volume                  → 'count-unit' (assumed)
 *  6. the item's base unit is a weight/volume                 → 'base-unit'  (assumed)
 *  7. kg                                                      → 'fallback'   (assumed)
 * A weight column on a line NOT received by weight is not proof (steps 2–3
 * need `pricedByWeight`), exactly as before.
 */
export function weightUnitFor(a: {
  rateUOM: string | null | undefined
  totalQtyUOM: string | null | undefined
  rawUnit: string | null | undefined
  /** lineReceived(...).via is 'billed-weight' | 'shipped-unit' */
  pricedByWeight: boolean
  /** The pricing of the format this line SPEAKS: resolveLineFormat(item, thisSupplier'sBox).pricing —
   *  the box's when it is plausible, else the item's own (box-less item, or a corrupt box). */
  boxPricing: Pricing | null | undefined
  item: { countUnit: string | null | undefined; baseUnit: string | null | undefined }
}): WeightUnit {
  if (isMeasureUnit(a.rateUOM)) return { unit: canon(a.rateUOM!), source: 'line-rate', assumed: false }
  if (a.pricedByWeight && isMeasureUnit(a.totalQtyUOM)) return { unit: canon(a.totalQtyUOM!), source: 'line-weight', assumed: false }
  if (a.pricedByWeight && isMeasureUnit(a.rawUnit)) return { unit: canon(a.rawUnit!), source: 'line-weight', assumed: false }
  const box = a.boxPricing
  if (box?.mode === 'RATE' && isMeasureUnit(box.rateUnit)) return { unit: canon(box.rateUnit), source: 'box', assumed: true }
  if (isMeasureUnit(a.item.countUnit)) return { unit: canon(a.item.countUnit!), source: 'count-unit', assumed: true }
  if (isMeasureUnit(a.item.baseUnit)) return { unit: canon(a.item.baseUnit!), source: 'base-unit', assumed: true }
  return { unit: 'kg', source: 'fallback', assumed: true }
}

/** "Cleveland Meats'", "Sysco's", or "the supplier's" when there is no name. */
function possessive(name: string | null): string {
  const n = name?.trim()
  if (!n) return "the supplier's"
  return /s$/i.test(n) ? `${n}'` : `${n}'s`
}

/** The plain-English line the review card shows under an assumed unit; null when the line states its own.
 *  `boxIsSuppliers: false` — the box priced came from the item (its MAIN supplier's box), because this
 *  invoice's supplier has no usable box of its own; the note must not name this supplier then. */
export function assumedUnitNote(
  w: WeightUnit,
  ctx: { supplierName: string | null; itemName: string; boxIsSuppliers?: boolean },
): string | null {
  if (!w.assumed) return null
  const head = `assumed ${w.unit} — the invoice shows no unit`
  switch (w.source) {
    case 'box':        return ctx.boxIsSuppliers === false
      ? `${head}; the main supplier's box is priced per ${w.unit}`
      : `${head}; ${possessive(ctx.supplierName)} box is priced per ${w.unit}`
    case 'count-unit': return `${head}; ${ctx.itemName} is counted in ${w.unit}`
    case 'base-unit':  return head
    default:           return `${head}. Check it.`
  }
}
