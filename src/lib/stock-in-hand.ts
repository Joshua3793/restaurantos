/**
 * Stock in Hand — the last PHYSICALLY counted quantity, with no theoretical
 * movement applied.
 *
 * Deliberately pure (no Prisma, no React): the inventory page and the xlsx
 * export both call these functions, so the on-screen KPI strip and the KPI
 * sheet cannot drift apart. Two copies of this arithmetic would eventually
 * disagree, and the spreadsheet is the copy that leaves the building.
 *
 * Quantities here are in BASE units. Converting to a count UOM for display is
 * the caller's job (convertBaseToCountUom); value must NOT be converted —
 * pricePerBaseUnit is already per base unit.
 */
import { matchesPill, type InventoryPill, type PillItem } from './inventory-pills'
import { resolveCountUom } from './count-uom'

/** The fields Stock in Hand needs. Every row comes from fetchInventoryList. */
export interface StockInHandItem {
  /**
   * Last physically counted quantity (base units) for the revenue centres the row
   * was fetched under; null = never counted in that scope.
   *
   * Required, not optional, and deliberately NOT falling back to the item's
   * `lastCountQty`: that column is a single global field which an RC-scoped count
   * overwrites without touching any other RC's stock, so falling back to it would
   * quietly restore the bug this field exists to fix (a CATERING view reporting
   * KITCHEN's counts). A caller that cannot supply it has no counted basis to show.
   */
  countedQtyScoped: number | string | null
  /** ISO date of the oldest count behind countedQtyScoped; null when never counted. */
  countedDateScoped?: string | Date | null
  pricePerBaseUnit: number | string
  theoreticalStock?: number | string | null
  stockOnHand?: number | string | null
}

/** Prisma Decimals arrive as strings over JSON — normalize at the boundary. */
function num(v: number | string | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Last counted quantity in BASE units, for the scope the row was fetched under.
 * `null` means never counted here — which is NOT the same as a counted zero, and
 * the two must stay distinguishable.
 */
export function stockInHandQty(item: StockInHandItem): number | null {
  return num(item.countedQtyScoped)
}

/** The date that counted quantity is as of. Null when never counted in scope. */
export function stockInHandDate(item: StockInHandItem): string | null {
  if (!item.countedDateScoped) return null
  const d = new Date(item.countedDateScoped)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Last counted quantity valued at the CURRENT price. Never counted → 0. */
export function stockInHandValue(item: StockInHandItem): number {
  const qty = stockInHandQty(item)
  if (qty === null) return 0
  return qty * (num(item.pricePerBaseUnit) ?? 0)
}

/** Theoretical on-hand in BASE units, falling back the way the list API does. */
export function theoreticalQty(item: StockInHandItem): number {
  return num(item.theoreticalStock) ?? num(item.stockOnHand) ?? 0
}

export interface StockInHandKpis {
  /** Σ lastCountQty × current pricePerBaseUnit */
  value: number
  /** items with a count */
  counted: number
  /** items in view */
  total: number
  /** items with no lastCountQty */
  neverCounted: number
  /** earliest lastCountDate among counted items, ISO string */
  oldestCountDate: string | null
  /** Σ theoretical stock × current pricePerBaseUnit */
  theoreticalValue: number
  /** theoreticalValue − value: how much of the headline is unconfirmed */
  unverifiedMovement: number
}

export function stockInHandKpis(items: StockInHandItem[]): StockInHandKpis {
  let value = 0
  let counted = 0
  let theoreticalValue = 0
  let oldestMs: number | null = null
  let oldestCountDate: string | null = null

  for (const item of items) {
    const ppb = num(item.pricePerBaseUnit) ?? 0
    value += stockInHandValue(item)
    theoreticalValue += theoreticalQty(item) * ppb

    if (stockInHandQty(item) === null) continue
    counted++

    const iso = stockInHandDate(item)
    if (!iso) continue
    const ms = new Date(iso).getTime()
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms
      oldestCountDate = iso
    }
  }

  return {
    value,
    counted,
    total: items.length,
    neverCounted: items.length - counted,
    oldestCountDate,
    theoreticalValue,
    unverifiedMovement: theoreticalValue - value,
  }
}

/**
 * Normalize each row's countUnit through resolveCountUom — the same repair the
 * page's normalizeItem applies to every row the moment the list lands — and
 * ONLY THEN apply the status-pill filter. Order matters: matchesPill's lowStock
 * branch converts theoretical stock into count units before comparing it to
 * par, so filtering against the raw stored countUnit can select a different
 * row set than the screen did. A stored unit the chain can't resolve (an empty
 * string, or a cross-dimension leftover like 'ml' on a MASS item) measures in
 * BASE units on the raw path instead of the resolved count unit — e.g. 12,500 g
 * vs a par of 20 kg reads as "not low" unresolved and "low" resolved.
 *
 * Exported so a test can prove the ordering is load-bearing without pulling in
 * Prisma or Next: reverting this function to filter-then-normalize (or to skip
 * the resolveCountUom step) must make that test fail.
 */
export function selectStockInHandRows<T extends PillItem>(
  rows: T[],
  pill: InventoryPill,
  now: Date = new Date(),
): T[] {
  const normalized = rows.map(r => ({
    ...r,
    countUnit: resolveCountUom({
      dimension: r.dimension,
      baseUnit: r.baseUnit,
      packChain: r.packChain,
      countUnit: r.countUnit ?? undefined,
    }),
  }))
  return normalized.filter(r => matchesPill(pill, r, now))
}
