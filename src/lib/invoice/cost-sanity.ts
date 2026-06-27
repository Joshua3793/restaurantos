/**
 * Guardrail before a bridge factor is offered as a one-tap auto-confirm: the
 * reconciled $/base-unit must land within ±band of the item's current spine
 * $/base-unit. A factor that swings cost outside the band is held back as
 * "this looks off — check it" (the resolver downgrades auto-derive → ask),
 * even when the factor was derivable. When there's no current cost to compare
 * against (new/unpriced item), there's nothing to sanity-check → allow.
 */
export function costDriftWithinBand(
  reconciledPpb: number,
  currentPpb: number,
  band = 0.25,
): boolean {
  if (!(currentPpb > 0)) return true
  return Math.abs(reconciledPpb - currentPpb) / currentPpb <= band
}
