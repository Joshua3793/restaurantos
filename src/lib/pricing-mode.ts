import { DIMENSION_BASE, type Dimension, type Pricing } from '@/lib/item-model'

/**
 * Switch a price between "Per pack" and "Per unit (rate)" WITHOUT losing the
 * number: PACK $50 → RATE 50 per the dimension's first unit (g / ml / each —
 * the first option of the editor's "Per" list); RATE $3.49/lb → PACK $3.49.
 * The old toggle reset to 0, so one mis-tap saved a $0 item. Pure — the drawer
 * and the other chain editors call it from `PricingEditor`.
 */
export function carryPricingMode(pricing: Pricing, mode: 'PACK' | 'RATE', dimension: Dimension): Pricing {
  if (mode === pricing.mode) return pricing
  const raw = pricing.mode === 'PACK' ? pricing.purchasePrice : pricing.rate
  const n = Number.isFinite(Number(raw)) ? Number(raw) : 0
  return mode === 'PACK'
    ? { mode: 'PACK', purchasePrice: n }
    : { mode: 'RATE', rate: n, rateUnit: DIMENSION_BASE[dimension] }
}
