// Reading the world the rollback planner needs, and running the plan.
//
// `rollback.ts` is pure: every fact about the database arrives in its
// `PlanInput`. This module is the other half — the ONE loader all three delete
// surfaces share (single DELETE, bulk DELETE, and the `delete-plan` preview),
// so what the preview promises is exactly what the delete does.
//
// The contract it implements is the LOADER'S CONTRACT block comment at the head
// of `rollback.ts`. Three things are load-bearing, and getting any of them wrong
// is silent data loss rather than a failing plan:
//
//  1. `refs` — every relation pointing at a created `InventoryItem`, counted,
//     minus `StockAllocation`/`ItemRevenueCenter` (membership rows, not a claim
//     on stock — approve creates one of each per non-default RC it touches) and
//     minus exactly the rows this same deletion removes. `InvoiceScanItem` is
//     counted whether or not it is approved. A target MISSING from the map is
//     kept, so a failed count can only ever be too cautious.
//  2. `current.offers` — EVERY offer of every item an OFFER record touches, not
//     just the recorded ones, so the planner can see a third offer that took the
//     primary flag after the approval.
//  3. `legacy.lines` ordered by `sortOrder`, `legacy.priceAlerts` by `createdAt`.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { atLeast } from '@/lib/roles'
import type { Role } from '@prisma/client'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'
import { deleteFileBlobs } from '@/lib/invoice-files'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import {
  type Canon,
  type UndoKind,
  OFFER_SELECT,
  ITEM_SELECT,
  RULE_SELECT,
  offerState,
  itemState,
  ruleState,
  canonEqual,
} from '@/lib/invoice/approve-undo'
import {
  planRollback,
  executeRestores,
  executeCreatedItemDeletes,
  type PlanInput,
  type PlanRow,
  type RollbackPlan,
  type UndoRecord,
  type CurrentOffer,
  type CurrentItem,
  type ItemRefs,
} from '@/lib/invoice/rollback'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Prisma's `$transaction` defaults (maxWait 2s, timeout 5s) assume a handful of
 * statements. `executeRestores` issues ONE statement per plan row — a 100-line
 * invoice is 200-300 serial statements over the pgBouncer pooler — so the
 * default timeout is a guaranteed `P2028` on anything but a tiny invoice. And
 * once it fires, the session row never left the database, so every retry
 * re-runs the same doomed transaction: the invoice becomes permanently
 * undeletable. 30s/10s gives real invoices headroom without leaving a runaway
 * transaction open indefinitely.
 */
export const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const

/** The 409 an RC copy gets. Verbatim in the UI's clone tooltip. */
export const CLONE_REFUSAL = 'This is an RC copy — delete the original invoice instead'

/** A delete this route will not perform, carrying the HTTP status it answers with. */
export class RollbackRefused extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'RollbackRefused'
  }
}

// ── the reference check ──────────────────────────────────────────────────────

/**
 * Every relation that points at `InventoryItem`, minus `StockAllocation` and
 * `ItemRevenueCenter` (see the loader's contract header in `rollback.ts`:
 * they are membership rows the item takes with it, not a claim on stock, and
 * approve creates one of each per non-default RC on every item it touches —
 * counting them would make those items permanently `referenced`). Deleting a
 * created item either THROWS on these (Restrict), silently leaves the row
 * pointing at nothing (SetNull), or silently takes the row with it (Cascade) —
 * all three are reasons to keep the item, so all three are counted. What is NOT
 * counted is only what this same deletion removes anyway (see `loadRollbackInputs`).
 */
