import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'
import * as XLSX from 'xlsx'

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

// ── File parsing ─────────────────────────────────────────────────────────────
/**
 * Parses a .csv or .xlsx buffer into RawRows. Throws Error with a
 * human-readable message on unreadable files or missing columns.
 */
export function parseImportFile(buffer: Buffer): RawRow[] {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new Error('Could not read this file — make sure it is a .csv or .xlsx')
  }
  const sheetName = wb.SheetNames[0]
  if (!sheetName) throw new Error('The file has no sheets')
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
    header: 1, blankrows: false, defval: '',
  })
  if (matrix.length === 0) throw new Error('The file is empty')

  const header = (matrix[0] as unknown[]).map(h => String(h ?? '').trim())
  const missing = IMPORT_HEADERS.filter(h => !header.includes(h))
  if (missing.length > 0) {
    throw new Error(`Missing required columns: ${missing.join(', ')}`)
  }
  const colIndex = (name: string) => header.indexOf(name)

  const rows: RawRow[] = []
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i] as unknown[]
    const cell = (name: string) => String(r[colIndex(name)] ?? '').trim()
    if (IMPORT_HEADERS.every(h => cell(h) === '')) continue   // skip blank rows
    rows.push({
      rowNumber: i,
      itemName: cell('Item Name'),
      purchasePrice: cell('Purchase Price'),
      priceBasis: cell('Price Basis'),
      caseContains: cell('Case Contains'),
      contentUnit: cell('Content Unit'),
      stockOnHand: cell('Stock On Hand'),
      barcode: cell('Barcode'),
    })
  }
  return rows
}

// ── Validation ───────────────────────────────────────────────────────────────
/**
 * Classifies each row as valid / error / duplicate.
 * @param existingNamesLower lowercased trimmed names of items already in the DB
 */
export function validateRows(rows: RawRow[], existingNamesLower: Set<string>): ImportReport {
  const seenInFile = new Set<string>()
  const reports: RowReport[] = []

  for (const row of rows) {
    const errors: string[] = []
    const name = row.itemName.trim()
    const nameLower = name.toLowerCase()

    if (!name) errors.push('Item Name is required')

    const price = Number(row.purchasePrice)
    if (row.purchasePrice.trim() === '' || !Number.isFinite(price) || price < 0) {
      errors.push('Purchase Price must be a number of 0 or more')
    }

    const basis = normalizePriceBasis(row.priceBasis)
    if (!basis) {
      errors.push(`Price Basis "${row.priceBasis}" not recognized — use one of: ${PRICE_BASES.join(', ')}`)
    }

    if (basis === 'Per Case') {
      const caseContains = Number(row.caseContains)
      if (row.caseContains.trim() === '' || !Number.isFinite(caseContains) || caseContains <= 0) {
        errors.push('Case Contains must be a number greater than 0 for Per Case items')
      }
      if (!normalizeContentUnit(row.contentUnit)) {
        errors.push(`Content Unit "${row.contentUnit}" not recognized — use one of: ${CONTENT_UNITS.join(', ')}`)
      }
    }

    if (row.stockOnHand.trim() !== '') {
      const stock = Number(row.stockOnHand)
      if (!Number.isFinite(stock) || stock < 0) {
        errors.push('Stock On Hand must be a number of 0 or more')
      }
    }

    if (errors.length > 0) {
      reports.push({ rowNumber: row.rowNumber, itemName: name, status: 'error', errors })
      continue
    }

    if (existingNamesLower.has(nameLower) || seenInFile.has(nameLower)) {
      reports.push({ rowNumber: row.rowNumber, itemName: name, status: 'duplicate', errors: [] })
      continue
    }
    seenInFile.add(nameLower)

    const payload = mapRowToPayload(row)
    reports.push({
      rowNumber: row.rowNumber,
      itemName: name,
      status: 'valid',
      errors: [],
      payload,
      computed: { pricePerBaseUnit: payload.pricePerBaseUnit, baseUnit: payload.baseUnit },
    })
  }

  return {
    rows: reports,
    validCount: reports.filter(r => r.status === 'valid').length,
    errorCount: reports.filter(r => r.status === 'error').length,
    duplicateCount: reports.filter(r => r.status === 'duplicate').length,
  }
}
