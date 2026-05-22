# Inventory CSV/Excel Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Import button to the Inventory page that bulk-creates inventory items from a `.csv`/`.xlsx` file, with a validate-before-commit preview.

**Architecture:** A pure parsing/validation/mapping library (`src/lib/inventory-import.ts`) is shared by two API routes — a preview route (validate only) and a commit route (create items). A template route generates a dropdown-enabled `.xlsx` via `exceljs`. A three-step modal drives the UX. The simplified template columns map onto the existing `calcPricePerBaseUnit` / `calcConversionFactor` / `deriveBaseUnit` engine in `src/lib/utils.ts`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, `xlsx` (existing — file parsing), `exceljs` (new — template generation only).

**Spec:** `docs/superpowers/specs/2026-05-21-inventory-csv-import-design.md`

**Note on testing:** the project has no test runner (`npm run build` is the only automated check). The pure-logic library is verified with a script run via `npx tsx`; routes and UI are verified with `npm run build` plus the manual checklist at the end.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/inventory-import.ts` (create) | Pure logic: types, constants, normalization, `parseImportFile`, `validateRows`, `mapRowToPayload`. No DB. |
| `src/app/api/inventory/import/preview/route.ts` (create) | POST — parse + validate uploaded file, return report. No writes. |
| `src/app/api/inventory/import/route.ts` (create) | POST — re-validate + create valid items in a transaction. |
| `src/app/api/inventory/import/template/route.ts` (create) | GET — generate dropdown-enabled `.xlsx` template via `exceljs`. |
| `src/components/inventory/InventoryImportModal.tsx` (create) | Three-step modal (upload → preview → result). |
| `src/app/inventory/page.tsx` (modify) | Add Import button (desktop + mobile), render the modal. |
| `src/app/api/inventory/export/route.ts` (modify) | Add `Price Type`, `Qty UOM`, `Pack Size`, `Pack UOM`, `Count UOM`, `Barcode` columns. |
| `scripts/verify-inventory-import.ts` (create) | Standalone assertion script for the pricing logic. |

---

## Task 1: Pricing logic — constants, types, normalization, `mapRowToPayload`

**Files:**
- Create: `src/lib/inventory-import.ts`
- Create: `scripts/verify-inventory-import.ts`

- [ ] **Step 1: Add the `exceljs` dependency**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm install exceljs
```
Expected: `exceljs` added to `package.json` dependencies.

- [ ] **Step 2: Create `src/lib/inventory-import.ts` with constants, types, normalization, and `mapRowToPayload`**

```ts
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
// qtyUOM that the internal pricing engine expects, per basis/content unit.
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

/** Maps a row that has already passed validation to an inventory-create payload. */
export function mapRowToPayload(row: RawRow): InventoryCreatePayload {
  const basis = normalizePriceBasis(row.priceBasis)
  if (!basis) throw new Error(`mapRowToPayload called on invalid Price Basis: ${row.priceBasis}`)
  const price = Number(row.purchasePrice)

  let qtyUOM: string
  let qtyPerPurchaseUnit: number
  let purchaseUnit: string

  if (basis === 'Per Case') {
    const contentUnit = normalizeContentUnit(row.contentUnit)
    if (!contentUnit) throw new Error(`mapRowToPayload: invalid Content Unit: ${row.contentUnit}`)
    qtyUOM = CONTENT_UNIT_TO_QTY_UOM[contentUnit]
    qtyPerPurchaseUnit = Number(row.caseContains)
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
```

- [ ] **Step 3: Create `scripts/verify-inventory-import.ts`**

