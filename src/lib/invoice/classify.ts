// The four-way verdict that replaces the hasDimensionConflict boolean. Reads the
// invoice line + linked item and decides whether the unit gap is a no-op
// (IDENTICAL), a recoverable bridge (DENSITY_BRIDGE / PACK_BRIDGE) pre-filled to
// a trust tier, or a genuine bad match (TRUE_CONFLICT) that should re-link first.
import type { ScanItem } from '@/components/invoices/types'
import { buildOffer, scanItemToOfferInput } from './offer'
import { dimensionOf, eachMeasureOf, densityOf } from '@/lib/item-model'
import { lookupDensity } from '@/lib/density'

export type Tier = 'auto' | 'suggest' | 'ask'
export type DimRelationship =
  | { verdict: 'IDENTICAL' }
  | { verdict: 'DENSITY_BRIDGE'; tier: Tier; density: number; source: 'line' | 'library' | 'fallback' }
  | { verdict: 'PACK_BRIDGE'; tier: Tier; perEach: { qty: number; unit: string } | null }
  | { verdict: 'TRUE_CONFLICT' }

const isMeasured = (d: string) => d === 'MASS' || d === 'VOLUME'

/** The units a count↔measured bridge may be expressed in, per measured dimension.
 *  A bridge answers "how much does ONE each weigh / hold", so its unit ALWAYS
 *  belongs to the measured side of the gap. Note `oz` is weight — the volume
 *  ounce is `fl oz`; offering plain `oz` on a volume bridge stores a mass unit
 *  that can never span the gap. */
export const BRIDGE_UNITS: Record<'MASS' | 'VOLUME', string[]> = {
  MASS:   ['lb', 'kg', 'g', 'oz'],
  VOLUME: ['ml', 'l', 'fl oz'],
}

/** The unit list to offer for a bridge on `dim`. */
export function bridgeUnitOptions(dim: 'MASS' | 'VOLUME' | 'COUNT'): string[] {
  return dim === 'COUNT' ? [] : BRIDGE_UNITS[dim]
}

/** True when `unit` can express a bridge on `dim`. A count unit ('each', 'cs')
 *  never can, and neither can a unit from the other measured dimension — the
 *  inventory route drops both, so saving one is a silent no-op that leaves the
 *  line stuck on the same issue. */
export function isValidBridgeUnit(unit: string | null | undefined, dim: 'MASS' | 'VOLUME' | 'COUNT'): boolean {
  if (!unit || dim === 'COUNT') return false
  return dimensionOf(String(unit).trim().toLowerCase()) === dim
}

export function classifyDimensionRelationship(item: ScanItem): DimRelationship {
  if (!item.matchedItem) return { verdict: 'IDENTICAL' } // unlinked is a separate issue
  const offer = buildOffer(scanItemToOfferInput(item))
  const md = item.matchedItem as {
    dimension?: string; baseUnit?: string; itemName?: string
    eachMeasureQty?: unknown; eachMeasureUnit?: string | null
    densityGPerMl?: unknown
  }
  const itemDim = (md.dimension as 'MASS' | 'VOLUME' | 'COUNT' | undefined) ?? dimensionOf(md.baseUnit ?? 'each')

  if (offer.dimension === itemDim) return { verdict: 'IDENTICAL' }

  // weight ↔ volume → density bridge
  if (isMeasured(offer.dimension) && isMeasured(itemDim)) {
    // Already bridged: the item carries a stored density → costing/approve apply
    // it, nothing to resolve.
    if (densityOf(md)) return { verdict: 'IDENTICAL' }
    // A line carrying BOTH a weight and a volume gives a measured density (auto).
    // Otherwise default from the library by name (suggest); no match → 1.0 flag.
    const hit = lookupDensity(md.itemName ?? '')
    return {
      verdict: 'DENSITY_BRIDGE',
      tier: hit.source === 'fallback' ? 'ask' : 'suggest',
      density: hit.gPerMl,
      source: hit.source,
    }
  }

  // count ↔ measured → pack bridge (existing eachMeasure machinery)
  if (offer.dimension === 'COUNT' || itemDim === 'COUNT') {
    const stored = eachMeasureOf(md)
    // Already bridged: a stored each-measure spanning this gap resolves it
    // (same span test the old predicate used).
    if (stored && (
      (itemDim === 'COUNT' && dimensionOf(stored.unit) === offer.dimension) ||
      (offer.dimension === 'COUNT' && dimensionOf(stored.unit) === itemDim)
    )) return { verdict: 'IDENTICAL' }
    // The bridge is always expressed on the MEASURED side of the gap: when the
    // item is counted the invoice is the measured one, and vice-versa.
    const measuredDim = itemDim === 'COUNT' ? offer.dimension : itemDim
    // Auto when the line itself carries pack count + per-each measure — but only
    // when that pack unit actually measures the gap. A count-priced line on a
    // measured item (pack "1 each") tells us nothing about what one each weighs,
    // and pre-filling 'each' produces a Save the inventory route silently drops.
    const packSize = item.invoicePackSize != null ? Number(item.invoicePackSize) : null
    const packUnit = (item.invoicePackUOM ?? item.rateUOM ?? '')?.toLowerCase() || null
    if (packSize && packSize > 0 && packUnit && isValidBridgeUnit(packUnit, measuredDim)) {
      return { verdict: 'PACK_BRIDGE', tier: 'auto', perEach: { qty: packSize, unit: packUnit } }
    }
    // A stored each-measure still beats asking — but only if it measures THIS
    // gap (a stored gram bridge is no prefill for a litre invoice).
    if (stored && isValidBridgeUnit(stored.unit, measuredDim)) {
      return { verdict: 'PACK_BRIDGE', tier: 'suggest', perEach: stored }
    }
    if (item.matchConfidence === 'HIGH') return { verdict: 'PACK_BRIDGE', tier: 'ask', perEach: null }
    return { verdict: 'TRUE_CONFLICT' }
  }

  return { verdict: 'TRUE_CONFLICT' }
}

/** True for a recoverable bridge (density or pack) — surfaces as a blue "to
 *  bridge" issue, not a red conflict. */
export function isBridgeable(item: ScanItem): boolean {
  const v = classifyDimensionRelationship(item).verdict
  return v === 'DENSITY_BRIDGE' || v === 'PACK_BRIDGE'
}
