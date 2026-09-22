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
// `revertedPricing` rule, exactly as it stands today — UPDATE_PRICE lines
// only, never ADD_SUPPLIER (see `legacyRows` for why) — flagged 'best-effort':
// offers, learned match rules and created items cannot be restored at all,
// because nothing recorded what they looked like.
//
// ── THE LOADER'S CONTRACT (Task 4) ──────────────────────────────────────────
// The planner is pure: everything it knows about the world outside the undo
// records arrives in `PlanInput`. Three parts of that input are load-bearing,
// and getting them wrong is silent data loss rather than a failing plan.
//
// 1. `refs` — the reference check for an ITEM_CREATED delete.
//    `referencedBy` is a list of human-readable phrases ('3 invoice lines (1
//    unapproved)', '1 recipe', 'wastage log'). NON-EMPTY ⇒ the item is kept.
//    A target MISSING from the map is also kept: never delete an item whose
//    references were not checked.
//
//    Count EVERY relation on `InventoryItem` — Restrict, SetNull AND Cascade —
//    minus the exclusions below, because `inventoryItem.delete()` either
//    THROWS on it, silently guts it, or silently deletes it along with the
//    item:
//
//      Restrict (the delete THROWS — the whole transaction dies):
//        InvoiceLineItem.inventoryItem      — approved receipt lines
//        InventorySnapshot.inventoryItem    — frozen count valuations
//        CountLine.inventoryItem            — count lines
//        WastageLog.inventoryItem           — wastage
//        StockTransfer.inventoryItem        — RC transfers
//        PriceAlert.inventoryItem           — price alerts
//        InvoiceMatchRule.inventoryItem     — learned matches
//      SetNull by default (optional FK — the row SURVIVES, pointing at nothing;
//      just as bad, and it does not announce itself):
//        RecipeIngredient.inventoryItem     — a recipe ingredient goes $0
//        Recipe.inventoryItem               — a PREP recipe loses its linked item
//        PrepItem.linkedInventoryItem       — a prep line loses its stock
//        InvoiceScanItem.matchedItem        — scan lines on OTHER sessions,
//                                              approved OR NOT: an unapproved
//                                              draft's match suggestion is the
//                                              same SetNull as an approved one
//        InventoryItem.mergedInto           — a merge tombstone points nowhere
//      Cascade (the row is DELETED with the item, silently):
//        InventorySupplierPrice.inventoryItem
//
//    EXCLUDED entirely — membership rows the item takes with it, not a claim on
//    stock (a real stock observation is `CountLine`, which is Restrict and IS
//    counted above):
//        StockAllocation.inventoryItem      — Cascade
//        ItemRevenueCenter.inventoryItem    — Cascade
//    Approve itself creates one of each per (item, non-default RC) pair it
//    touches, so counting them would make every item an invoice creates on a
//    non-default RC (e.g. CATERING) permanently `referenced`.
//
//    EXCLUDE the rows this same deletion is already removing, or nothing is ever
//    deletable: this session's (and its RC clones') `InvoiceScanItem` rows
//    (they cascade with the session — regardless of `approved`); this
//    session's `PriceAlert` and `RecipeAlert` rows (same); and the
//    `InventorySupplierPrice` / `InvoiceMatchRule` rows THIS PLAN deletes. The
//    planner re-adds the two exclusions the loader cannot see coming: an offer
//    OR a learned match the plan ends up SKIPPING protects its item again,
//    because the cascade (offer) or the Restrict FK (match rule) would
//    otherwise take the whole transaction down (see `guardCascades`).
//
// 2. `current.offers` must hold EVERY offer of every item touched by any OFFER
//    record — not just the recorded ones. A third offer that took the primary
//    flag after the approval is invisible otherwise, and restoring the flag onto
//    the recorded offer would trip the partial unique index
//    `(inventoryItemId) WHERE isPrimary` and kill the transaction.
//
// 3. `legacy.lines` must be ordered by `sortOrder`, and `legacy.priceAlerts` by
//    `createdAt asc` — see `LegacyInput`.
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
  /** The specifics behind `reason` — the joined reference list, or which other
   *  offer is holding the primary flag. For the preview; nothing branches on it. */
  detail?: string
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
  /** Everything still pointing at the item, in words the preview can print —
   *  e.g. `['3 approved invoice lines', '1 recipe']`. Empty ⇒ safe to delete.
   *  See THE LOADER'S CONTRACT at the top of this file for what to count. */
  referencedBy: string[]
}

