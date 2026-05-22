import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'

// ── Allowed values ───────────────────────────────────────────────────────────
export const PRICE_BASES = [
  'Per Case', 'Per Each', 'Per kg', 'Per g', 'Per L', 'Per mL', 'Per lb', 'Per oz',
] as const
export type PriceBasis = typeof PRICE_BASES[number]

export const CONTENT_UNITS = ['each', 'kg', 'g', 'L', 'mL', 'lb', 'oz'] as const
export type ContentUnit = typeof CONTENT_UNITS[number]

export const IMPORT_HEADERS = [
  'Item Name', 'Purchase Price', 'Price Basis',
  'Case Contains', 'Content Unit', 'Stock On Hand', 'Barcode',
] as const

// ── Row & report types ───────────────────────────────────────────────────────
export interface RawRow {
  rowNumber: number   // 1-based data row (header excluded)
  itemName: string
  purchasePrice: string
  priceBasis: string
  caseContains: string
  contentUnit: string
  stockOnHand: string
  barcode: string
}

export interface InventoryCreatePayload {
  itemName: string
  category: string                 // always 'UNASSIGNED'
  purchaseUnit: string
  qtyPerPurchaseUnit: number
  qtyUOM: string
  packSize: number
  packUOM: string
  innerQty: number | null
  priceType: 'CASE' | 'UOM'
  countUOM: string
  purchasePrice: number
  pricePerBaseUnit: number
  conversionFactor: number
  baseUnit: string
  stockOnHand: number              // stored in base units
  barcode: string | null
  isActive: boolean
}

export type RowStatus = 'valid' | 'error' | 'duplicate'

export interface RowReport {
  rowNumber: number
  itemName: string
  status: RowStatus
  errors: string[]
  payload?: InventoryCreatePayload
  computed?: { pricePerBaseUnit: number; baseUnit: string }
}

export interface ImportReport {
  rows: RowReport[]
  validCount: number
  errorCount: number
  duplicateCount: number
}

// ── Normalization ────────────────────────────────────────────────────────────
const PRICE_BASIS_SYNONYMS: Record<string, PriceBasis> = {
  'per case': 'Per Case', 'case': 'Per Case',
  'per each': 'Per Each', 'each': 'Per Each', 'ea': 'Per Each',
  'per kg': 'Per kg', 'kg': 'Per kg', 'kilogram': 'Per kg', 'per kilogram': 'Per kg',
  'per g': 'Per g', 'g': 'Per g', 'gram': 'Per g', 'per gram': 'Per g',
  'per l': 'Per L', 'l': 'Per L', 'litre': 'Per L', 'liter': 'Per L',
  'per litre': 'Per L', 'per liter': 'Per L',
  'per ml': 'Per mL', 'ml': 'Per mL', 'per millilitre': 'Per mL',
  'per lb': 'Per lb', 'lb': 'Per lb', 'pound': 'Per lb', 'per pound': 'Per lb',
  'per oz': 'Per oz', 'oz': 'Per oz', 'ounce': 'Per oz', 'per ounce': 'Per oz',
}

const CONTENT_UNIT_SYNONYMS: Record<string, ContentUnit> = {
  'each': 'each', 'ea': 'each',
  'kg': 'kg', 'kilogram': 'kg',
  'g': 'g', 'gram': 'g',
  'l': 'L', 'litre': 'L', 'liter': 'L',
  'ml': 'mL', 'millilitre': 'mL',
  'lb': 'lb', 'pound': 'lb',
  'oz': 'oz', 'ounce': 'oz',
}

export function normalizePriceBasis(raw: string): PriceBasis | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return PRICE_BASIS_SYNONYMS[key] ?? null
}

export function normalizeContentUnit(raw: string): ContentUnit | null {
  const key = raw.trim().toLowerCase()
  return CONTENT_UNIT_SYNONYMS[key] ?? null
}