```ts
import { mapRowToPayload, type RawRow } from '../src/lib/inventory-import'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.error(`FAIL ${label}: got ${a}, expected ${e}`) }
  else console.log(`ok   ${label}`)
}
function row(p: Partial<RawRow>): RawRow {
  return {
    rowNumber: 1, itemName: 'X', purchasePrice: '0', priceBasis: '',
    caseContains: '', contentUnit: '', stockOnHand: '', barcode: '', ...p,
  }
}

// Per Case of 24 each at $24 -> pricePerBaseUnit 1.00, baseUnit each
const tomatoes = mapRowToPayload(row({
  itemName: 'Diced Tomatoes', purchasePrice: '24', priceBasis: 'Per Case',
  caseContains: '24', contentUnit: 'each', stockOnHand: '12',
}))
check('tomatoes pricePerBaseUnit', tomatoes.pricePerBaseUnit, 1)
check('tomatoes baseUnit', tomatoes.baseUnit, 'each')
check('tomatoes stockOnHand', tomatoes.stockOnHand, 12)

// Per kg at $18.50 -> pricePerBaseUnit 0.0185 (per g), baseUnit g, stock 40kg -> 40000g
const flour = mapRowToPayload(row({
  itemName: 'Flour', purchasePrice: '18.5', priceBasis: 'Per kg', stockOnHand: '40',
}))
check('flour pricePerBaseUnit', flour.pricePerBaseUnit, 0.0185)
check('flour baseUnit', flour.baseUnit, 'g')
check('flour stockOnHand', flour.stockOnHand, 40000)

// Per Case of 6 L at $65 -> pricePerBaseUnit 65/6000, baseUnit ml
const oil = mapRowToPayload(row({
  itemName: 'Olive Oil', purchasePrice: '65', priceBasis: 'Per Case',
  caseContains: '6', contentUnit: 'L', stockOnHand: '4',
}))
check('oil pricePerBaseUnit', oil.pricePerBaseUnit, 65 / 6000)
check('oil baseUnit', oil.baseUnit, 'ml')
check('oil stockOnHand', oil.stockOnHand, 4000)

// Per Each at $3.50 -> pricePerBaseUnit 3.50, baseUnit each
const each = mapRowToPayload(row({
  itemName: 'Lemon', purchasePrice: '3.5', priceBasis: 'Per Each', stockOnHand: '20',
}))
check('lemon pricePerBaseUnit', each.pricePerBaseUnit, 3.5)
check('lemon baseUnit', each.baseUnit, 'each')
check('lemon stockOnHand', each.stockOnHand, 20)

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall checks passed')
```

- [ ] **Step 4: Run the verification script — expect it to pass**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npx tsx scripts/verify-inventory-import.ts
```
Expected: every line `ok ...` then `all checks passed`. If any `FAIL` appears, fix `mapRowToPayload` before continuing.

- [ ] **Step 5: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add package.json package-lock.json src/lib/inventory-import.ts scripts/verify-inventory-import.ts
git commit -m "feat(inventory): import library — pricing row→payload mapping

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Import library — `parseImportFile` and `validateRows`

**Files:**
- Modify: `src/lib/inventory-import.ts`

- [ ] **Step 1: Add `parseImportFile` and `validateRows` to `src/lib/inventory-import.ts`**

Add this `import` at the top of the file, below the existing import:

```ts
import * as XLSX from 'xlsx'
```

Append these two functions to the end of the file:

```ts
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
```

- [ ] **Step 2: Verify the build type-checks**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/lib/inventory-import.ts
git commit -m "feat(inventory): import library — file parsing and row validation

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Preview API route

**Files:**
- Create: `src/app/api/inventory/import/preview/route.ts`

- [ ] **Step 1: Create `src/app/api/inventory/import/preview/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { parseImportFile, validateRows } from '@/lib/inventory-import'

