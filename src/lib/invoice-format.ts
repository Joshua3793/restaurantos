export interface InvoiceFormat {
  packQty: number   // units per purchase (e.g. 4 for "4 jugs/crate")
  packSize: number  // size per unit (e.g. 4 for "4L/jug")
  packUOM: string   // unit of measure (e.g. "L", "kg", "each")
}

/**
 * Parse pack format from a product description string.
 * Handles patterns like:
 *   "4/4L"      → { packQty:4, packSize:4, packUOM:"l" }
 *   "6x500ml"   → { packQty:6, packSize:500, packUOM:"ml" }
 *   "2KG"       → { packQty:1, packSize:2, packUOM:"kg" }
 *   "6/12-ct"   → { packQty:6, packSize:12, packUOM:"each" }
 *   "24 count"  → { packQty:1, packSize:24, packUOM:"each" }
 *   "6x4"       → { packQty:6, packSize:4, packUOM:"each" }
 */
export function parseFormatFromDescription(description: string): InvoiceFormat | null {
  const lower = description.toLowerCase()

  // "4/4L" or "4/500ml" — qty / size + volume/weight UOM
  const slashVolumeMatch = lower.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (slashVolumeMatch) return { packQty: +slashVolumeMatch[1], packSize: +slashVolumeMatch[2], packUOM: slashVolumeMatch[3] }

  // "4x4L" or "6x500ml"
  const xVolumeMatch = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (xVolumeMatch) return { packQty: +xVolumeMatch[1], packSize: +xVolumeMatch[2], packUOM: xVolumeMatch[3] }

  // "6/12-ct", "6/12ct", "6/12 count" — qty / count
  const slashCountMatch = lower.match(/(\d+)\s*\/\s*(\d+)\s*[-\s]?(?:count|ct|pc|pcs|pieces?)\b/)
  if (slashCountMatch) return { packQty: +slashCountMatch[1], packSize: +slashCountMatch[2], packUOM: 'each' }

  // "6x4" or "6x12" with no UOM — treat as count packs
  const xCountMatch = lower.match(/(\d+)\s*x\s*(\d+)\b(?!\s*(?:l|ml|kg|g|lb|oz))/)
  if (xCountMatch) return { packQty: +xCountMatch[1], packSize: +xCountMatch[2], packUOM: 'each' }

  // "24 count", "24-ct", "12 each", "12 pc" — single count pack
  const singleCountMatch = lower.match(/(\d+)\s*[-\s]?(?:count|ct|pcs?|pieces?|each|ea)\b/)
  if (singleCountMatch) return { packQty: 1, packSize: +singleCountMatch[1], packUOM: 'each' }

  // "2KG", "500ML", "4L" — single volume/weight size, no multiplier
  const singleVolumeMatch = lower.match(/(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (singleVolumeMatch) return { packQty: 1, packSize: +singleVolumeMatch[1], packUOM: singleVolumeMatch[2] }

  return null
}

// ── Unit normalisation ──────────────────────────────────────────────────────
// Maps every unit label → its SI base (ml for volume, g for weight, each for count)
// and the factor needed to convert 1 of this unit into that base.
// e.g. 1 L = 1000 ml  →  factor = 1000
export const UNIT_SCALE: Record<string, { base: string; factor: number }> = {
  // Volume
  ml:       { base: 'ml', factor: 1 },
  milliliter: { base: 'ml', factor: 1 },
  l:        { base: 'ml', factor: 1000 },
  liter:    { base: 'ml', factor: 1000 },
  litre:    { base: 'ml', factor: 1000 },
  // Weight
  g:        { base: 'g',  factor: 1 },
  gram:     { base: 'g',  factor: 1 },
  kg:       { base: 'g',  factor: 1000 },
  kilogram: { base: 'g',  factor: 1000 },
  lb:       { base: 'g',  factor: 453.592 },
  lbs:      { base: 'g',  factor: 453.592 },
  oz:       { base: 'g',  factor: 28.3495 },
  ounce:    { base: 'g',  factor: 28.3495 },
  // Count
  each:     { base: 'each', factor: 1 },
  unit:     { base: 'each', factor: 1 },
  piece:    { base: 'each', factor: 1 },
  pc:       { base: 'each', factor: 1 },
}

/** Convert a price-per-unit to price-per-SI-base-unit. Returns null if unit unknown. */
export function toPricePerSIBase(pricePerUnit: number, unit: string): { price: number; base: string } | null {
  const scale = UNIT_SCALE[unit.toLowerCase()]
  if (!scale) return null
  return { price: pricePerUnit / scale.factor, base: scale.base }
}

/**
 * Compare two prices that may be in different but compatible units.
 * e.g. invoice: $19.96/kg  vs  inventory: $0.02/g  →  +0.2% diff
 *
 * Returns { pctDiff, invoicePPB, inventoryPPB, baseUnit } or null when
 * units are incompatible (e.g. kg vs ml).
 */
export function comparePricesNormalized(
  invoicePPU: number, invoiceUnit: string,
  inventoryPPU: number, inventoryUnit: string,
): {
  pctDiff: number
  invoicePPB: number     // invoice price per SI base unit
  inventoryPPB: number   // inventory price per SI base unit
  baseUnit: string       // common SI base (g / ml / each)
} | null {
  const invNorm  = toPricePerSIBase(invoicePPU,    invoiceUnit)
  const invtNorm = toPricePerSIBase(inventoryPPU,  inventoryUnit)
  if (!invNorm || !invtNorm || invNorm.base !== invtNorm.base) return null
  if (invtNorm.price <= 0) return null
  return {
    pctDiff:      Math.round(((invNorm.price - invtNorm.price) / invtNorm.price) * 10000) / 100,
    invoicePPB:   invNorm.price,
    inventoryPPB: invtNorm.price,
    baseUnit:     invNorm.base,
  }
}

/**
 * Given the invoice's per-unit price and format, return what the inventory's
 * purchasePrice should become (normalized to the inventory item's purchase format).
 *
 * e.g. invoice: $44.09 / 16L = $2.756/L = $0.002756/mL
 *      inventory: qtyPerPurchaseUnit=4, packSize=4, packUOM="L" → total 16L
 *      → newPurchasePrice = $0.002756/mL × 16,000 mL = $44.09
 */
export function calcNewPurchasePrice(
  invoicePPU: number,   // $/invoiceUnit
  invoiceUnit: string,
  invQtyPerPurchase: number,  // inventory qtyPerPurchaseUnit
  invPackSize: number,         // inventory packSize
  invPackUOM: string,          // inventory packUOM
): number | null {
  const invScale  = UNIT_SCALE[invoiceUnit.toLowerCase()]
  const invtScale = UNIT_SCALE[invPackUOM.toLowerCase()]
  if (!invScale || !invtScale || invScale.base !== invtScale.base) return null

  // Convert invoice price to per-SI-base, then scale to inventory pack
  const invoicePPBase = invoicePPU / invScale.factor   // $/g or $/ml
  const invTotalBase  = invQtyPerPurchase * invPackSize * invtScale.factor  // total g or ml per purchase
  if (invTotalBase <= 0) return null
  return invoicePPBase * invTotalBase
}

/** Price per base unit for an invoice line (no unit normalization — raw) */
export function calcInvoicePricePerBase(unitPrice: number, fmt: InvoiceFormat): number | null {
  const total = fmt.packQty * fmt.packSize
  if (total <= 0) return null
  return unitPrice / total
}

/** % diff between invoice pricePerBase and inventory pricePerBase (same unit, no conversion) */
export function calcPricePerBaseDiff(invoicePPB: number, inventoryPPB: number): number | null {
  if (inventoryPPB <= 0) return null
  return Math.round(((invoicePPB - inventoryPPB) / inventoryPPB) * 10000) / 100
}