export interface LegacyLine {
  /** Today's DELETE reads `where: { action: 'UPDATE_PRICE', approved: true }`.
   *  An unapproved line never moved a price, so reverting to its
   *  `previousPrice` would invent one. Anything but `true` is ignored. */
  approved: boolean
  matchedItemId: string | null
  /** Prisma `Decimal | number | string | null`. `Number()`d; a value that is not
   *  a finite number (null, '', junk) means "no pre-session price" and is
   *  skipped — the line is left alone rather than reverted to 0. */
  previousPrice: unknown
  action: string
  matchedItem: ChainItemRow | null
  /** Optional display name; the plan falls back to the item id. */
  itemName?: string | null
}

export interface LegacyInput {
  status: string
  /**
   * MUST be ordered by `sortOrder` (the invoice's own line order). The legacy
   * path emits one row per qualifying line and does NOT deduplicate: a session
   * that re-priced the same item on two lines writes twice and the LAST write
   * wins. That is today's behaviour, and it is only deterministic if the lines
   * arrive in a defined order.
   */
  lines: LegacyLine[]
  /**
   * MUST be ordered `createdAt asc`. `priorPpbFromAlerts` is first-wins per
   * item: only the earliest alert quotes the item's pre-session $/base, and it
   * is the proof the cross-dimension revert decides on.
   */
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

/** `null` ⇒ safe to delete. A string ⇒ keep it, and that string says why. */
function referenceDetail(refs: ItemRefs | undefined): string | null {
  if (!refs) return 'references not checked' // absent from `refs` ⇒ never deleted
  return refs.referencedBy.length > 0 ? refs.referencedBy.join(', ') : null
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
    const detail = referenceDetail(input.refs.get(rec.targetId))
    if (detail !== null) return { ...base, outcome: 'skipped', reason: 'referenced', detail }
    return { ...base, outcome: 'deleted', write: { table, op: 'delete' } }
  }

  if (rec.prev === null) return { ...base, outcome: 'deleted', write: { table, op: 'delete' } }
  return { ...base, outcome: 'restored', write: { table, op: 'update', data: rec.prev } }
}

const skip = (row: PlanRow, reason: SkipReason, detail: string): PlanRow => ({
  kind: row.kind,
  targetId: row.targetId,
  name: row.name,
  outcome: 'skipped',
  reason,
  detail,
})

/**
 * The primary flag is single-occupancy per item (partial unique index
 * `(inventoryItemId) WHERE isPrimary`). Ordering surrenders it before it is
 * claimed — but only among the offers this plan KNOWS about. If a third offer
 * took the flag after the approval and nothing in this plan clears it, claiming
 * it back would throw inside the transaction and take the whole rollback down.
 * Downgrade instead: the world moved on, which is exactly 'changed-since'.
 *
 * `rows[i]` corresponds to `recs[i]` — both are in applied order.
 */
function guardPrimaryCollisions(recs: UndoRecord[], rows: PlanRow[], input: PlanInput): void {
  // Offers this plan leaves NOT primary: deleted outright, or restored to a
  // `prev` that was not primary.
  const cleared = new Set<string>()
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].kind !== 'OFFER') continue
    if (rows[i].outcome === 'deleted') cleared.add(recs[i].targetId)
    else if (rows[i].outcome === 'restored' && recs[i].prev?.isPrimary !== true) cleared.add(recs[i].targetId)
  }

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (rec.kind !== 'OFFER' || rows[i].outcome !== 'restored' || rec.prev?.isPrimary !== true) continue
    const itemId = input.current.offers.get(rec.targetId)?.inventoryItemId
    if (!itemId) continue
    for (const [id, o] of input.current.offers) {
      if (id === rec.targetId || o.inventoryItemId !== itemId) continue
      if (o.isPrimary !== true || cleared.has(id)) continue
      rows[i] = skip(rows[i], 'changed-since', 'another supplier is primary now')
      break
    }
  }
}