// ── Row → payload mapping ────────────────────────────────────────────────────
// qtyUOM values use lowercase engine keys (matching UNIT_CONV in utils.ts).
// purchaseUnit values use display-case strings shown to users.
const BASIS_TO_QTY_UOM: Record<Exclude<PriceBasis, 'Per Case'>, string> = {
  'Per Each': 'each', 'Per kg': 'kg', 'Per g': 'g',
  'Per L': 'l', 'Per mL': 'ml', 'Per lb': 'lb', 'Per oz': 'oz',
}
const BASIS_TO_PURCHASE_UNIT: Record<Exclude<PriceBasis, 'Per Case'>, string> = {
  'Per Each': 'each', 'Per kg': 'kg', 'Per g': 'g',
  'Per L': 'L', 'Per mL': 'mL', 'Per lb': 'lb', 'Per oz': 'oz',
}
const CONTENT_UNIT_TO_QTY_UOM: Record<ContentUnit, string> = {
  each: 'each', kg: 'kg', g: 'g', L: 'l', mL: 'ml', lb: 'lb', oz: 'oz',
}

export function mapRowToPayload(row: RawRow): InventoryCreatePayload {
  const basis = normalizePriceBasis(row.priceBasis)
  if (!basis) throw new Error(`mapRowToPayload called on invalid Price Basis: ${row.priceBasis}`)

  const price = Number(row.purchasePrice)
  if (!Number.isFinite(price) || price < 0) {
    throw new Error(`mapRowToPayload: invalid Purchase Price: ${row.purchasePrice}`)
  }

  let qtyUOM: string
  let qtyPerPurchaseUnit: number
  let purchaseUnit: string

  if (basis === 'Per Case') {
    const contentUnit = normalizeContentUnit(row.contentUnit)
    if (!contentUnit) throw new Error(`mapRowToPayload: invalid Content Unit: ${row.contentUnit}`)
    qtyUOM = CONTENT_UNIT_TO_QTY_UOM[contentUnit]
    qtyPerPurchaseUnit = Number(row.caseContains)
    if (!Number.isFinite(qtyPerPurchaseUnit) || qtyPerPurchaseUnit <= 0) {
      throw new Error(`mapRowToPayload: invalid Case Contains: ${row.caseContains}`)
    }
    purchaseUnit = 'Case'
  } else {
    qtyUOM = BASIS_TO_QTY_UOM[basis]
    qtyPerPurchaseUnit = 1
    purchaseUnit = BASIS_TO_PURCHASE_UNIT[basis]
  }

  const packSize = 1
  const packUOM = 'each'
  const innerQty = null
  const priceType = 'CASE' as const
  const countUOM = qtyUOM

  const pricePerBaseUnit = calcPricePerBaseUnit(
    price, qtyPerPurchaseUnit, qtyUOM, innerQty, packSize, packUOM, priceType,
  )
  const conversionFactor = calcConversionFactor(
    countUOM, qtyPerPurchaseUnit, qtyUOM, innerQty, packSize, packUOM,
  )
  const baseUnit = deriveBaseUnit(qtyUOM, packUOM)

  const enteredStock = row.stockOnHand.trim() === '' ? 0 : Number(row.stockOnHand)
  if (!Number.isFinite(enteredStock) || enteredStock < 0) {
    throw new Error(`mapRowToPayload: invalid Stock On Hand: ${row.stockOnHand}`)
  }
  const stockOnHand = enteredStock * conversionFactor

  return {
    itemName: row.itemName.trim(),
    category: 'UNASSIGNED',
    purchaseUnit,
    qtyPerPurchaseUnit,
    qtyUOM,
    packSize,
    packUOM,
    innerQty,
    priceType,
    countUOM,
    purchasePrice: price,
    pricePerBaseUnit,
    conversionFactor,
    baseUnit,
    stockOnHand,
    barcode: row.barcode.trim() || null,
    isActive: true,
  }
}
