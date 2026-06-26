import { getUnitConv, getUnitDimension } from './utils'

export type Dimension = 'MASS' | 'VOLUME' | 'COUNT'
export type PackLink = { unit: string; per: number }
/** Canonical measure of ONE base count unit, e.g. { qty: 1100, unit: 'g' } = 1 each. */
export type EachMeasure = { qty: number; unit: string }
export type Pricing =
  | { mode: 'PACK'; purchasePrice: number }
  | { mode: 'RATE'; rate: number; rateUnit: string }

/** Item facts the pricing engine needs. Decimal fields arrive as strings from
 *  Prisma JSON responses — callers must Number()-coerce. */
export interface ChainItem {
  dimension: Dimension
  baseUnit: string
  packChain: PackLink[]
  pricing: Pricing
  countUnit?: string
  stockOnHand?: number
  /** Present only on COUNT items with a count↔weight bridge configured. */
  eachMeasure?: EachMeasure | null
}

export const DIMENSION_BASE: Record<Dimension, string> = { MASS: 'g', VOLUME: 'ml', COUNT: 'each' }

/** Read the count↔weight bridge off an item row. Null unless the item is COUNT
 *  and BOTH columns are populated. Decimal arrives as string from Prisma JSON. */
export function eachMeasureOf(row: {
  dimension?: string | null
  eachMeasureQty?: unknown
  eachMeasureUnit?: string | null
}): EachMeasure | null {
  if ((row.dimension ?? 'COUNT') !== 'COUNT') return null
  const qty = row.eachMeasureQty != null ? Number(row.eachMeasureQty) : NaN
  const unit = (row.eachMeasureUnit ?? '').trim()
  if (!Number.isFinite(qty) || qty <= 0 || !unit) return null
  return { qty, unit }
}

/** Map a unit string to a Dimension via the canonical uom.ts table. */
export function dimensionOf(unit: string): Dimension {
  const d = getUnitDimension(unit)
  return d === 'weight' ? 'MASS' : d === 'volume' ? 'VOLUME' : 'COUNT'
}

/** base units in ONE top (purchase) unit = product of every link's `per`. */
export function basePerPurchase(chain: PackLink[]): number {
  return (chain ?? []).reduce((acc, l) => acc * Number(l?.per || 0), 1)
}

/** base units contained in 1 of EACH level — running product up the chain. */
export function levelBaseUnits(chain: PackLink[]): Record<string, number> {
  const out: Record<string, number> = {}
  let running = 1
  for (let i = (chain?.length ?? 0) - 1; i >= 0; i--) {
    running *= Number(chain[i].per || 0)
    out[chain[i].unit] = running
  }
  return out
}

/** base units per 1 of ANY chosen unit (a named chain level OR a same-dim unit). */
export function basePerUnit(item: ChainItem, unit: string): number {
  const lv = levelBaseUnits(item.packChain)
  if (unit in lv) return lv[unit]
  if (dimensionOf(unit) === item.dimension) return getUnitConv(unit)
  return 1
}

/** THE algorithm — pure, total, branch-free except the explicit pricing mode. */
export function pricePerBaseUnit(item: ChainItem): number {
  const p = item.pricing
  if (p?.mode === 'RATE') {
    const conv = getUnitConv(p.rateUnit)
    return conv > 0 ? Number(p.rate || 0) / conv : 0
  }
  const denom = basePerPurchase(item.packChain)
  return denom > 0 ? Number((p as { purchasePrice?: number })?.purchasePrice || 0) / denom : 0
}

/** Back-compat for the deleted column's old meaning at a count unit. */
export const conversionFactor = (item: ChainItem, countUnit = item.countUnit ?? 'each') =>
  basePerUnit(item, countUnit)

export const stockValue = (item: ChainItem) => Number(item.stockOnHand || 0) * pricePerBaseUnit(item)
export const countQty = (item: ChainItem, countUnit = item.countUnit ?? 'each') =>
  Number(item.stockOnHand || 0) / basePerUnit(item, countUnit)

/** Recipe line cost: qty of `unit` (same dimension) → cost. */
export const lineCost = (item: ChainItem, qty: number, unit: string) =>
  qty * getUnitConv(unit) * pricePerBaseUnit(item)

/** Invariants. Returns [] when valid. */
export function validateChainItem(item: ChainItem): string[] {
  const errs: string[] = []
  const chain = item.packChain ?? []
  if (chain.length < 1) errs.push('chain must have at least one link')
  if (chain.some((l) => !(Number(l?.per) > 0))) errs.push('every per must be > 0')
  if (item.dimension !== 'COUNT' && dimensionOf(item.baseUnit) !== item.dimension)
    errs.push('baseUnit dimension must equal item dimension')
  if (item.countUnit) {
    const lv = levelBaseUnits(chain)
    if (!(item.countUnit in lv) && dimensionOf(item.countUnit) !== item.dimension)
      errs.push('countUnit must be a chain level or a same-dimension unit')
  }
  if (item.pricing?.mode === 'RATE' && dimensionOf(item.pricing.rateUnit) !== item.dimension)
    errs.push('RATE.rateUnit must share the item dimension')
  return errs
}

/** Prisma select fragment every cost reader uses to load pricing facts. */
export const PRICING_SELECT = {
  dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true,
  eachMeasureQty: true, eachMeasureUnit: true,
} as const

/** Coerce a Prisma row (Json columns may be untyped) into a ChainItem. */
export function asChainItem(row: {
  dimension: string; baseUnit: string; packChain: unknown; pricing: unknown
  countUnit?: string; stockOnHand?: unknown
  eachMeasureQty?: unknown; eachMeasureUnit?: string | null
}): ChainItem {
  return {
    dimension: row.dimension as Dimension,
    baseUnit: row.baseUnit,
    packChain: (row.packChain as PackLink[]) ?? [],
    pricing: (row.pricing as Pricing) ?? { mode: 'PACK', purchasePrice: 0 },
    countUnit: row.countUnit,
    stockOnHand: row.stockOnHand != null ? Number(row.stockOnHand) : 0,
    eachMeasure: eachMeasureOf(row),
  }
}

/**
 * Attach a COMPUTED `pricePerBaseUnit` to an item row for API responses, so
 * client components that read `item.pricePerBaseUnit` keep working after the
 * stored column is dropped. The returned value is derived from the chain — it is
 * NOT a column read. Spread `...PRICING_SELECT` into the row's select first.
 */
export function withPpb<T extends Parameters<typeof asChainItem>[0]>(row: T): T & { pricePerBaseUnit: number } {
  return { ...row, pricePerBaseUnit: pricePerBaseUnit(asChainItem(row)) }
}
