import type { Dimension } from '@/lib/item-model'

/**
 * Adjust a per-base-unit price when a measured invoice RATE crosses weight↔volume
 * relative to the item's base unit. `ppb` is $ per the RATE's canonical base
 * ($/g when the rate is a mass unit, $/ml when it's a volume unit). Returns $ per
 * the ITEM's base unit, using `density` (g/ml). Non-cross or no density → unchanged.
 *   rate MASS  → item VOLUME:  $/g × (g/ml) = $/ml
 *   rate VOLUME→ item MASS:    $/ml ÷ (g/ml) = $/g
 */
export function densityCrossedPpb(
  ppb: number, rateDim: Dimension, baseDim: Dimension, density: number,
): number {
  if (!(density > 0)) return ppb
  if (rateDim === 'MASS' && baseDim === 'VOLUME') return ppb * density
  if (rateDim === 'VOLUME' && baseDim === 'MASS') return ppb / density
  return ppb
}
