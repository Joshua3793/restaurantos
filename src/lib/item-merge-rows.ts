// Row/manifest plumbing for the merge executor. PURE — no database, no
// `server-only`: everything decidable without a connection lives here so it can
// be unit-tested, because the executor itself (item-merge-exec.ts) cannot be.
//
// Four jobs:
//   1. toPlain / toPlainRow — a Prisma row → plain JSON (Decimal → number,
//      Date → ISO string, no undefined). A manifest is stored in a Json column
//      and replayed months later, so anything that can end up in an op's
//      `row`/`before`/`after` must survive JSON.stringify → JSON.parse intact.
//   2. REPOINT_FK / TABLE_DELEGATE — table → FK column and table → delegate,
//      as `Record`s over the planner's own unions so the compiler refuses a new
//      table that nobody taught these maps about.
//   3. writeData — the `null` → `Prisma.DbNull` translation a nullable Json
//      column needs, keyed by (table, column) rather than scattered at use.
//   4. Op ordering + manifest re-reading.

import { Prisma } from '@prisma/client'
import type {
  DeleteTable, MergeCountEntry, MergeManifest, MergeOp, RepointTable, UpdateTable,
} from '@/lib/item-merge'

// ── 1. plain JSON ────────────────────────────────────────────────────────────

/** Prisma `Decimal` (decimal.js) duck-typed — never `instanceof`, so a row that
 *  crossed a serialization boundary with its methods intact still converts. */
function isDecimalLike(v: object): v is { toNumber: () => number } {
  return typeof (v as { toNumber?: unknown }).toNumber === 'function'
}

/**
 * JSON-safe form of any value read off a Prisma row.
 *
 * `undefined` maps to `undefined` (callers drop the key) at object level and to
 * `null` inside an array, exactly as `JSON.stringify` would. Values that are
 * already plain (a Json column's contents) pass through a structural copy, so
 * the result never shares mutable state with the row it came from.
 */
export function toPlain(value: unknown): unknown {
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return value
  if (t === 'bigint') return Number(value)
  if (t === 'undefined' || t === 'function' || t === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  const o = value as object
  if (Array.isArray(o)) return o.map(v => { const p = toPlain(v); return p === undefined ? null : p })
  if (isDecimalLike(o)) return Number(o.toNumber())
  return toPlainRow(o)
}

/** {@link toPlain} for a whole row: every own enumerable key, `undefined` dropped. */
export function toPlainRow(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    const p = toPlain(v)
    if (p !== undefined) out[k] = p
  }
  return out
}

// ── 2. table lookups ─────────────────────────────────────────────────────────

/** The column a `repoint` op rewrites. `Record<RepointTable, …>` on purpose:
 *  adding a table to the planner's union breaks the build here. */
export const REPOINT_FK: Record<RepointTable, string> = {
  InvoiceScanItem:        'matchedItemId',   // the ONLY table that differs
  InvoiceLineItem:        'inventoryItemId',
  PriceAlert:             'inventoryItemId',
  InvoiceMatchRule:       'inventoryItemId',
  StockTransfer:          'inventoryItemId',
  WastageLog:             'inventoryItemId',
  RecipeIngredient:       'inventoryItemId',
  CountLine:              'inventoryItemId',
  InventorySnapshot:      'inventoryItemId',
  InventorySupplierPrice: 'inventoryItemId',
  StockAllocation:        'inventoryItemId',
  ItemRevenueCenter:      'inventoryItemId',
}

/** Every table any op can name (`UpdateTable` ⊇ `RepointTable` ⊇ `DeleteTable`,
 *  and a `create`'s table is a `DeleteTable`) → its Prisma client property. */
export const TABLE_DELEGATE: Record<UpdateTable, string> = {
  InventoryItem:          'inventoryItem',
  InvoiceScanItem:        'invoiceScanItem',
  InvoiceLineItem:        'invoiceLineItem',
  PriceAlert:             'priceAlert',
  InvoiceMatchRule:       'invoiceMatchRule',
  StockTransfer:          'stockTransfer',
  WastageLog:             'wastageLog',
  RecipeIngredient:       'recipeIngredient',
  CountLine:              'countLine',
  InventorySnapshot:      'inventorySnapshot',
  InventorySupplierPrice: 'inventorySupplierPrice',
  StockAllocation:        'stockAllocation',
  ItemRevenueCenter:      'itemRevenueCenter',
}

