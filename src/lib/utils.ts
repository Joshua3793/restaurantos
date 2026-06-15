import { UNIT_FACTORS, canonicalUom, type UnitDimension } from './uom'

// Re-exported so existing `@/lib/utils` importers keep working. Canonicalization
// now lives in uom.ts (the single source of truth for unit conversion).
export { canonicalUom }

// Unit conversion factors — DERIVED from the canonical UNIT_FACTORS table in
// uom.ts so this map can never drift from convertQty/UOM_GROUPS again. Keyed by
// canonical token; getUnitConv canonicalizes before lookup so aliases resolve.
export const UNIT_CONV: Record<string, number> = Object.fromEntries(
  Object.entries(UNIT_FACTORS).map(([token, { toBase }]) => [token, toBase]),
)

export const PACK_UOMS = ['each', 'g', 'kg', 'lb', 'oz', 'ml', 'l'] as const

export const PURCHASE_UNITS = [
  'case', 'bag', 'box', 'bottle', 'pack', 'tray',
  'sleeve', 'dozen', 'pallet', 'jug', 'each',
] as const

export const QTY_UOMS = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml'] as const

// Grouped count UOMs by dimension
export const WEIGHT_COUNT_UOMS = ['g', 'kg', 'lb', 'oz'] as const
export const VOLUME_COUNT_UOMS = ['ml', 'cl', 'l', 'fl oz', 'cup', 'tsp', 'tbsp'] as const
export const EACH_COUNT_UOMS   = ['each', 'pkg', 'case', 'portion', 'serve', 'batch'] as const

export const COUNT_UOMS = [
  ...EACH_COUNT_UOMS,
  ...WEIGHT_COUNT_UOMS,
  ...VOLUME_COUNT_UOMS,
] as const

/** Returns 'weight', 'volume', or 'count' for a given unit string */
export function getUnitDimension(unit: string): UnitDimension {
  return UNIT_FACTORS[canonicalUom(unit)]?.dim ?? 'count'
}

/**
 * True when a unit measures weight or volume (i.e. NOT a count/pack/case unit).
 * Single predicate used by all pricing/conversion maths so the "is this a
 * measured unit?" decision can't drift between call sites.
 */
export function isMeasuredUnit(unit: string): boolean {
  const d = getUnitDimension(unit)
  return d === 'weight' || d === 'volume'
}

/** Returns the valid Count UOM options for a given base unit */
export function compatibleCountUnits(baseUnit: string): string[] {
  const dim = getUnitDimension(baseUnit)
  if (dim === 'weight') return [...WEIGHT_COUNT_UOMS, 'batch']
  if (dim === 'volume') return [...VOLUME_COUNT_UOMS, 'batch']
  return [...EACH_COUNT_UOMS]
}

export function getUnitConv(uom: string): number {
  return UNIT_CONV[canonicalUom(uom)] ?? UNIT_CONV[uom?.toLowerCase()] ?? 1
}

/** Price per base unit (g, ml, or each) based on purchase structure */
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
  priceType: 'CASE' | 'UOM' = 'CASE',
): number {
  if (priceType === 'UOM') {
    // A UOM ("priced per weight/volume") item's purchasePrice is a rate
    // ($/kg, $/L…), so its denominator must be that weight/volume unit — never
    // a count unit. Catch-weight items packed in pieces store packUOM='each'
    // (conv 1), which left the rate unconverted and inflated the cost 1000×.
    // Fall back to a weight/volume unit when packUOM is a count unit.
    const rateUnit = isMeasuredUnit(packUOM) ? packUOM : 'kg'
    const conv = getUnitConv(rateUnit)
    return conv > 0 ? purchasePrice / conv : 0
  }
  const isWeightQty = isMeasuredUnit(qtyUOM)

  let divisor: number
  if (isWeightQty) {
    divisor = qtyPerPurchaseUnit * getUnitConv(qtyUOM)
  } else if (qtyUOM === 'pack' && innerQty != null) {
    divisor = qtyPerPurchaseUnit * innerQty * packSize * getUnitConv(packUOM)
  } else {
    divisor = qtyPerPurchaseUnit * packSize * getUnitConv(packUOM)
  }
  return divisor > 0 ? purchasePrice / divisor : 0
}

/** Derive the base unit (g / ml / each) from qtyUOM and packUOM */
export function deriveBaseUnit(qtyUOM: string, packUOM: string, packSize?: number): string {
  if (getUnitDimension(qtyUOM) === 'weight') return 'g'
  if (getUnitDimension(qtyUOM) === 'volume') return 'ml'
  // Only infer base unit from packUOM when an actual weight/volume per-each was entered
  if (packSize !== undefined && packSize <= 0) return 'each'
  if (getUnitDimension(packUOM) === 'weight') return 'g'
  if (getUnitDimension(packUOM) === 'volume') return 'ml'
  return 'each'
}