/**
 * Two relations would otherwise blow up a created item's delete once it is
 * skipped-but-still-there:
 *
 *  - `InventorySupplierPrice.inventoryItemId` is `onDelete: Cascade`. Deleting
 *    a created item takes EVERY offer on it — including one this plan
 *    deliberately kept because it had changed since the approval.
 *  - `InvoiceMatchRule.inventoryItemId` is `onDelete: Restrict`. A match rule
 *    the approval created but someone has since edited is also skipped by the
 *    planner — and unlike the offer, nothing else catches it: the delete
 *    THROWS and takes the whole transaction down with it.
 *
 * `refs` cannot see either case: the loader counted offers/rules before the
 * plan decided which ones it would skip. So a skipped offer or a skipped
 * match rule protects its item, here, after both outcomes are known.
 */
function guardCascades(recs: UndoRecord[], rows: PlanRow[], input: PlanInput): void {
  const protectedByOffer = new Set<string>()
  const protectedByRule = new Map<string, string>() // itemId → the rule's display name, for `detail`
  for (let i = 0; i < recs.length; i++) {
    if (rows[i].outcome !== 'skipped') continue
    if (recs[i].kind === 'OFFER') {
      const itemId = input.current.offers.get(recs[i].targetId)?.inventoryItemId
      if (itemId) protectedByOffer.add(itemId)
    } else if (recs[i].kind === 'MATCH_RULE') {
      const itemId = input.current.rules.get(recs[i].targetId)?.inventoryItemId
      if (typeof itemId === 'string') protectedByRule.set(itemId, rows[i].name)
    }
  }
  if (protectedByOffer.size === 0 && protectedByRule.size === 0) return

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'ITEM_CREATED' || rows[i].outcome !== 'deleted') continue
    const itemId = rows[i].targetId
    if (protectedByOffer.has(itemId)) {
      rows[i] = skip(rows[i], 'referenced', 'a supplier price on this item was kept')
    } else if (protectedByRule.has(itemId)) {
      rows[i] = skip(rows[i], 'referenced', `a learned match ("${protectedByRule.get(itemId)}") on this item was kept`)
    }
  }
}

/**
 * Today's exact rule (`src/app/api/invoices/sessions/[id]/route.ts` DELETE):
 * `UPDATE_PRICE` lines only, one row per qualifying line, in line order. A
 * session that re-priced the same item on two lines emits two rows and the
 * later one wins — exactly what the loop does today, kept deliberately rather
 * than deduplicated, because `previousPrice` is per line and nothing says
 * which line carries the pre-session price.
 *
 * NEVER `ADD_SUPPLIER`. `invoice-matcher.ts`'s `buildMatchResult` assigns
 * `ADD_SUPPLIER` exactly when the line did NOT move the item's price
 * (`|priceDiffPct| ≤ 0.1%` or `priceDiffPct === null`) — approve's
 * `shouldReprice` is false for those lines whenever the line's supplier isn't
 * the item's primary offer, so the item's spine was never touched by them in
 * the first place. Its `previousPrice` is `offerLastPrice ?? Number(item.
 * purchasePrice)` — THAT supplier's own last price, not necessarily what the
 * item's spine held — so reverting an `ADD_SUPPLIER` line can overwrite the
 * item with a different supplier's number for a write that never happened.
 * `Number(null)` is `0`, so a line with no prior price at all would revert the
 * item to a zero price; the `previousPrice > 0` guard below closes that too.
 */