export interface RefCounts {
  /** InvoiceLineItem.inventoryItem — legacy receipt lines (Restrict). */
  receiptLines: number
  /** InvoiceScanItem.matchedItem — ALL lines on OTHER sessions, approved or
   *  not (SetNull): an unapproved draft's match suggestion is silently nulled
   *  exactly like an approved one would be. */
  invoiceLines: number
  /** The subset of `invoiceLines` that are NOT approved — surfaced as a detail
   *  on the `invoiceLines` phrase, e.g. '2 invoice lines (1 unapproved)'. */
  unapprovedInvoiceLines: number
  /** InventorySnapshot.inventoryItem — frozen count valuations (Restrict). */
  snapshots: number
  /** CountLine.inventoryItem (Restrict). */
  countLines: number
  /** WastageLog.inventoryItem (Restrict). */
  wastageLogs: number
  /** StockTransfer.inventoryItem (Restrict). */
  stockTransfers: number
  /** PriceAlert.inventoryItem — alerts from OTHER sessions (Restrict). */
  priceAlerts: number
  /** InvoiceMatchRule.inventoryItem — minus the rules this plan deletes (Restrict). */
  matchRules: number
  /** RecipeIngredient.inventoryItem — the ingredient would silently go $0 (SetNull). */
  recipeIngredients: number
  /** Recipe.inventoryItem — a PREP recipe would lose its linked item (SetNull). */
  recipes: number
  /** PrepItem.linkedInventoryItem (SetNull). */
  prepItems: number
  /** InventoryItem.mergedInto — a merge tombstone would point nowhere (SetNull). */
  mergedItems: number
  /** InventorySupplierPrice — minus the offers this plan deletes (Cascade). */
  supplierOffers: number
}

/** The order phrases appear in (after `invoiceLines`, handled separately
 *  because it carries the unapproved detail — see `referencePhrases`), and
 *  how each one reads at 1 and at n. */
const OTHER_LABELS: ReadonlyArray<readonly [Exclude<keyof RefCounts, 'invoiceLines' | 'unapprovedInvoiceLines' | 'receiptLines'>, string, string]> = [
  ['snapshots', 'count snapshot', 'count snapshots'],
  ['countLines', 'count line', 'count lines'],
  ['wastageLogs', 'wastage log', 'wastage logs'],
  ['stockTransfers', 'stock transfer', 'stock transfers'],
  ['priceAlerts', 'price alert', 'price alerts'],
  ['supplierOffers', 'supplier price', 'supplier prices'],
  ['recipeIngredients', 'recipe ingredient', 'recipe ingredients'],
  ['recipes', 'recipe', 'recipes'],
  ['prepItems', 'prep item', 'prep items'],
  ['mergedItems', 'merged item', 'merged items'],
  ['matchRules', 'learned match', 'learned matches'],
]

export function emptyRefCounts(): RefCounts {
  const out = { receiptLines: 0, invoiceLines: 0, unapprovedInvoiceLines: 0 } as RefCounts
  for (const [key] of OTHER_LABELS) out[key] = 0
  return out
}

/** `['3 invoice lines (1 unapproved)', '1 recipe']`. Empty ⇒ the item is deletable. */
export function referencePhrases(counts: RefCounts): string[] {
  const phrases: string[] = []
  const push = (n: number, one: string, many: string) => {
    if (Number.isFinite(n) && n > 0) phrases.push(`${n} ${n === 1 ? one : many}`)
  }

  push(counts.receiptLines, 'receipt line', 'receipt lines')

  const invoiceLines = counts.invoiceLines
  if (Number.isFinite(invoiceLines) && invoiceLines > 0) {
    const base = `${invoiceLines} ${invoiceLines === 1 ? 'invoice line' : 'invoice lines'}`
    const unapproved = counts.unapprovedInvoiceLines
    phrases.push(Number.isFinite(unapproved) && unapproved > 0 ? `${base} (${unapproved} unapproved)` : base)
  }

  for (const [key, one, many] of OTHER_LABELS) push(counts[key], one, many)
  return phrases
}

/**
 * The offer / match-rule rows THIS PLAN will delete — the one exclusion the
 * reference counts need, because a row the deletion removes anyway cannot be
 * the reason the deletion is refused.
 *
 * It re-derives the planner's delete test rather than guessing: an undo record
 * with `prev === null` is a row the approval CREATED, and the planner deletes it
 * only while the row still equals `next`. A created row that has been edited
 * since is SKIPPED by the planner — so it stays, and it must keep counting.
 * (For an offer the planner also re-protects the item itself via `guardCascades`;
 * for a `Restrict` match rule nothing else would catch it, and the item delete
 * would take the whole transaction down.)
 */
