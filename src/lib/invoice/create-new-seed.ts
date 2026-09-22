// The seed for "Create new product" from an invoice line. A by-weight line
// (per_weight, or any weight/volume unit on it) must reach formToChain with its
// MEASURE unit, or the form derives COUNT and the item is born as
// `[{lb:1}] / RATE $/each` — the shape that broke Kennebec, Salami and Fennel.
import { canonicalUom, UNIT_FACTORS } from '@/lib/uom'
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
}

const isMeasure = (u: string | null | undefined) => {
  if (!u) return false
  const f = UNIT_FACTORS[canonicalUom(u)]
  return !!f && f.dim !== 'count'
}

export function lineMeasureUnit(line: SeedLine): string | null {
  for (const u of [line.rateUOM, line.totalQtyUOM, line.rawUnit]) if (isMeasure(u)) return canonicalUom(u!)
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
