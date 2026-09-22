// The seed for "Create new product" from an invoice line. A by-weight line
// (per_weight, or any weight/volume unit on it) must reach formToChain with its
// MEASURE unit, or the form derives COUNT and the item is born as
// `[{lb:1}] / RATE $/each` — the shape that broke Kennebec, Salami and Fennel.
import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { billedWeightIsPriced, type LineQtyInput } from '@/lib/invoice/line-qty'
import type { ItemFormInput } from '@/lib/item-model-form'

export interface SeedLine {
  pricingMode?: string | null
  rateUOM?: string | null
  totalQtyUOM?: string | null
  rawUnit?: string | null
  rate?: unknown
  rawUnitPrice?: unknown
  newPrice?: unknown
  invoicePackQty?: unknown
  invoicePackSize?: unknown
  invoicePackUOM?: string | null
  /** The shipped quantity and the three money fields. `billedWeightIsPriced`
   *  (line-qty.ts) needs all four to tell a PRICED weight from a weight column
   *  that merely rides along on a per-case line. A caller that omits them never
   *  takes the billed-weight step — safe, but blind: pass them everywhere. */
  rawQty?: unknown
  totalQty?: unknown
  rawLineTotal?: unknown
}

const isMeasure = (u: string | null | undefined) => {
  if (!u) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}

/** Prisma `Decimal` (and anything else) → the `number | string | null` that
 *  `LineQtyInput` speaks. `SeedLine` stays `unknown`-typed so every caller —
 *  the client modal, approve, the scripts — can hand it a raw row. */
const q = (v: unknown): number | string | null =>
  v == null ? null : typeof v === 'number' || typeof v === 'string' ? v : String(v)

const qtyInputOf = (line: SeedLine): LineQtyInput => ({
  rawQty: q(line.rawQty), rawUnit: line.rawUnit,
  totalQty: q(line.totalQty), totalQtyUOM: line.totalQtyUOM, rateUOM: line.rateUOM,
  rate: q(line.rate), rawUnitPrice: q(line.rawUnitPrice), rawLineTotal: q(line.rawLineTotal),
})

/**
 * The weight/volume unit the new product should be built around — or null.
 *
 * `rateUOM` needs no corroboration: a printed `$/kg` IS the supplier saying what
 * the price is per, and it is what the item's RATE will be labelled with.
 *
 * `totalQtyUOM` / `rawUnit` are a different animal. A per-case line can carry a
 * stray shipping weight (CLAUDE.md's Butter, `2 × 25 × 454 g`, "2.86 kg") with no
 * rate at all — trusting that column would build a MASS item whose `$/kg` is
 * really the CASE price, and would then refuse the correctly-COUNT product for
 * want of an each-measure. So they count as the measure only when the line says
 * it is priced by weight (`pricingMode`) or when the money proves it
 * (`billedWeightIsPriced` — printed rate × billed weight = line total).
 */
export function lineMeasureUnit(line: SeedLine): string | null {
  if (isMeasure(line.rateUOM)) return canonicalUom(line.rateUOM!)
  if (line.pricingMode !== 'per_weight' && !billedWeightIsPriced(qtyInputOf(line))) return null
  for (const u of [line.totalQtyUOM, line.rawUnit]) if (isMeasure(u)) return canonicalUom(u!)
  return null
}

export function isByWeightLine(line: SeedLine): boolean {
  return line.pricingMode === 'per_weight' || lineMeasureUnit(line) !== null
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export function seedFromScanLine(line: SeedLine): ItemFormInput {
  const price = num(line.rate ?? line.rawUnitPrice ?? line.newPrice ?? 0)
  const measure = isByWeightLine(line) ? lineMeasureUnit(line) : null
  if (measure) {
    return { priceType: 'UOM', purchaseUnit: measure, qtyUOM: measure, packUOM: measure, qtyPerPurchaseUnit: 1, packSize: 1, innerQty: null, purchasePrice: price, countUOM: measure }
  }
  // Per-case (or a per_weight line with no resolvable measure unit — e.g. an
  // unparseable unit): falls to the per-case seed with `priceType: 'UOM'`,
  // exactly as today. `validateCreateNew` still treats it as by-weight, so a
  // COUNT dimension still needs an each-measure.
  return {
    purchaseUnit: canonicalUom(line.rawUnit ?? '') || 'case', purchasePrice: price,
    qtyPerPurchaseUnit: Number(line.invoicePackQty) || 1, qtyUOM: 'each', innerQty: null,
    packSize: Number(line.invoicePackSize) || 1, packUOM: line.invoicePackUOM ?? 'each',
    priceType: line.pricingMode === 'per_weight' ? 'UOM' : 'CASE', countUOM: 'each',
  }
}

export const CREATE_NEW_COUNT_NEEDS_EACH = 'Bought by weight but the product is counted as units — add how much one weighs, or make it a weight item.'

export function validateCreateNew(a: { line: SeedLine; dimension: string; eachMeasureQty: unknown }): { ok: true } | { ok: false; error: string } {
  if (isByWeightLine(a.line) && String(a.dimension).toUpperCase() === 'COUNT' && !(num(a.eachMeasureQty) > 0)) {
    return { ok: false, error: CREATE_NEW_COUNT_NEEDS_EACH }
  }
  return { ok: true }
}
