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

/** The fields Stock in Hand needs. Both an API row and a Prisma row satisfy it. */
export interface StockInHandItem {
  lastCountQty?: number | string | null
  lastCountDate?: string | Date | null
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
 * Last counted quantity in BASE units. `null` means never counted — which is
 * NOT the same as a counted zero, and the two must stay distinguishable.
 */
export function stockInHandQty(item: StockInHandItem): number | null {
  return num(item.lastCountQty)
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

    if (!item.lastCountDate) continue
    const d = new Date(item.lastCountDate)
    const ms = d.getTime()
    if (Number.isNaN(ms)) continue
    if (oldestMs === null || ms < oldestMs) {
      oldestMs = ms
      oldestCountDate = d.toISOString()
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
