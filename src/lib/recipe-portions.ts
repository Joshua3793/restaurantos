import { convertQty } from './uom'

/**
 * Portions per batch with the portion size converted into the yield unit FIRST.
 *
 * `baseYieldQty` is denominated in `yieldUnit` and `portionSize` in
 * `portionUnit` — dividing them raw treats a 40 g portion of a 3 kg batch as
 * 3/40 = 0.075 portions instead of 75. Every portions-per-batch computation in
 * the app must go through here so the division happens in one unit space.
 *
 * A null/empty `portionUnit` falls back to `yieldUnit` (the UI's default).
 * Cross-dimension pairs (e.g. `each` portions of a kg yield) pass through 1:1,
 * matching convertQty's app-wide convention. Returns null when either quantity
 * is missing or non-positive — callers that historically defaulted to one
 * portion per batch should apply `?? 1`.
 */
export function portionsPerBatch(
  baseYieldQty: number,
  yieldUnit: string,
  portionSize: number | null | undefined,
  portionUnit: string | null | undefined,
): number | null {
  const size = portionSize != null ? Number(portionSize) : null
  if (size === null || !(size > 0) || !(baseYieldQty > 0)) return null
  const sizeInYield = convertQty(size, portionUnit || yieldUnit, yieldUnit)
  return sizeInYield > 0 ? baseYieldQty / sizeInYield : null
}
