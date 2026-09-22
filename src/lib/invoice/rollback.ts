// Undoing an invoice approval. Task 1 recorded, per row the approval touched,
// the canonical state BEFORE its first write (`prev`) and AFTER its last
// (`next`). This module turns those records into a PLAN — pure, deterministic,
// inspectable (the delete-plan preview endpoint renders it) — and then applies
// that plan inside the delete transaction.
//
// The one restore rule: restore `prev` (delete the row when `prev` is null)
// IFF the row's current canonical state deep-equals `next` through the SAME
// selector. Anything else is skipped with a reason. A rollback never overwrites
// a value this session did not write — a price someone re-negotiated after the
// approval stays put, and says so.
//
// Legacy sessions (approved before these records existed) fall back to today's
// `revertedPricing` rule, extended to ADD_SUPPLIER lines, flagged 'best-effort':
// offers, learned match rules and created items cannot be restored at all,
// because nothing recorded what they looked like.
import { Prisma } from '@prisma/client'
import type { prisma } from '@/lib/prisma'
import {
  type Canon,
  type UndoKind,
  offerState,
  itemState,
  ruleState,
  canonEqual,
} from '@/lib/invoice/approve-undo'
import { revertedPricing, priorPpbFromAlerts, type RevertItemRow } from '@/lib/invoice/revert-pricing'

type Db = Prisma.TransactionClient | typeof prisma

/** The item row the legacy revert reads: `{ id, ...PRICING_SELECT }`. */
export type ChainItemRow = RevertItemRow

export type Outcome = 'restored' | 'deleted' | 'skipped' | 'best-effort'
export type SkipReason = 'changed-since' | 'gone' | 'referenced' | 'approved before undo records existed'
export type RollbackTable = 'offer' | 'item' | 'rule'

export interface PlanRow {
  kind: UndoKind
  targetId: string
  /** Human label for the preview / the skipped list. Falls back to the id. */
  name: string
  outcome: Outcome
  reason?: SkipReason
  write?: { table: RollbackTable; op: 'update' | 'delete'; data?: Canon }
}

export interface RollbackPlan {
  legacy: boolean
  rows: PlanRow[]
  /** Items whose price this plan moves — the prep/recipe re-cost set, after commit. */
  restoredItemIds: string[]
  summary: { restored: number; deleted: number; skipped: number; bestEffort: number }
}

export interface UndoRecord {
  kind: UndoKind
  targetId: string
  prev: Canon | null
  next: Canon
}

/** Current state + the display fields the plan's `name` uses. The display
 *  fields are stripped by the selector before any equality test. */
export type CurrentOffer = Canon & { inventoryItemId: string; supplierName: string }
export type CurrentItem = Canon & { itemName: string }

export interface ItemRefs {
  /** Approved scan lines pointing at the item from OTHER sessions. */
  approvedLinesElsewhere: number
  recipeIngredients: number
  countLines: number
  /** Offers that will still exist after this rollback (the loader excludes the
   *  session's own created-offer targets — see Task 4 step 1). */
  offers: number
}

export interface LegacyLine {
  matchedItemId: string | null
  previousPrice: number | null
  action: string
  matchedItem: ChainItemRow | null
  /** Optional display name; the plan falls back to the item id. */
  itemName?: string | null
}

export interface LegacyInput {
  status: string
  lines: LegacyLine[]
  priceAlerts: Array<{ inventoryItemId: string; previousPrice: unknown }>
}

export interface PlanInput {
  records: UndoRecord[]
  current: {
    offers: Map<string, CurrentOffer>
    items: Map<string, CurrentItem>
    rules: Map<string, Canon>
  }
  /** Keyed by ITEM_CREATED targetId. A target missing from the map is treated
   *  as referenced: never delete an item whose references were not checked. */
  refs: Map<string, ItemRefs>
  legacy: LegacyInput | null
}

