// Unit conversion factors — all weight → g, all volume → ml, count → 1
export const UNIT_CONV: Record<string, number> = {
  // weight
  g: 1, mg: 0.001, kg: 1000, lb: 453.592, oz: 28.3495,
  // volume
  ml: 1, cl: 10, dl: 100, l: 1000, lt: 1000, 'fl oz': 29.5735, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, gal: 3785.41,
  // count
  each: 1, ea: 1,
}

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
export function getUnitDimension(unit: string): 'weight' | 'volume' | 'count' {
  const u = unit?.toLowerCase() ?? 'each'
  if (['g', 'mg', 'kg', 'lb', 'oz'].includes(u)) return 'weight'
  if (['ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'pt', 'qt', 'gal'].includes(u)) return 'volume'
  return 'count'
}

/** Returns the valid Count UOM options for a given base unit */
export function compatibleCountUnits(baseUnit: string): string[] {
  const dim = getUnitDimension(baseUnit)
  if (dim === 'weight') return [...WEIGHT_COUNT_UOMS, 'batch']
  if (dim === 'volume') return [...VOLUME_COUNT_UOMS, 'batch']
  return [...EACH_COUNT_UOMS]
}

// Maps every spelling/abbreviation an invoice might use → one canonical token,
// so pack formats are comparable and cost conversion always resolves. Keeps
// distinct units within a dimension (g≠kg≠lb); only collapses spelling/case
// (GR/GRAM→g, LTR/LT/LITRE→l, KG→kg, EA/CT/PC→each…).
const UOM_CANON: Record<string, string> = {
  // weight
  g: 'g', gr: 'g', grm: 'g', gm: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  mg: 'mg',
  // volume
  ml: 'ml', mls: 'ml', milliliter: 'ml', millilitre: 'ml',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l',
  cl: 'cl', dl: 'dl', gal: 'gal', gallon: 'gal',
  floz: 'fl oz', 'fl oz': 'fl oz', 'fl.oz': 'fl oz',
  // count
  each: 'each', ea: 'each', ct: 'each', cnt: 'each', count: 'each',
  pc: 'each', pcs: 'each', piece: 'each', pieces: 'each',
  un: 'each', unit: 'each', units: 'each',
}

/** Normalize a unit string to its canonical token (case/abbreviation-insensitive). */
export function canonicalUom(uom: string | null | undefined): string {
  if (!uom) return ''
  const k = uom.trim().toLowerCase().replace(/\.$/, '')
  return UOM_CANON[k] ?? k
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
    const WV = ['g', 'mg', 'kg', 'lb', 'oz', 'ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
    const rateUnit = WV.includes((packUOM ?? '').toLowerCase()) ? packUOM : 'kg'
    const conv = getUnitConv(rateUnit)
    return conv > 0 ? purchasePrice / conv : 0
  }
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

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
  const q = qtyUOM?.toLowerCase() ?? ''
  const p = packUOM?.toLowerCase() ?? ''
  const weightUnits = ['g', 'mg', 'kg', 'lb', 'oz']
  const volumeUnits = ['ml', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
  if (weightUnits.includes(q)) return 'g'
  if (volumeUnits.includes(q)) return 'ml'
  // Only infer base unit from packUOM when an actual weight/volume per-each was entered
  if (packSize !== undefined && packSize <= 0) return 'each'
  if (weightUnits.includes(p)) return 'g'
  if (volumeUnits.includes(p)) return 'ml'
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
  const weightUnits = ['g', 'kg', 'lb', 'oz', 'mg']
  const volumeUnits = ['ml', 'l', 'cl', 'dl', 'fl oz', 'cup', 'tsp', 'tbsp']
  const isWeightQty = weightUnits.includes(qtyUOM) || volumeUnits.includes(qtyUOM)

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