export function plannedRowDeletes(
  records: UndoRecord[],
  offers: Map<string, CurrentOffer>,
  rules: Map<string, Canon>,
): { offerIds: Set<string>; ruleIds: Set<string> } {
  const offerIds = new Set<string>()
  const ruleIds = new Set<string>()
  for (const rec of records) {
    if (rec.prev !== null) continue
    if (rec.kind === 'OFFER') {
      const cur = offers.get(rec.targetId)
      if (cur && canonEqual(offerState(cur), rec.next)) offerIds.add(rec.targetId)
    } else if (rec.kind === 'MATCH_RULE') {
      const cur = rules.get(rec.targetId)
      if (cur && canonEqual(ruleState(cur), rec.next)) ruleIds.add(rec.targetId)
    }
  }
  return { offerIds, ruleIds }
}

// ── the loader ───────────────────────────────────────────────────────────────

export interface LoadedSession {
  id: string
  status: string
  parentSessionId: string | null
  /** Blob refs captured BEFORE the cascade delete takes the InvoiceFile rows. */
  files: { fileUrl: string }[]
  /** ALL scan items, not the filtered set — this is what the role gate reads. */
  scanItemCount: number
}

export interface RollbackInputs {
  session: LoadedSession
  input: PlanInput
}

/** `undefined` when the `in` list is empty — Prisma is happy either way, but an
 *  empty `in` is a guaranteed-empty query we can skip paying for. */
const none = <T>(ids: string[], run: () => Promise<T[]>): Promise<T[]> =>
  ids.length === 0 ? Promise.resolve([]) : run()

type GroupRow = { _count: { _all: number } }

/** Turn a Prisma `groupBy` result into `itemId → count`. */
function tally<K extends string>(rows: Array<GroupRow & Record<K, string | null>>, key: K): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const id = r[key]
    if (typeof id === 'string') m.set(id, (m.get(id) ?? 0) + r._count._all)
  }
  return m
}

/**
 * Everything `planRollback` needs for one session, plus the session facts the
 * routes gate on. `null` when the session does not exist.
 */