const TABLE_OF: Record<UndoKind, RollbackTable> = {
  OFFER: 'offer',
  ITEM: 'item',
  MATCH_RULE: 'rule',
  ITEM_CREATED: 'item',
}

// Apply order. OFFER first, and within OFFER every row whose restored state is
// NOT primary (including the deletes) before the rows that claim primary again:
// the partial unique index `(inventoryItemId) WHERE isPrimary` only tolerates
// one primary per item, so the flag has to be surrendered before it is taken.
// ITEM_CREATED last — its reference check assumes the offers this plan removes
// are already gone.
const KIND_RANK: Record<UndoKind, number> = { OFFER: 0, ITEM: 1, MATCH_RULE: 2, ITEM_CREATED: 3 }

function orderRank(r: UndoRecord): number {
  const claimsPrimary = r.kind === 'OFFER' && r.prev !== null && r.prev.isPrimary === true
  return KIND_RANK[r.kind] * 2 + (claimsPrimary ? 1 : 0)
}

/** Stable: equal-rank records keep the order they arrived in. */
function ordered(records: UndoRecord[]): UndoRecord[] {
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => orderRank(a.r) - orderRank(b.r) || a.i - b.i)
    .map(x => x.r)
}

function selectorFor(kind: UndoKind): (row: Record<string, unknown>) => Canon {
  if (kind === 'OFFER') return offerState
  if (kind === 'MATCH_RULE') return ruleState
  return itemState
}

function nameFor(rec: UndoRecord, input: PlanInput): string {
  if (rec.kind === 'OFFER') {
    const offer = input.current.offers.get(rec.targetId)
    if (!offer) return rec.targetId
    const item = input.current.items.get(offer.inventoryItemId)
    const supplier = offer.supplierName || rec.targetId
    return item?.itemName ? `${supplier} → ${item.itemName}` : supplier
  }
  if (rec.kind === 'MATCH_RULE') {
    const raw =
      (input.current.rules.get(rec.targetId)?.rawDescription as string | undefined) ??
      (rec.next.rawDescription as string | undefined) ??
      (rec.prev?.rawDescription as string | undefined)
    return raw || rec.targetId
  }
  return input.current.items.get(rec.targetId)?.itemName || rec.targetId
}

function isReferenced(refs: ItemRefs | undefined): boolean {
  if (!refs) return true // not checked ⇒ not deleted
  return refs.approvedLinesElsewhere > 0 || refs.recipeIngredients > 0 || refs.countLines > 0 || refs.offers > 0
}

function planOne(rec: UndoRecord, input: PlanInput): PlanRow {
  const table = TABLE_OF[rec.kind]
  const name = nameFor(rec, input)
  const base = { kind: rec.kind, targetId: rec.targetId, name }

  const current: Record<string, unknown> | undefined =
    rec.kind === 'OFFER'
      ? input.current.offers.get(rec.targetId)
      : rec.kind === 'MATCH_RULE'
        ? input.current.rules.get(rec.targetId)
        : input.current.items.get(rec.targetId)

  if (!current) return { ...base, outcome: 'skipped', reason: 'gone' }

  // Same selector both sides: the display fields hanging off `current`
  // (inventoryItemId / supplierName / itemName) are stripped here, so they can
  // never make a row look changed.
  if (!canonEqual(selectorFor(rec.kind)(current), rec.next)) {
    return { ...base, outcome: 'skipped', reason: 'changed-since' }
  }

  if (rec.kind === 'ITEM_CREATED') {
    if (isReferenced(input.refs.get(rec.targetId))) return { ...base, outcome: 'skipped', reason: 'referenced' }
    return { ...base, outcome: 'deleted', write: { table, op: 'delete' } }
  }

  if (rec.prev === null) return { ...base, outcome: 'deleted', write: { table, op: 'delete' } }
  return { ...base, outcome: 'restored', write: { table, op: 'update', data: rec.prev } }
}

