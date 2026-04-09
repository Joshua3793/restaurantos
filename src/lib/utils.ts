// Unit conversion factors — all weight → g, all volume → ml, count → 1
export const UNIT_CONV: Record<string, number> = {
  // weight
  g: 1, mg: 0.001, kg: 1000, lb: 453.592, oz: 28.3495,
  // volume
  ml: 1, l: 1000, lt: 1000, 'fl oz': 29.5735, tsp: 4.92892, tbsp: 14.7868, cup: 236.588, gal: 3785.41,
  // count
  each: 1, ea: 1,
}

export const PACK_UOMS = ['each', 'g', 'kg', 'lb', 'oz', 'ml', 'l'] as const
export const COUNT_UOMS = ['each', 'pkg', 'case', 'kg', 'lb', 'g', 'l', 'ml', 'oz'] as const

export function getUnitConv(uom: string): number {
  return UNIT_CONV[uom?.toLowerCase()] ?? 1
}

/** Price per base unit (g, ml, or each) based on purchase structure */
export function calcPricePerBaseUnit(
  purchasePrice: number,
  qtyPerCase: number,
  packSize: number,
  packUOM: string,
): number {
  const divisor = qtyPerCase * packSize * getUnitConv(packUOM)
  return divisor > 0 ? purchasePrice / divisor : 0
}

/** Derive the base unit (g / ml / each) from the pack UOM */
export function deriveBaseUnit(packUOM: string): string {
  const w = ['g', 'mg', 'kg', 'lb', 'oz']
  const v = ['ml', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
  const lower = packUOM?.toLowerCase() ?? 'each'
  if (w.includes(lower)) return 'g'
  if (v.includes(lower)) return 'ml'
  return 'each'
}

/** Conversion factor: how many base units equal 1 counting unit (BU × Count UOM) */
export function calcConversionFactor(
  countUOM: string,
  qtyPerCase: number,
  packSize: number,
  packUOM: string,
): number {
  const packBaseUnits = packSize * getUnitConv(packUOM)
  const lower = countUOM?.toLowerCase() ?? 'each'
  if (lower in UNIT_CONV) return UNIT_CONV[lower]  // kg→1000, lb→453.592, etc.
  if (lower === 'case') return qtyPerCase * packBaseUnits
  if (lower === 'pkg')  return packBaseUnits
  return 1
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
}

export function formatUnitPrice(amount: number): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(amount)
}

export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

export const CATEGORY_COLORS: Record<string, string> = {
  BREAD: 'bg-amber-100 text-amber-800',
  DAIRY: 'bg-blue-100 text-blue-800',
  DRY: 'bg-yellow-100 text-yellow-800',
  FISH: 'bg-cyan-100 text-cyan-800',
  MEAT: 'bg-red-100 text-red-800',
  PREPD: 'bg-purple-100 text-purple-800',
  PROD: 'bg-green-100 text-green-800',
  CHM: 'bg-gray-100 text-gray-800',
}

export const CATEGORIES = ['BREAD', 'DAIRY', 'DRY', 'FISH', 'MEAT', 'PREPD', 'PROD', 'CHM'] as const
export const BASE_UNITS = ['g', 'ml', 'each', 'kg', 'l'] as const
export const INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETE'] as const
export const WASTAGE_REASONS = ['SPOILAGE', 'OVERPRODUCTION', 'PREP_TRIM', 'BURNT', 'DROPPED', 'EXPIRED', 'STAFF_MEAL', 'UNKNOWN'] as const
export const RECIPE_CATEGORIES = ['APPETIZER', 'MAIN', 'DESSERT', 'BEVERAGE', 'SIDE', 'SAUCE', 'SOUP', 'SALAD', 'BREAD', 'OTHER'] as const