export async function loadRollbackInputs(db: Db, sessionId: string): Promise<RollbackInputs | null> {
  const session = await db.invoiceSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      status: true,
      parentSessionId: true,
      files: { select: { fileUrl: true } },
      _count: { select: { scanItems: true } },
      approveUndos: { select: { kind: true, targetId: true, prev: true, next: true } },
      // `previousPrice` here is the item's exact PRE-approve $/base, frozen by
      // the approve being undone. First alert per item wins, so the order is
      // part of the answer, not a nicety.
      priceAlerts: {
        select: { inventoryItemId: true, previousPrice: true },
        orderBy: { createdAt: 'asc' },
      },
      // The legacy path's lines. Ordered by sortOrder because it does NOT
      // deduplicate: two lines on one item write twice and the last one wins.
      scanItems: {
        where: { approved: true, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] } },
        orderBy: { sortOrder: 'asc' },
        select: {
          approved: true,
          action: true,
          matchedItemId: true,
          previousPrice: true,
          // The full PRICING_SELECT: `revertedPricing` needs the chain AND the
          // bridges to tell a cross-dimension rate from a pack price. A thinner
          // select silently degrades that decision.
          matchedItem: { select: { id: true, itemName: true, ...PRICING_SELECT } },
        },
      },
    },
  })
  if (!session) return null

  const records: UndoRecord[] = session.approveUndos.map(r => ({
    kind: r.kind as UndoKind,
    targetId: r.targetId,
    // `prev` was written as Prisma.DbNull (SQL NULL) for a row the approval
    // created, and reads back as JS null. Never filter `prev IS NULL` in SQL.
    prev: r.prev === null ? null : (r.prev as Canon),
    next: r.next as Canon,
  }))

  const idsOf = (kinds: UndoKind[]) =>
    [...new Set(records.filter(r => kinds.includes(r.kind)).map(r => r.targetId))]
  const recordedOfferIds = idsOf(['OFFER'])
  const recordedItemIds = idsOf(['ITEM', 'ITEM_CREATED'])
  const createdItemIds = idsOf(['ITEM_CREATED'])
  const ruleIds = idsOf(['MATCH_RULE'])

  const OFFER_ROW = { id: true, inventoryItemId: true, supplierName: true, ...OFFER_SELECT }

  // Two passes on offers, deliberately: pass 1 finds which ITEMS the recorded
  // offers belong to, pass 2 pulls EVERY offer on those items. Without pass 2 a
  // third offer that took the primary flag after the approval is invisible, and
  // restoring the flag trips `(inventoryItemId) WHERE isPrimary`.
  const recordedOffers = await none(recordedOfferIds, () =>
    db.inventorySupplierPrice.findMany({ where: { id: { in: recordedOfferIds } }, select: OFFER_ROW }),
  )
  const offerItemIds = [...new Set(recordedOffers.map(o => o.inventoryItemId))]
  const allOffers = await none(offerItemIds, () =>
    db.inventorySupplierPrice.findMany({ where: { inventoryItemId: { in: offerItemIds } }, select: OFFER_ROW }),
  )

  // Item rows: the ITEM/ITEM_CREATED targets, plus the owners of every offer in
  // play so an offer's plan row can read "<supplier> → <item>".
  const itemIds = [...new Set([...recordedItemIds, ...offerItemIds])]
  const [itemRows, ruleRows] = await Promise.all([
    none(itemIds, () =>
      db.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, itemName: true, ...ITEM_SELECT } }),
    ),
    none(ruleIds, () =>
      db.invoiceMatchRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, ...RULE_SELECT } }),
    ),
  ])

  const offers = new Map<string, CurrentOffer>()
  for (const o of allOffers) {
    offers.set(o.id, { ...offerState(o), inventoryItemId: o.inventoryItemId, supplierName: o.supplierName })
  }
  const items = new Map<string, CurrentItem>()
  for (const i of itemRows) items.set(i.id, { ...itemState(i), itemName: i.itemName })
  const rules = new Map<string, Canon>()
  for (const r of ruleRows) rules.set(r.id, ruleState(r))

  const refs = await loadItemRefs(db, sessionId, createdItemIds, plannedRowDeletes(records, offers, rules))

  return {
    session: {
      id: session.id,
      status: session.status,
      parentSessionId: session.parentSessionId,
      files: session.files,
      scanItemCount: session._count.scanItems,
    },
    input: {
      records,
      current: { offers, items, rules },
      refs,
      legacy: {
        status: session.status,
        lines: session.scanItems.map(s => ({
          approved: s.approved,
          action: s.action,
          matchedItemId: s.matchedItemId,
          previousPrice: s.previousPrice,
          matchedItem: s.matchedItem,
          itemName: s.matchedItem?.itemName ?? null,
        })),
        priceAlerts: session.priceAlerts,
      },
    },
  }
}

/** `InvoiceScanItem` grouped by `[matchedItemId, approved]` → two tallies: the
 *  total per item, and the subset of that total which is NOT approved. */
function tallyScanItems(
  rows: Array<{ matchedItemId: string | null; approved: boolean; _count: { _all: number } }>,
): { total: Map<string, number>; unapproved: Map<string, number> } {
  const total = new Map<string, number>()
  const unapproved = new Map<string, number>()
  for (const r of rows) {
    if (typeof r.matchedItemId !== 'string') continue
    total.set(r.matchedItemId, (total.get(r.matchedItemId) ?? 0) + r._count._all)
    if (r.approved === false) unapproved.set(r.matchedItemId, (unapproved.get(r.matchedItemId) ?? 0) + r._count._all)
  }
  return { total, unapproved }
}

/**
 * One `referencedBy` list per created item. Every relation on `InventoryItem`
 * is counted EXCEPT `StockAllocation` and `ItemRevenueCenter` (membership rows
 * approve itself creates for every non-default RC on every item it touches —
 * see the loader's contract header in `rollback.ts`). The remaining exclusions
 * are only the rows this same deletion removes anyway:
 *
 *  • this session's AND its RC clones' `InvoiceScanItem` rows (they cascade with
 *    their session — the clones are deleted in the same transaction). Every
 *    OTHER session's rows count, approved or not — an unapproved draft's match
 *    suggestion is the same SetNull as an approved one,
 *  • this session's `PriceAlert` rows (same),
 *  • the `InventorySupplierPrice` / `InvoiceMatchRule` rows this plan deletes.
 *
 * An offer or a learned match added to the item AFTER the approval has no undo
 * record, is not in those exclusions, and correctly keeps the item alive.
 */
