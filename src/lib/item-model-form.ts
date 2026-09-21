import { getUnitConv, isMeasuredUnit } from './utils'
import { dimensionOf, type PackLink, type Pricing, type Dimension } from './item-model'

/**
 * The legacy field shape that defines an item's purchase structure. Shared by
 * the inventory create/update routes, the CSV importer, and the one-time
 * backfill so chain reconstruction lives in exactly one place.
 */
export interface ItemFormInput {
  purchaseUnit: string
  purchasePrice: number
  qtyPerPurchaseUnit: number
  qtyUOM: string
  innerQty: number | null
  packSize: number
  packUOM: string
  priceType: 'CASE' | 'UOM'
  countUOM: string
  /** When set, the dimension is taken from the item's existing baseUnit rather
   *  than inferred from the form units (used by the backfill to honour the
   *  already-stored, possibly non-SI, baseUnit). */
  baseUnit?: string
}

export interface ChainShape {
  dimension: Dimension
  baseUnit: string
  packChain: PackLink[]
  pricing: Pricing
  countUnit: string
}

/**
 * Reconstruct the pack chain + pricing from the legacy fields such that
 * `pricePerBaseUnit(result)` reproduces `calcPricePerBaseUnit(...)` EXACTLY for
 * the same inputs. This is the parity contract — every branch of the legacy
 * formula has a matching chain shape here.
 *
 * Legacy `calcPricePerBaseUnit` divisors (from src/lib/utils.ts):
 *   • priceType UOM      → price / conv(rateUnit)            (rate per SI base)
 *   • qtyUOM measured    → qtyPer * conv(qtyUOM)
 *   • qtyUOM 'pack'+inner→ qtyPer * innerQty * packSize * conv(packUOM)
 *   • else               → qtyPer * packSize * conv(packUOM)
 */
export function formToChain(f: ItemFormInput): ChainShape {
  // Dimension: prefer an explicit baseUnit (backfill), else infer from units.
  const dimension: Dimension = f.baseUnit
    ? dimensionOf(f.baseUnit)
    : isMeasuredUnit(f.qtyUOM)
      ? dimensionOf(f.qtyUOM)
      : isMeasuredUnit(f.packUOM)
        ? dimensionOf(f.packUOM)
        : 'COUNT'
  const baseUnit = dimension === 'MASS' ? 'g' : dimension === 'VOLUME' ? 'ml' : 'each'
  const top = f.purchaseUnit || 'case'
  const packConv = getUnitConv(f.packUOM)
  const qtyPer = Number(f.qtyPerPurchaseUnit) || 1
  const packSize = Number(f.packSize) || 1

  // RATE (catchweight / per-weight): legacy priceType UOM.
  if (f.priceType === 'UOM') {
    const rateUnit = isMeasuredUnit(f.packUOM)
      ? f.packUOM
      : dimension === 'MASS' ? 'kg' : dimension === 'VOLUME' ? 'l' : 'each'
    return {
      dimension, baseUnit, countUnit: f.countUOM || 'each',
      // single nominal level so cases can still be counted; per = nominal base content
      packChain: [{ unit: top, per: qtyPer * packSize * packConv || 1 }],
      pricing: { mode: 'RATE', rate: Number(f.purchasePrice) || 0, rateUnit },
    }
  }

  // PACK: reproduce the divisor branch exactly.
  let packChain: PackLink[]
  if (isMeasuredUnit(f.qtyUOM)) {
    packChain = [{ unit: top, per: qtyPer * getUnitConv(f.qtyUOM) }]
  } else if (f.qtyUOM === 'pack' && f.innerQty != null) {
    packChain = [
      { unit: top, per: qtyPer },
      { unit: 'pack', per: Number(f.innerQty) },
      { unit: 'each', per: packSize * packConv },
    ]
  } else {
    packChain = [
      { unit: top, per: qtyPer },
      { unit: 'each', per: packSize * packConv },
    ]
  }
  return {
    dimension, baseUnit, packChain,
    pricing: { mode: 'PACK', purchasePrice: Number(f.purchasePrice) || 0 },
    countUnit: f.countUOM || 'each',
  }
}

/**
 * Whether an inventory PUT should keep the STORED pricing instead of the
 * incoming payload's — because the incoming pricing looks like an unmodified
 * round-trip of a bridged RATE, not a deliberate re-price.
 *
 * A bridged RATE (e.g. `{ mode: 'RATE', rate: 5.25, rateUnit: 'lb' }` on an
 * `each` item) can be LOADED into the edit form untouched, but the form's rate-
 * unit dropdown only offers units in the item's own dimension (`DIM_UNITS` in
 * ItemChainEditor.tsx — `['each']` for a COUNT item), so it can never faithfully
 * redisplay `'lb'`. If the user saves without touching price at all, the safe
 * thing is to keep the stored pricing verbatim (including its correct
 * `rateUnit`) rather than trust whatever the broken dropdown round-tripped.
 *
 * The decision compares only the fields a human edits to change the PRICE
 * itself: `mode`, and `rate` (RATE) or `purchasePrice` (PACK). `rateUnit` is
 * deliberately EXCLUDED from the comparison — it's exactly the field this form
 * cannot round-trip for a bridged rate, so a changed `rateUnit` alone (with the
 * same rate number) is a form artifact, not an edit. A changed rate/
 * purchasePrice number, or a changed mode, means the user really did re-price
 * the item (by case, on purpose) — their edit wins.
 *
 * Only meaningful when the STORED pricing is itself a bridged RATE (the caller
 * checks `dimensionOf(stored.rateUnit) !== item.dimension` first); returns
 * false for anything else so callers can call it unconditionally.
 */
export function keepBridgedRate(stored: Pricing, incoming: Pricing): boolean {
  if (stored.mode !== 'RATE') return false
  if (incoming.mode !== 'RATE') return false
  return Number(incoming.rate) === Number(stored.rate)
}