// Mutating/multipart route — must run live, never statically optimized.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    let rows
    try {
      rows = parseImportFile(buffer)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not read file' },
        { status: 400 },
      )
    }
    if (rows.length === 0) {
      return NextResponse.json({ error: '0 rows found in the file' }, { status: 400 })
    }

    const existing = await prisma.inventoryItem.findMany({ select: { itemName: true } })
    const existingNamesLower = new Set(existing.map(i => i.itemName.trim().toLowerCase()))

    const report = validateRows(rows, existingNamesLower)
    return NextResponse.json(report)
  } catch (err) {
    console.error('[inventory/import/preview]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "import/preview|Compiled"
```
Expected: `✓ Compiled successfully` and the route listed as `ƒ` (Dynamic), not `○`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/inventory/import/preview/route.ts
git commit -m "feat(inventory): import preview route — validate without writing

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Commit API route

**Files:**
- Create: `src/app/api/inventory/import/route.ts`

- [ ] **Step 1: Create `src/app/api/inventory/import/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { parseImportFile, validateRows } from '@/lib/inventory-import'

// Mutating/multipart route — must run live, never statically optimized.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())

    let rows
    try {
      rows = parseImportFile(buffer)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Could not read file' },
        { status: 400 },
      )
    }

    // Re-validate server-side — never trust a client-submitted "valid" list.
    const existing = await prisma.inventoryItem.findMany({ select: { itemName: true } })
    const existingNamesLower = new Set(existing.map(i => i.itemName.trim().toLowerCase()))
    const report = validateRows(rows, existingNamesLower)

    const valid = report.rows.filter(r => r.status === 'valid' && r.payload)
    if (valid.length === 0) {
      return NextResponse.json({ error: 'No valid rows to import', created: 0 }, { status: 400 })
    }

    // Ensure the UNASSIGNED category exists (Category.name is @unique).
    await prisma.category.upsert({
      where: { name: 'UNASSIGNED' },
      create: { name: 'UNASSIGNED' },
      update: {},
    })

    await prisma.$transaction(
      valid.map(r => prisma.inventoryItem.create({
        data: {
          itemName: r.payload!.itemName,
          category: r.payload!.category,
          purchaseUnit: r.payload!.purchaseUnit,
          qtyPerPurchaseUnit: r.payload!.qtyPerPurchaseUnit,
          qtyUOM: r.payload!.qtyUOM,
          packSize: r.payload!.packSize,
          packUOM: r.payload!.packUOM,
          innerQty: r.payload!.innerQty,
          priceType: r.payload!.priceType,
          countUOM: r.payload!.countUOM,
          purchasePrice: r.payload!.purchasePrice,
          pricePerBaseUnit: r.payload!.pricePerBaseUnit,
          conversionFactor: r.payload!.conversionFactor,
          baseUnit: r.payload!.baseUnit,
          stockOnHand: r.payload!.stockOnHand,
          barcode: r.payload!.barcode,
          isActive: r.payload!.isActive,
        },
      })),
    )

    return NextResponse.json({ created: valid.length })
  } catch (err) {
    console.error('[inventory/import]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "api/inventory/import|Compiled"
```
Expected: `✓ Compiled successfully`; `/api/inventory/import` listed as `ƒ` (Dynamic).

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/inventory/import/route.ts
git commit -m "feat(inventory): import commit route — create valid items in a transaction

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Template API route (dropdown `.xlsx`)

**Files:**
- Create: `src/app/api/inventory/import/template/route.ts`

- [ ] **Step 1: Create `src/app/api/inventory/import/template/route.ts`**

```ts
import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { PRICE_BASES, CONTENT_UNITS } from '@/lib/inventory-import'

export const dynamic = 'force-dynamic'

export async function GET() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Inventory Import')

  ws.columns = [
    { header: 'Item Name',      key: 'itemName',      width: 28 },
    { header: 'Purchase Price', key: 'purchasePrice', width: 16 },
    { header: 'Price Basis',    key: 'priceBasis',    width: 14 },
    { header: 'Case Contains',  key: 'caseContains',  width: 15 },
    { header: 'Content Unit',   key: 'contentUnit',   width: 14 },
    { header: 'Stock On Hand',  key: 'stockOnHand',   width: 15 },
    { header: 'Barcode',        key: 'barcode',       width: 18 },
  ]
  ws.getRow(1).font = { bold: true }

  // Two example rows
  ws.addRow({
    itemName: 'Diced Tomatoes', purchasePrice: 24, priceBasis: 'Per Case',
    caseContains: 24, contentUnit: 'each', stockOnHand: 12, barcode: '',
  })
  ws.addRow({
    itemName: 'All Purpose Flour', purchasePrice: 18.5, priceBasis: 'Per kg',
    caseContains: '', contentUnit: '', stockOnHand: 40, barcode: '',
  })

  // Dropdowns on Price Basis (col C) and Content Unit (col E), rows 2..500.
  const priceBasisList = `"${PRICE_BASES.join(',')}"`
  const contentUnitList = `"${CONTENT_UNITS.join(',')}"`
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`C${r}`).dataValidation = {
      type: 'list', allowBlank: false, formulae: [priceBasisList],
    }
    ws.getCell(`E${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: [contentUnitList],
    }
  }

  const arrayBuffer = await wb.xlsx.writeBuffer()
  return new NextResponse(Buffer.from(arrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="inventory-import-template.xlsx"',
    },
  })
}
```

- [ ] **Step 2: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | grep -E "import/template|Compiled"
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/inventory/import/template/route.ts
git commit -m "feat(inventory): import template route — dropdown-enabled xlsx via exceljs

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Import modal component

**Files:**
- Create: `src/components/inventory/InventoryImportModal.tsx`

- [ ] **Step 1: Create `src/components/inventory/InventoryImportModal.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { X, UploadCloud, Download, CheckCircle2, AlertCircle, Copy } from 'lucide-react'
import type { ImportReport } from '@/lib/inventory-import'

interface Props {
  onClose: () => void
  onImported: () => void
}

type Step = 'upload' | 'preview' | 'done'

export function InventoryImportModal({ onClose, onImported }: Props) {
  const [step, setStep]       = useState<Step>('upload')
  const [file, setFile]       = useState<File | null>(null)
  const [report, setReport]   = useState<ImportReport | null>(null)
  const [createdCount, setCreatedCount] = useState(0)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function runPreview(selected: File) {
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', selected)
      const res = await fetch('/api/inventory/import/preview', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not read the file'); return }
      setReport(data as ImportReport)
      setStep('preview')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/inventory/import', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Import failed'); return }
      setCreatedCount(data.created ?? 0)
      setStep('done')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    runPreview(f)
  }

  const statusStyle: Record<string, string> = {
    valid:     'bg-green-50 text-green-700',
    error:     'bg-red-50 text-red-700',
    duplicate: 'bg-amber-50 text-amber-700',
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900">Import Inventory</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Bulk-add items from a .csv or .xlsx file
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto">
          {error && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle size={15} className="shrink-0" /> {error}
            </div>
          )}

          {step === 'upload' && (
            <div className="space-y-4">
              <a href="/api/inventory/import/template"
                className="flex items-center gap-2 text-sm text-gold hover:underline">
                <Download size={15} /> Download the import template
              </a>
              <p className="text-xs text-gray-500">
                Fill the template, then upload it below. Items import into the
                <span className="font-semibold"> UNASSIGNED</span> category — review
                and assign their category, supplier, and storage area afterward.
              </p>
              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-10 cursor-pointer hover:border-gold transition-colors">
                <UploadCloud size={28} className="text-gray-300" />
                <span className="text-sm text-gray-500">
                  {busy ? 'Reading file…' : 'Choose a .csv or .xlsx file'}
                </span>
                <input type="file" accept=".csv,.xlsx" className="hidden"
                  disabled={busy} onChange={handleFile} />
              </label>
            </div>
          )}

          {step === 'preview' && report && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs font-medium">
                <span className="px-2 py-1 rounded-full bg-green-50 text-green-700">
                  {report.validCount} valid
                </span>
                <span className="px-2 py-1 rounded-full bg-red-50 text-red-700">
                  {report.errorCount} errors
                </span>
                <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                  {report.duplicateCount} duplicates (skipped)
                </span>
              </div>
              <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-[45vh] overflow-y-auto">
                {report.rows.map(r => (
                  <div key={r.rowNumber} className="px-3 py-2 flex items-start gap-2 text-sm">
                    <span className="text-gray-300 tabular-nums shrink-0 w-7">
                      {r.rowNumber}
                    </span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${statusStyle[r.status]}`}>
                      {r.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-800 truncate">{r.itemName || '(no name)'}</div>
                      {r.status === 'error' && (
                        <ul className="text-xs text-red-600 mt-0.5 list-disc pl-4">
                          {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      )}
                      {r.status === 'valid' && r.computed && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          {r.computed.pricePerBaseUnit.toFixed(4)} / {r.computed.baseUnit}
                        </div>
                      )}
                      {r.status === 'duplicate' && (
                        <div className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                          <Copy size={11} /> Already in inventory — skipped
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <CheckCircle2 size={40} className="text-green-500" />
              <p className="text-gray-800 font-medium">
                Created {createdCount} item{createdCount !== 1 ? 's' : ''}.
              </p>
              <p className="text-sm text-gray-500 max-w-sm">
                They are in the <span className="font-semibold">UNASSIGNED</span> category —
                review and assign their category, supplier, and storage area.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-5 border-t border-gray-100 shrink-0">
          {step === 'preview' && (
            <>
              <button type="button" onClick={() => { setStep('upload'); setReport(null); setFile(null) }}
                disabled={busy}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                Back
              </button>
              <button type="button" onClick={runImport}
                disabled={busy || !report || report.validCount === 0}
                className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
                {busy ? 'Importing…' : `Import ${report?.validCount ?? 0} item${report?.validCount === 1 ? '' : 's'}`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button type="button" onClick={() => { onImported(); onClose() }}
              className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930]">
              Done
            </button>
          )}
          {step === 'upload' && (
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 3: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/components/inventory/InventoryImportModal.tsx
git commit -m "feat(inventory): import modal — upload, preview, confirm

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Wire the Import button into the Inventory page

**Files:**
- Modify: `src/app/inventory/page.tsx`

- [ ] **Step 1: Add the import to the top of `src/app/inventory/page.tsx`**

Add this alongside the other component imports near the top of the file:

```tsx
import { InventoryImportModal } from '@/components/inventory/InventoryImportModal'
```

- [ ] **Step 2: Add the `showImport` state**

Find the line that declares `showAdd` state (search for `setShowAdd`). Immediately below that `useState` line, add:

```tsx
  const [showImport, setShowImport] = useState(false)
```

- [ ] **Step 3: Add the desktop Import button**

In `src/app/inventory/page.tsx`, find the desktop Export button:

```tsx
          <button
            onClick={() => window.location.href = '/api/inventory/export'}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
          >
            <Download size={15} /> Export
          </button>
```

Insert this Import button immediately BEFORE that Export button:

```tsx
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 border border-gray-200 bg-white text-gray-700 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors"
          >
            <UploadCloud size={15} /> Import
          </button>
```

- [ ] **Step 4: Ensure `UploadCloud` is imported from lucide**

At the top of `src/app/inventory/page.tsx`, find the `lucide-react` import line. If `UploadCloud` is not already in the list, add it. Example — if the line is:

```tsx
import { Download, Plus, ShoppingCart } from 'lucide-react'
```

change it to include `UploadCloud`:

```tsx
import { Download, Plus, ShoppingCart, UploadCloud } from 'lucide-react'
```

(Keep whatever icons are already imported; only add `UploadCloud`.)

- [ ] **Step 5: Add the mobile Import button**

Find the mobile Export button:

```tsx
          <button
            onClick={() => { window.location.href = '/api/inventory/export' }}
            title="Export CSV"
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50"
          >
            <Download size={11} /> CSV
          </button>
```

Insert this Import button immediately BEFORE it:

```tsx
          <button
            onClick={() => setShowImport(true)}
            title="Import CSV"
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 bg-white text-gray-600 transition-colors hover:bg-gray-50"
          >
            <UploadCloud size={11} /> Import
          </button>
```

- [ ] **Step 6: Render the modal**

Find where `showAdd` renders its modal (search for the component opened by `showAdd`, e.g. `{showAdd && (`). Immediately after that block's closing `)}`, add:

```tsx
      {showImport && (
        <InventoryImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); load() }}
        />
      )}
```

If the inventory page's data-reload function is not named `load`, use whatever function the page already calls to refresh the item list (search for the function used after a successful Add). Match that name exactly.

- [ ] **Step 7: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`. If it fails with an unknown identifier for the reload function, fix the call in Step 6 to the correct function name.

- [ ] **Step 8: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/inventory/page.tsx
git commit -m "feat(inventory): add Import button to inventory page (desktop + mobile)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Add missing pricing columns to the inventory export

**Files:**
- Modify: `src/app/api/inventory/export/route.ts`

This closes the gap the user noted — the export omits whether a price is per-weight or per-case (`priceType`) and the UOM fields.

- [ ] **Step 1: Update the `headers` array in `src/app/api/inventory/export/route.ts`**

Find:

```ts
  const headers = ['Item Name', 'Category', 'Supplier', 'Storage Area', 'Purchase Unit', 'Qty/Purchase Unit', 'Purchase Price', 'Base Unit', 'Conversion Factor', 'Price/Base Unit', 'Stock On Hand', 'Stock Value', 'Active', 'Last Count Date', 'Last Count Qty', 'Location']
```

Replace with:

```ts
  const headers = ['Item Name', 'Category', 'Supplier', 'Storage Area', 'Purchase Unit', 'Qty/Purchase Unit', 'Qty UOM', 'Price Type', 'Pack Size', 'Pack UOM', 'Count UOM', 'Purchase Price', 'Base Unit', 'Conversion Factor', 'Price/Base Unit', 'Stock On Hand', 'Stock Value', 'Barcode', 'Active', 'Last Count Date', 'Last Count Qty', 'Location']
```

- [ ] **Step 2: Update the row mapping in the same file**

Find the `rows` mapping:

```ts
  const rows = items.map(item => {
    const stockValue = parseFloat(item.stockOnHand.toString()) * parseFloat(item.pricePerBaseUnit.toString())
    return [
      item.itemName,
      item.category,
      item.supplier?.name || '',
      item.storageArea?.name || '',
      item.purchaseUnit,
      parseFloat(item.qtyPerPurchaseUnit.toString()),
      parseFloat(item.purchasePrice.toString()),
      item.baseUnit,
      parseFloat(item.conversionFactor.toString()),
      parseFloat(item.pricePerBaseUnit.toString()),
      parseFloat(item.stockOnHand.toString()),
      stockValue,
      item.isActive ? 'Yes' : 'No',
      item.lastCountDate ? new Date(item.lastCountDate).toLocaleDateString() : '',
      item.lastCountQty ? parseFloat(item.lastCountQty.toString()) : '',
      item.location || '',
    ]
  })
```

Replace with:

```ts
  const rows = items.map(item => {
    const stockValue = parseFloat(item.stockOnHand.toString()) * parseFloat(item.pricePerBaseUnit.toString())
    return [
      item.itemName,
      item.category,
      item.supplier?.name || '',
      item.storageArea?.name || '',
      item.purchaseUnit,
      parseFloat(item.qtyPerPurchaseUnit.toString()),
      item.qtyUOM,
      item.priceType,
      parseFloat(item.packSize.toString()),
      item.packUOM,
      item.countUOM,
      parseFloat(item.purchasePrice.toString()),
      item.baseUnit,
      parseFloat(item.conversionFactor.toString()),
      parseFloat(item.pricePerBaseUnit.toString()),
      parseFloat(item.stockOnHand.toString()),
      stockValue,
      item.barcode || '',
      item.isActive ? 'Yes' : 'No',
      item.lastCountDate ? new Date(item.lastCountDate).toLocaleDateString() : '',
      item.lastCountQty ? parseFloat(item.lastCountQty.toString()) : '',
      item.location || '',
    ]
  })
```

- [ ] **Step 3: Verify the build**

Run:
```bash
cd "/Users/joshua/Desktop/Fergie's OS" && npm run build 2>&1 | tail -5
```
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/joshua/Desktop/Fergie's OS"
git add src/app/api/inventory/export/route.ts
git commit -m "feat(inventory): add price type and UOM columns to inventory export

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Manual verification checklist (after all tasks)

Run `npm run dev` and open `http://localhost:3000/inventory`.

- [ ] An **Import** button appears next to Export on both desktop and mobile.
- [ ] Clicking it opens the modal; "Download the import template" downloads `inventory-import-template.xlsx`.
- [ ] Open the template in Excel/Sheets — `Price Basis` and `Content Unit` columns show dropdowns.
- [ ] Upload a filled file → the preview lists rows tagged valid / error / duplicate with a count summary.
- [ ] A row with a bad Price Basis shows an error and is excluded; valid rows still import.
- [ ] A row whose name matches an existing item shows as duplicate and is skipped.
- [ ] Clicking "Import N items" creates them; the done screen shows the count.
- [ ] The new items appear in inventory under the `UNASSIGNED` category with correct `pricePerBaseUnit` (spot-check one against the template values).
- [ ] Re-importing the same file → all rows now show as duplicates (safe to re-run).
- [ ] Export inventory → the `.xlsx` now includes `Price Type`, `Qty UOM`, `Pack Size`, `Pack UOM`, `Count UOM`, `Barcode` columns.
```