export async function loadItemRefs(
  db: Db,
  sessionId: string,
  createdItemIds: string[],
  planned: { offerIds: Set<string>; ruleIds: Set<string> },
): Promise<Map<string, ItemRefs>> {
  const refs = new Map<string, ItemRefs>()
  if (createdItemIds.length === 0) return refs

  const clones = await db.invoiceSession.findMany({
    where: { parentSessionId: sessionId },
    select: { id: true },
  })
  const goneSessionIds = [sessionId, ...clones.map(c => c.id)]
  const inItems = { in: createdItemIds }
  const count = { _all: true } as const

  const [
    receiptLines, scanItems, snapshots, countLines, wastageLogs, stockTransfers,
    priceAlerts, supplierOffers,
    recipeIngredients, recipes, prepItems, mergedItems, matchRules,
  ] = await Promise.all([
    db.invoiceLineItem.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    // ALL scan lines outside this session and its clones — approved or not
    // (Fix: an unapproved DRAFT invoice's suggested match is `SetNull`, same as
    // an approved one; the old `approved: true` filter silently let it null).
    db.invoiceScanItem.groupBy({
      by: ['matchedItemId', 'approved'],
      where: { matchedItemId: inItems, sessionId: { notIn: goneSessionIds } },
      _count: count,
    }),
    db.inventorySnapshot.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.countLine.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.wastageLog.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.stockTransfer.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.priceAlert.groupBy({
      by: ['inventoryItemId'],
      where: { inventoryItemId: inItems, sessionId: { notIn: goneSessionIds } },
      _count: count,
    }),
    db.inventorySupplierPrice.groupBy({
      by: ['inventoryItemId'],
      where: { inventoryItemId: inItems, id: { notIn: [...planned.offerIds] } },
      _count: count,
    }),
    db.recipeIngredient.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.recipe.groupBy({ by: ['inventoryItemId'], where: { inventoryItemId: inItems }, _count: count }),
    db.prepItem.groupBy({ by: ['linkedInventoryItemId'], where: { linkedInventoryItemId: inItems }, _count: count }),
    db.inventoryItem.groupBy({ by: ['mergedIntoId'], where: { mergedIntoId: inItems }, _count: count }),
    db.invoiceMatchRule.groupBy({
      by: ['inventoryItemId'],
      where: { inventoryItemId: inItems, id: { notIn: [...planned.ruleIds] } },
      _count: count,
    }),
  ])

  const { total: invoiceLines, unapproved: unapprovedInvoiceLines } = tallyScanItems(scanItems)

  const byRelation = {
    receiptLines: tally(receiptLines, 'inventoryItemId'),
    snapshots: tally(snapshots, 'inventoryItemId'),
    countLines: tally(countLines, 'inventoryItemId'),
    wastageLogs: tally(wastageLogs, 'inventoryItemId'),
    stockTransfers: tally(stockTransfers, 'inventoryItemId'),
    priceAlerts: tally(priceAlerts, 'inventoryItemId'),
    supplierOffers: tally(supplierOffers, 'inventoryItemId'),
    recipeIngredients: tally(recipeIngredients, 'inventoryItemId'),
    recipes: tally(recipes, 'inventoryItemId'),
    prepItems: tally(prepItems, 'linkedInventoryItemId'),
    mergedItems: tally(mergedItems, 'mergedIntoId'),
    matchRules: tally(matchRules, 'inventoryItemId'),
  }

  for (const itemId of createdItemIds) {
    const counts = emptyRefCounts()
    counts.invoiceLines = invoiceLines.get(itemId) ?? 0
    counts.unapprovedInvoiceLines = unapprovedInvoiceLines.get(itemId) ?? 0
    for (const key of Object.keys(byRelation) as Array<keyof typeof byRelation>) {
      counts[key] = byRelation[key].get(itemId) ?? 0
    }
    refs.set(itemId, { referencedBy: referencePhrases(counts) })
  }
  return refs
}