/**
 * Today's rule (`src/app/api/invoices/sessions/[id]/route.ts` DELETE), extended
 * to ADD_SUPPLIER lines: one row per qualifying line, in line order. A session
 * that re-priced the same item on two lines emits two rows and the later one
 * wins — exactly what the loop does today, kept deliberately rather than
 * deduplicated, because `previousPrice` is per line and nothing says which line
 * carries the pre-session price.
 */
function legacyRows(legacy: LegacyInput): PlanRow[] {
  const priorPpbByItem = priorPpbFromAlerts(legacy.priceAlerts)
  const rows: PlanRow[] = []
  for (const line of legacy.lines) {
    if (line.action !== 'UPDATE_PRICE' && line.action !== 'ADD_SUPPLIER') continue
    if (!line.matchedItemId || line.previousPrice === null || !line.matchedItem) continue
    const revert = revertedPricing({
      previousPrice: Number(line.previousPrice),
      item: line.matchedItem,
      priorPpb: priorPpbByItem.get(line.matchedItemId) ?? null,
    })
    rows.push({
      kind: 'ITEM',
      targetId: line.matchedItemId,
      name: line.itemName || line.matchedItemId,
      outcome: 'best-effort',
      reason: 'approved before undo records existed',
      write: {
        table: 'item',
        op: 'update',
        data: { purchasePrice: revert.purchasePrice, pricing: revert.pricing as unknown as Canon },
      },
    })
  }
  return rows
}

export function planRollback(input: PlanInput): RollbackPlan {
  let legacy = false
  let rows: PlanRow[]

  if (input.records.length > 0) {
    rows = ordered(input.records).map(rec => planOne(rec, input))
  } else if (input.legacy && input.legacy.status === 'APPROVED') {
    legacy = true
    rows = legacyRows(input.legacy)
  } else {
    rows = []
  }

  const restoredItemIds: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const movesAnItemPrice = r.kind === 'ITEM' && (r.outcome === 'restored' || r.outcome === 'best-effort')
    if (movesAnItemPrice && !seen.has(r.targetId)) {
      seen.add(r.targetId)
      restoredItemIds.push(r.targetId)
    }
  }

  return {
    legacy,
    rows,
    restoredItemIds,
    summary: {
      restored: rows.filter(r => r.outcome === 'restored').length,
      deleted: rows.filter(r => r.outcome === 'deleted').length,
      skipped: rows.filter(r => r.outcome === 'skipped').length,
      bestEffort: rows.filter(r => r.outcome === 'best-effort').length,
    },
  }
}

// `packChain` and `pricing` are the Json columns in every selector's field set.
// A nullable Json column takes the Prisma.JsonNull sentinel to be set to NULL —
// a plain JS null is rejected by the generated client.
const JSON_FIELDS = new Set(['packChain', 'pricing'])

function toPrismaData(data: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = JSON_FIELDS.has(k) && v === null ? Prisma.JsonNull : v
  return out
}

/** Apply a plan, in plan order, inside the caller's transaction. */
export async function executeRollback(tx: Db, plan: RollbackPlan): Promise<void> {
  for (const row of plan.rows) {
    const w = row.write
    if (!w) continue
    const where = { id: row.targetId }

    if (w.op === 'delete') {
      if (w.table === 'offer') await tx.inventorySupplierPrice.delete({ where })
      else if (w.table === 'item') await tx.inventoryItem.delete({ where })
      else await tx.invoiceMatchRule.delete({ where })
      continue
    }

    const data = toPrismaData(w.data ?? {})
    if (w.table === 'offer') {
      await tx.inventorySupplierPrice.update({ where, data: data as unknown as Prisma.InventorySupplierPriceUncheckedUpdateInput })
    } else if (w.table === 'item') {
      await tx.inventoryItem.update({ where, data: data as unknown as Prisma.InventoryItemUncheckedUpdateInput })
    } else {
      await tx.invoiceMatchRule.update({ where, data: data as unknown as Prisma.InvoiceMatchRuleUncheckedUpdateInput })
    }
  }
}
