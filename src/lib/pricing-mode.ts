import type { Dimension, Pricing } from '@/lib/item-model'

// The unit a cook says a rate in: kg of flour, litres of milk, each egg.
const EVERYDAY_RATE_UNIT: Record<Dimension, string> = { MASS: 'kg', VOLUME: 'l', COUNT: 'each' }

/**
 * Switch a price between "Per pack" and "Per unit (rate)" WITHOUT losing the
 * number: PACK $50 → RATE 50 per the dimension's everyday unit (kg / l / each); RATE $3.49/lb → PACK $3.49.
 * The old toggle reset to 0, so one mis-tap saved a $0 item. Pure — the drawer
 * and the other chain editors call it from `PricingEditor`.
 */
export function carryPricingMode(pricing: Pricing, mode: 'PACK' | 'RATE', dimension: Dimension): Pricing {
  if (mode === pricing.mode) return pricing
  const raw = pricing.mode === 'PACK' ? pricing.purchasePrice : pricing.rate
  const n = Number.isFinite(Number(raw)) ? Number(raw) : 0
  return mode === 'PACK'
    ? { mode: 'PACK', purchasePrice: n }
    : { mode: 'RATE', rate: n, rateUnit: EVERYDAY_RATE_UNIT[dimension] }
}
