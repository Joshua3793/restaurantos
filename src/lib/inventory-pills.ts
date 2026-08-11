/**
 * Inventory status pills — the predicate behind the "Counted / Not counted /
 * High value / Out of stock / Low stock" chips on /inventory.
 *
 * Pure and shared: the page filters rows with it and the xlsx export applies the
 * same pill, so a filtered export cannot disagree with the screen that produced
 * it. `now` is injectable so the 7-day window is testable.
 *
 * These predicates read THEORETICAL stock on purpose, even in the Stock in Hand
 * view. "Out of stock" and "Low stock" drive reordering, and reordering must be
 * based on what is actually left, not on what was last counted.
 */
import { convertBaseToCountUom } from './count-uom'

export type InventoryPill =
  | 'all' | 'counted' | 'notCounted' | 'highValue' | 'outOfStock' | 'lowStock'

export const INVENTORY_PILLS: InventoryPill[] =
  ['all', 'counted', 'notCounted', 'highValue', 'outOfStock', 'lowStock']

export const PILL_LABELS: Record<InventoryPill, string> = {
  all: 'All items',
  counted: 'Counted',
  notCounted: 'Not counted',
  highValue: 'High value',
  outOfStock: 'Out of stock',
  lowStock: 'Low stock',
}

/** The fields a pill predicate needs. Both an API row and a Prisma row satisfy it. */
export interface PillItem {
  lastCountDate?: string | Date | null
  pricePerBaseUnit: number | string
  theoreticalStock?: number | string | null
  stockOnHand?: number | string | null
  parLevel?: number | null
  baseUnit: string
  countUnit?: string | null
  dimension: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  packChain: any
}

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Theoretical on-hand in base units, matching the list API's fallback order. */
function effStock(item: PillItem): number {
  if (item.theoreticalStock !== null && item.theoreticalStock !== undefined) {
    return num(item.theoreticalStock)
  }
  return num(item.stockOnHand)
}

/** Theoretical on-hand converted to the item's count UOM — par is in count units. */
function displayStock(item: PillItem): number {
  return convertBaseToCountUom(effStock(item), item.countUnit || item.baseUnit, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dimension: item.dimension as any,
    baseUnit: item.baseUnit,
    packChain: item.packChain,
    countUnit: item.countUnit ?? undefined,
  })
}

/** Counted within the last 7 days. */
export function isCountedThisWeek(item: PillItem, now: Date = new Date()): boolean {
  if (!item.lastCountDate) return false
  const weekAgo = new Date(now)
  weekAgo.setDate(weekAgo.getDate() - 7)
  return new Date(item.lastCountDate) >= weekAgo
}

export function matchesPill(
  pill: InventoryPill,
  item: PillItem,
  now: Date = new Date(),
): boolean {
  switch (pill) {
    case 'counted':    return isCountedThisWeek(item, now)
    case 'notCounted': return !isCountedThisWeek(item, now)
    case 'highValue':  return num(item.pricePerBaseUnit) > 0.01
    case 'outOfStock': return effStock(item) <= 0
    case 'lowStock':
      return item.parLevel != null
        && displayStock(item) > 0
        && displayStock(item) < item.parLevel
    default: return true
  }
}