/** Conversion factor: how many base units equal 1 counting unit */
export function calcConversionFactor(
  countUOM: string,
  qtyPerPurchaseUnit: number,
  qtyUOM: string,
  innerQty: number | null,
  packSize: number,
  packUOM: string,
): number {
  const isWeightQty = isMeasuredUnit(qtyUOM)

  const itemBaseUnits = packSize * getUnitConv(packUOM)
  const packBaseUnits = (innerQty ?? 1) * itemBaseUnits

  // 'each' must be resolved before the UNIT_CONV short-circuit — weight-based
  // items (e.g. 250 g per head) must return 250, not 1.
  if (countUOM === 'each') return itemBaseUnits > 0 ? itemBaseUnits : 1

  // Standard dimensional units (g, kg, ml, l, etc.)
  if (countUOM in UNIT_CONV) return UNIT_CONV[countUOM]

  if (countUOM === 'case' || countUOM === qtyUOM) {
    if (isWeightQty) return qtyPerPurchaseUnit * getUnitConv(qtyUOM)
    return qtyPerPurchaseUnit * packBaseUnits
  }
  if (countUOM === 'pack') return packBaseUnits
  return 1
}

export function formatCurrency(amount: number): string {
  // Guard against NaN/Infinity (e.g. sums over empty data) rendering as "$NaN".
  const safe = Number.isFinite(amount) ? amount : 0
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(safe)
}

export function formatUnitPrice(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount)
}

/**
 * Display scale for a spine price (pricePerBaseUnit, denominated per g/ml/each).
 * Weight/volume bases read better per kg/L (×1000); count bases stay per base
 * unit. ONE place defines this rule so every $/unit readout agrees.
 */
export function priceDisplayScale(baseUnit: string | null | undefined): { factor: number; rateUnit: string } {
  if (baseUnit === 'g')  return { factor: 1000, rateUnit: 'kg' }
  if (baseUnit === 'ml') return { factor: 1000, rateUnit: 'L' }
  return { factor: 1, rateUnit: baseUnit || 'each' }
}

/**
 * Format a spine price for display, scaled via {@link priceDisplayScale}.
 * Single helper so every page renders $/base identically.
 */
export function formatPricePerBase(ppb: number, baseUnit: string | null | undefined): string {
  const { factor, rateUnit } = priceDisplayScale(baseUnit)
  return `${formatCurrency(ppb * factor)}/${rateUnit}`
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Format a qty+unit pair with automatic up-conversion (1000g→1 kg, 1000ml→1 L). */
export function formatQtyUnit(qty: number, unit: string): string {
  const u = unit.toLowerCase()
  if (u === 'g' && qty >= 1000)  return `${+(qty / 1000).toPrecision(4).replace(/\.?0+$/, '')} kg`
  if (u === 'ml' && qty >= 1000) return `${+(qty / 1000).toPrecision(4).replace(/\.?0+$/, '')} L`
  return `${qty} ${unit}`
}

export const CATEGORY_COLORS: Record<string, string> = {
  BREAD: 'bg-gold-soft text-gold-2',
  DAIRY: 'bg-blue-soft text-blue-text',
  DRY: 'bg-yellow-100 text-yellow-800',
  FISH: 'bg-blue-soft text-blue-text',
  MEAT: 'bg-red-soft text-red-text',
  PREPD: 'bg-blue-soft text-blue-text',
  PROD: 'bg-green-soft text-green-text',
  CHM: 'bg-bg-2 text-ink-2',
}

export const CATEGORIES = ['BREAD', 'DAIRY', 'DRY', 'FISH', 'MEAT', 'PREPD', 'PROD', 'CHM'] as const
export const BASE_UNITS = ['g', 'ml', 'each', 'kg', 'l'] as const
export const INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETE'] as const
export const WASTAGE_REASONS = ['SPOILAGE', 'OVERPRODUCTION', 'PREP_TRIM', 'BURNT', 'DROPPED', 'EXPIRED', 'STAFF_MEAL', 'UNKNOWN'] as const
export const RECIPE_CATEGORIES = ['APPETIZER', 'MAIN', 'DESSERT', 'BEVERAGE', 'SIDE', 'SAUCE', 'SOUP', 'SALAD', 'BREAD', 'OTHER'] as const