// ── running it ───────────────────────────────────────────────────────────────

export interface DeleteSessionResult {
  ok: true
  legacy: boolean
  /** Rows this delete put back: restored records plus legacy best-effort reverts. */
  restored: number
  /** Rows this delete removed: created offers, learned matches, created items. */
  deleted: number
  skipped: PlanRow[]
  summary: RollbackPlan['summary']
  /** Recipes whose cost was recomputed after the commit. */
  recosted: number
  blobsDeleted: number
  blobsFailed: number
}

/** Each restored item's $/base as it stands NOW — read BEFORE the transaction,
 *  because after it the item carries the rolled-back price and the recipe-cost
 *  recalc would see no move at all. */
async function priorPpbFor(itemIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (itemIds.length === 0) return map
  const rows = await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, ...PRICING_SELECT },
  })
  for (const r of rows) map.set(r.id, pricePerBaseUnit(asChainItem(r)))
  return map
}

/**
 * Delete one invoice session and roll back whatever its approval wrote.
 *
 * Shared by the single and the bulk DELETE so the two can never drift. Refusals
 * (404 / 403 / 409) are thrown as `RollbackRefused`; the bulk route catches them
 * per id and carries on.
 */
export async function deleteSession(sessionId: string, user: { role: Role }): Promise<DeleteSessionResult> {
  const loaded = await loadRollbackInputs(prisma, sessionId)
  if (!loaded) throw new RollbackRefused(404, 'Not found')
  const { session, input } = loaded

  // An RC copy shares its parent's lines; deleting it alone would unwind a
  // rollback the parent still owns. Clones go with their parent, never alone.
  if (session.parentSessionId) throw new RollbackRefused(409, CLONE_REFUSAL)

  // Gate by what is being thrown away: a session with NO scan items (an unsorted
  // batch, an upload that never OCR'd) has touched nothing — anyone who can
  // upload can discard it. Once lines exist, history and possibly the spine are
  // involved, and that stays a manager's call. Unchanged from today.
  if (session.scanItemCount > 0 && !atLeast(user.role, 'MANAGER')) {
    throw new RollbackRefused(403, 'Only a manager can delete an invoice that has been scanned')
  }

  const plan = planRollback(input)
  const priorPpbByItem = await priorPpbFor(plan.restoredItemIds)

  await prisma.$transaction(async tx => {
    // Order matters in both directions. The restores run while the session row
    // is still there; the created-item deletes can only run once it is gone,
    // because the session's own approved InvoiceLineItem/scan rows point at
    // those items and would block the delete.
    await executeRestores(tx, plan)
    await tx.invoiceSession.deleteMany({ where: { parentSessionId: sessionId } })
    await tx.invoiceSession.delete({ where: { id: sessionId } })
    await executeCreatedItemDeletes(tx, plan)
  }, TX_OPTIONS)

  // After the commit, never inside it: the prep cascade touches many recipes and
  // has no business holding the delete's transaction open. No sessionId is
  // passed — a RecipeAlert belongs to an invoice, and this one no longer exists.
  let recosted = 0
  if (plan.restoredItemIds.length > 0) {
    try {
      const moved = await propagatePrepCostChanges(plan.restoredItemIds)
      const alerts = await recalculateRecipeCosts(
        [...new Set([...plan.restoredItemIds, ...moved])],
        undefined,
        priorPpbByItem,
      )
      recosted = alerts.length
    } catch (e) {
      // The rows are already gone and correct; a re-cost failure must not turn a
      // committed delete into a 500. The next recipe edit re-derives the cost.
      console.error(`[invoice delete] re-cost failed for session ${sessionId}:`, e)
    }
  }

  // Rows first, bytes second: the delete must succeed even if the CDN doesn't.
  const blobs = await deleteFileBlobs(session.files)

  return {
    ok: true,
    legacy: plan.legacy,
    restored: plan.summary.restored + plan.summary.bestEffort,
    deleted: plan.summary.deleted,
    skipped: plan.rows.filter(r => r.outcome === 'skipped'),
    summary: plan.summary,
    recosted,
    blobsDeleted: blobs.deleted,
    blobsFailed: blobs.failed,
  }
}
