// Row/manifest plumbing for the merge executor AND the shapes its routes
// accept. PURE — no database, no `server-only`: everything decidable without a
// connection lives here so it can be unit-tested, because the executor itself
// (item-merge-exec.ts) cannot be.
//
// Jobs:
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
//   5. Request parsing (`parseCombinedOnHand`) and the row-id guard behind the
//      one piece of literal SQL the executor issues (`lockItemsSql`).

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

// ── 5. request parsing + the row-id guard ────────────────────────────────────

export interface CombinedOnHand { countedQty: number; selectedUom: string; rcId: string }

/**
 * The merge request's optional `combinedOnHand`, parsed STRICTLY.
 *
 * `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all `0`, so
 * a coercing parse would turn a malformed body into "the combined on-hand is
 * zero" — recording a Quick Count that zeroes the item's stock and, because
 * that count can never be inverted, permanently blocking the undo. Every field
 * is therefore type-checked, never coerced.
 *
 * Absent (or `null`) means "no figure given" and is fine. Present but wrong is
 * an error the route must surface as a 400 — never silently treated as absent,
 * which would merge without the figure the person thought they had entered.
 */
export function parseCombinedOnHand(body: unknown):
  | { ok: true; value: CombinedOnHand | null }
  | { ok: false; error: string } {
  const raw = (body as { combinedOnHand?: unknown } | null | undefined)?.combinedOnHand
  if (raw == null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, error: 'combinedOnHand must be an object { countedQty, selectedUom, rcId }' }

  const { countedQty, selectedUom, rcId } = raw as Record<string, unknown>
  if (typeof countedQty !== 'number' || !Number.isFinite(countedQty) || countedQty < 0)
    return { ok: false, error: 'combinedOnHand.countedQty must be a non-negative number' }
  if (typeof selectedUom !== 'string' || !selectedUom)
    return { ok: false, error: 'combinedOnHand.selectedUom is required' }
  if (typeof rcId !== 'string' || !rcId)
    return { ok: false, error: 'combinedOnHand.rcId is required' }

  return { ok: true, value: { countedQty, selectedUom, rcId } }
}

/** Every id this schema generates is a cuid or a uuid. Anything else has no
 *  business being interpolated into SQL. */
const SAFE_ROW_ID = /^[A-Za-z0-9_-]{1,64}$/
export const isSafeRowId = (id: unknown): boolean => typeof id === 'string' && SAFE_ROW_ID.test(id)

/**
 * `SELECT … FOR UPDATE` over the two items a merge (or undo) touches, as
 * LITERAL SQL for `$queryRawUnsafe`.
 *
 * Why raw at all: Prisma has no row-lock API, and the lock is what closes the
 * last window — an INSERT that references one of these rows takes `FOR KEY
 * SHARE` on it, which `FOR UPDATE` conflicts with, so anything trying to attach
 * a row to either item serializes behind the merge instead of slipping in
 * between the post-apply sweep and the commit. Why *Unsafe* and literal: this
 * repo's `DATABASE_URL` is a transaction-mode pooler that does not support
 * named prepared statements, so hand-built literal SQL is the sanctioned raw
 * path here (see `toPgTextArray` in src/app/api/prep/settings/route.ts).
 *
 * Interpolation is safe only because every id is checked against
 * {@link isSafeRowId} first — this THROWS rather than emit SQL it cannot vouch
 * for. Ids are sorted (and de-duplicated) so two concurrent merges over the
 * same pair, in opposite survivor/absorbed roles, take the two locks in the
 * same order and cannot deadlock.
 */
export function lockItemsSql(ids: string[]): string {
  const unique = [...new Set(ids)].sort()
  if (unique.length === 0) throw new Error('lockItemsSql: no ids to lock')
  for (const id of unique) if (!isSafeRowId(id)) throw new Error(`lockItemsSql: unsafe row id ${JSON.stringify(id)}`)
  return `SELECT id FROM "InventoryItem" WHERE id IN (${unique.map(id => `'${id}'`).join(',')}) ORDER BY id FOR UPDATE`
}

/**
 * Every re-pointable table paired with its FK column, derived from
 * {@link REPOINT_FK} so a table added to the planner's union cannot be left out
 * of the post-apply "nothing still points at the absorbed item" sweep.
 */
export function repointTableChecks(): Array<{ table: RepointTable; fk: string }> {
  return (Object.keys(REPOINT_FK) as RepointTable[]).map(table => ({ table, fk: REPOINT_FK[table] }))
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

/** An op as the executor will actually issue it: a manifest op, or a run of
 *  consecutive identical `update`s collapsed into one `updateMany`. */
export type BatchedOp =
  | MergeOp
  | { t: 'updateMany'; table: UpdateTable; ids: string[]; after: Record<string, unknown> }

/**
 * Collapse **consecutive** `update` ops that share a table AND an identical
 * `after` payload into one `updateMany`.
 *
 * Adjacent-only, deliberately. The planner's op order is load-bearing — an
 * offer's demote (`isPrimary: true→false`) must land before the shared
 * `repoint`, and the winner's promote (`false→true`) after it, or the partial
 * unique index `(inventoryItemId) WHERE isPrimary` is tripped. A run-length
 * collapse cannot move an op past anything, so that ordering survives by
 * construction rather than by a rule someone has to remember. Two ops with the
 * same payload on different rows also cannot mask each other's constraint
 * violations: a batch fails exactly when the sequential version's last row
 * would have.
 *
 * A run of one is returned as the ORIGINAL op object — `before` (which undo
 * needs verbatim) is never rebuilt.
 *
 * One behavioural difference to know about: `updateMany` silently matches zero
 * rows where a single `update` raises P2025. Acceptable for the two runs that
 * actually occur. On a re-pointable table (allocation par/reorder clears, offer
 * demotes) every batched id is also carried by a `repoint`, and the executor's
 * post-apply sweep then proves nothing still references the absorbed item, so a
 * vanished row cannot pass unnoticed. On `InventoryItem` the only run is the
 * prior-absorbee `mergedIntoId` re-point; a row that vanished mid-merge took
 * its whole tombstone chain with it, leaving nothing to strand. The two item
 * rows the merge turns on are never batched (unique payloads) and are row-
 * locked for the duration, so those still fail loudly.
 */
export function batchUpdateOps(ops: MergeOp[]): BatchedOp[] {
  type Upd = Extract<MergeOp, { t: 'update' }>
  const out: BatchedOp[] = []
  let run: { key: string; ops: Upd[] } | null = null

  const flush = () => {
    if (!run) return
    out.push(run.ops.length === 1
      ? run.ops[0]
      : { t: 'updateMany', table: run.ops[0].table, ids: run.ops.map(o => o.id), after: run.ops[0].after })
    run = null
  }

  for (const op of ops) {
    if (op.t !== 'update') { flush(); out.push(op); continue }
    // Key-order-sensitive on purpose: two payloads that stringify differently
    // are treated as different rather than normalised and guessed at.
    const key = `${op.table} ${JSON.stringify(op.after)}`
    if (run && run.key === key) run.ops.push(op)
    else { flush(); run = { key, ops: [op] } }
  }
  flush()
  return out
}

const OP_KINDS = new Set(['repoint', 'update', 'delete', 'create'])

/** Re-read a manifest out of `ItemMerge.manifest` (a Json column, so `unknown`).
 *  Null when it is not one — an undo must refuse rather than half-apply. */
export function parseManifest(json: unknown): MergeManifest | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const m = json as Record<string, unknown>
  if (typeof m.survivorId !== 'string' || typeof m.absorbedId !== 'string') return null
  if (!Array.isArray(m.ops)) return null
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