function legacyRows(legacy: LegacyInput): PlanRow[] {
  const priorPpbByItem = priorPpbFromAlerts(legacy.priceAlerts)
  const rows: PlanRow[] = []
  for (const line of legacy.lines) {
    if (line.approved !== true) continue
    if (line.action !== 'UPDATE_PRICE') continue
    if (!line.matchedItemId || !line.matchedItem) continue
    // Prisma Decimal | number | string. `Number(null)` is 0 and `Number('')` is
    // 0 — both would revert a live price to zero — so the empties go first.
    if (line.previousPrice === null || line.previousPrice === undefined || line.previousPrice === '') continue
    const previousPrice = Number(line.previousPrice)
    if (!Number.isFinite(previousPrice) || previousPrice <= 0) continue
    const revert = revertedPricing({
      previousPrice,
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
    const recs = ordered(input.records)
    rows = recs.map(rec => planOne(rec, input))
    // Both run after every outcome is known, and in this order: a primary
    // collision turns an OFFER row into a skip, and a skipped OFFER then
    // protects its item from the cascade.
    guardPrimaryCollisions(recs, rows, input)
    guardCascades(recs, rows, input)
    // The legacy discriminator is "no records on an APPROVED session" — which a
    // RECORDED session whose `UndoCollector.flush()` failed also looks like.
    // That misread is the safe direction: best-effort price reverts beat no
    // rollback at all, and the banner tells the user the offers and learned
    // matches were not restored. `legacy: true` is set ONLY on this branch, so
    // a session with even one record never claims it.
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
// A nullable Json column takes a sentinel, not a plain JS null, which the
// generated client rejects — and the sentinel is Prisma.DbNull: SQL NULL, "this
// offer has no chain". Prisma.JsonNull would store the JSON scalar `null`, a
// present value that `{ packChain: null }` no longer finds. `prev` came from a
// column that was SQL NULL; it goes back as SQL NULL.
const JSON_FIELDS = new Set(['packChain', 'pricing'])

function toPrismaData(data: Canon): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = JSON_FIELDS.has(k) && v === null ? Prisma.DbNull : v
  return out
}

async function applyRow(tx: Db, row: PlanRow): Promise<void> {
  const w = row.write
  if (!w) return
  const where = { id: row.targetId }

  if (w.op === 'delete') {
    if (w.table === 'offer') await tx.inventorySupplierPrice.delete({ where })
    else if (w.table === 'item') await tx.inventoryItem.delete({ where })
    else await tx.invoiceMatchRule.delete({ where })
    return
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

/**
 * Everything except the created-item deletes: offer/item/rule restores and
 * deletes, plus the legacy best-effort rows. Runs FIRST, while the session row
 * is still there.
 */
export async function executeRestores(tx: Db, plan: RollbackPlan): Promise<void> {
  for (const row of plan.rows) {
    if (row.kind === 'ITEM_CREATED') continue
    await applyRow(tx, row)
  }
}

/**
 * The created-item deletes, on their own, because they can only run once the
 * session is gone: the session's own approved `InvoiceLineItem` rows point at
 * the item with `onDelete: Restrict`, so deleting it any earlier throws.
 * The route's order is: restores → delete RC clones → delete session → THIS.
 */
export async function executeCreatedItemDeletes(tx: Db, plan: RollbackPlan): Promise<void> {
  for (const row of plan.rows) {
    if (row.kind !== 'ITEM_CREATED') continue
    await applyRow(tx, row)
  }
}

/**
 * Both halves, in order — the whole plan in one pass.
 *
 * NOT for the route: the created-item deletes must be separated by the session
 * delete (see `executeCreatedItemDeletes`). This exists so a caller that has no
 * session to delete — the tests — can apply a plan in one call.
 */
export async function executeRollback(tx: Db, plan: RollbackPlan): Promise<void> {
  await executeRestores(tx, plan)
  await executeCreatedItemDeletes(tx, plan)
}