// ── 3. nullable Json columns ─────────────────────────────────────────────────

/**
 * Nullable (`Json?`) columns per table, from prisma/schema.prisma. Prisma
 * refuses a bare `null` for these — it needs `Prisma.DbNull` (SQL NULL, which
 * is what every row here reads back as) or `Prisma.JsonNull` (a JSON `null`
 * literal). A NON-nullable Json column (`InventoryItem.packChain`/`pricing`)
 * is deliberately absent: writing null there is invalid either way.
 */
export const NULLABLE_JSON_COLUMNS: Record<UpdateTable, readonly string[]> = {
  InventoryItem:          [],
  InvoiceScanItem:        ['rcSplit', 'bbox'],
  InvoiceLineItem:        [],
  PriceAlert:             [],
  InvoiceMatchRule:       [],
  StockTransfer:          [],
  WastageLog:             [],
  RecipeIngredient:       [],
  CountLine:              ['entries'],
  InventorySnapshot:      [],
  InventorySupplierPrice: ['packChain', 'pricing'],
  StockAllocation:        [],
  ItemRevenueCenter:      [],
}

/** A manifest `row`/`after` object as Prisma write data: identical except that a
 *  `null` on a nullable Json column becomes `Prisma.DbNull`. */
export function writeData(table: UpdateTable | DeleteTable, data: Record<string, unknown>): Record<string, unknown> {
  const jsonCols = NULLABLE_JSON_COLUMNS[table]
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = v === null && jsonCols.includes(k) ? Prisma.DbNull : v
  return out
}

// ── 4. op ordering + manifest re-reading ─────────────────────────────────────

/** MERGE: every `delete` first (it frees the unique slot a later re-point needs),
 *  then the rest in manifest order. Stable within each group. */
export function mergeOpOrder(ops: MergeOp[]): MergeOp[] {
  return [...ops.filter(o => o.t === 'delete'), ...ops.filter(o => o.t !== 'delete')]
}

/** UNDO: `planUndo`'s non-`create` ops in the order given, then its `create`s —
 *  a restored row can only land once the re-points have freed its unique slot. */
export function undoOpOrder(ops: MergeOp[]): MergeOp[] {
  return [...ops.filter(o => o.t !== 'create'), ...ops.filter(o => o.t === 'create')]
}

const OP_KINDS = new Set(['repoint', 'update', 'delete', 'create'])

/** Re-read a manifest out of `ItemMerge.manifest` (a Json column, so `unknown`).
 *  Null when it is not one — an undo must refuse rather than half-apply. */
export function parseManifest(json: unknown): MergeManifest | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const m = json as Record<string, unknown>
  if (typeof m.survivorId !== 'string' || typeof m.absorbedId !== 'string') return null
  if (typeof m.factor !== 'number' || !Array.isArray(m.ops)) return null
  for (const op of m.ops) {
    if (!op || typeof op !== 'object') return null
    const { t, table } = op as { t?: unknown; table?: unknown }
    if (typeof t !== 'string' || !OP_KINDS.has(t) || typeof table !== 'string') return null
  }
  return m as unknown as MergeManifest
}

/**
 * `CountLine.entries` (a Json column, so `unknown`) as the planner's type.
 *
 * Verbatim by identity when it is an array — the only shape the count writer
 * produces — and null for anything else. Deliberately NOT validated per element
 * or re-built: the planner echoes this value into a `update` op's
 * `before.entries`, and undo writes it straight back, so any reshaping here
 * would silently rewrite history on undo.
 */
export function asCountEntries(json: unknown): MergeCountEntry[] | null {
  return Array.isArray(json) ? (json as unknown as MergeCountEntry[]) : null
}

/** The RecipeIngredient rows this merge moved — the undo blocker checks whether
 *  a recipe using one of them has been edited since. */
export function recipeIngredientRepointIds(manifest: MergeManifest): string[] {
  return manifest.ops.flatMap(o => (o.t === 'repoint' && o.table === 'RecipeIngredient' ? o.ids : []))
}
