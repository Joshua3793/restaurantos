import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { asChainItem, PRICING_SELECT } from '@/lib/item-model'
import { computeExpectedForItem } from '@/lib/count-expected'
import {
  planMerge, planUndo, type MergeItemRow, type MergeManifest, type MergeOp, type MergePlan,
  type MergeRelations, type MergeSummary, type SurvivorRelations, type UpdateTable,
} from '@/lib/item-merge'
import {
  asCountEntries, batchUpdateOps, mergeOpOrder, parseManifest, recipeIngredientRepointIds,
  repointTableChecks, REPOINT_FK, TABLE_DELEGATE, toPlainRow, undoOpOrder, writeData,
  type BatchedOp,
} from '@/lib/item-merge-rows'

/**
 * Plans a merge (with the PURE planner in src/lib/item-merge.ts), applies the
 * manifest, and undoes one. The manifest is the complete record of every write a
 * merge makes — this module adds none of its own: no `ensurePrimary`, no
 * re-election, no stock recompute. The single exception lives OUTSIDE the merge:
 * the optional combined-on-hand Quick Count the route records afterwards, which
 * is not in the manifest, cannot be inverted, and is exactly why `undoBlocker`
 * refuses an undo once the survivor has been counted since the merge.
 *
 * The plan is built INSIDE the merge transaction, with the transaction's own
 * client, so a row attached to the absorbed item between "what shall we do" and
 * "do it" cannot be stranded on the tombstone. See `planAndExecuteMerge`.
 */

const n = (v: unknown) => (v == null ? 0 : Number(v))

/** Either the singleton or a transaction client — `prisma` is assignable to
 *  `Prisma.TransactionClient`, so one parameter type serves both. */
export type MergeDb = Prisma.TransactionClient

/** A merge or undo that is no longer valid against the rows as they are NOW —
 *  two managers clicking Merge at once, an undo racing another undo. Routes map
 *  it to 409. */
export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeConflictError'
  }
}

/**
 * A manifest describes rows as they were when it was planned. If one of them has
 * since been deleted (P2025) or something else has taken a unique slot it needs
 * (P2002), this is the same race the explicit guard catches — the transaction
 * has already rolled back, so report it as a conflict rather than a 500.
 */
function asConflict(e: unknown, what: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2025' || e.code === 'P2002'))
    return new MergeConflictError(`The data changed while the ${what} was running. Nothing was changed — try again.`)
  return e
}

// ── loading ──────────────────────────────────────────────────────────────────

/**
 * Theoretical on-hand for both items, from the ledger.
 *
 * Computed BEFORE the merge transaction opens and passed in, never from inside
 * one: `computeExpectedForItem` reaches for the global prisma singleton
 * internally, so calling it mid-transaction would occupy a SECOND pooled
 * connection while the first is held — the classic way to starve a small pool.
 *
 * Being a few milliseconds stale is safe here. These two numbers feed exactly
 * one thing, the `NEEDS_ON_HAND` guard, which is advisory about STOCK ("does
 * this item still show any, so must the person type a combined figure?") and
 * says nothing about which rows belong to whom. Every guard that IS about row
 * ownership — TOMBSTONE, OPEN_COUNT — reads rows loaded inside the transaction.
 */
export async function loadTheoreticalOnHand(survivorId: string, absorbedId: string): Promise<MergeOnHand> {
  // rcId null ⇒ summed across every RC, the same total the item drawer shows.
  const [s, a] = await Promise.all([
    computeExpectedForItem(survivorId, null),
    computeExpectedForItem(absorbedId, null),
  ])
  return { survivor: n(s?.expectedBase), absorbed: n(a?.expectedBase) }
}

export interface MergeOnHand { survivor: number; absorbed: number }

async function itemRow(db: MergeDb, id: string, theoreticalOnHand: number): Promise<MergeItemRow | null> {
  const r = await db.inventoryItem.findUnique({
    where: { id },
    select: {
      id: true, itemName: true, isActive: true, mergedIntoId: true, stockOnHand: true,
      ...PRICING_SELECT,
      recipe: { select: { id: true } },
      // Anything not FINALIZED is still open — UPDATING is the transitional
      // state the count page sets while a finalize is in flight.
      countLines: { where: { session: { status: { not: 'FINALIZED' } } }, select: { id: true }, take: 1 },
    },
  })
  if (!r) return null
  const c = asChainItem(r)
  return {
    id: r.id,
    itemName: r.itemName,
    baseUnit: c.baseUnit,
    dimension: c.dimension,
    countUnit: c.countUnit ?? c.baseUnit,
    packChain: c.packChain,
    pricing: c.pricing,
    stockOnHand: n(r.stockOnHand),
    eachMeasure: c.eachMeasure ?? null,
    densityGPerMl: c.densityGPerMl ?? null,
    isActive: r.isActive,
    mergedIntoId: r.mergedIntoId,
    ownedByRecipe: !!r.recipe,
    inOpenCount: r.countLines.length > 0,
    theoreticalOnHand,
  }
}

/**
 * Everything `planMerge` needs, as PLAIN JSON.
 *
 * Every value that can reach an op's `row`/`before`/`after` goes through
 * `toPlainRow` (Decimal → number, Date → ISO string, no undefined) because the
 * manifest is stored in a Json column and replayed, possibly months later, by
 * `undoMerge`. Rows for tables the planner can DELETE (offers, snapshots,
 * allocations, item↔RC rows — on both sides for offers) are loaded WHOLE, not
 * as a field subset, so undo's matching `create` restores columns the planner
 * never knew about.
 *
 * `db` is the transaction client for a real merge (so the plan and the writes
 * see ONE snapshot of the relations) and the plain singleton for a dry run.
 * `onHand` comes from {@link loadTheoreticalOnHand}; omitted, it is fetched here
 * — which is right for a dry run and wrong inside a transaction.
 */
export async function loadMergeInputs(
  survivorId: string,
  absorbedId: string,
  db: MergeDb = prisma,
  onHand?: MergeOnHand,
): Promise<{
  survivor: MergeItemRow; absorbed: MergeItemRow; rel: MergeRelations; sRel: SurvivorRelations
} | null> {
  // SEQUENTIAL, not Promise.all: `db` is an interactive transaction client on
  // the merge path, which is ONE connection, and no site in this repo has ever
  // issued concurrent queries on one. The extra round trips are noise next to
  // the ledger read that already happened above.
  const oh = onHand ?? await loadTheoreticalOnHand(survivorId, absorbedId)
  const survivor = await itemRow(db, survivorId, oh.survivor)
  const absorbed = await itemRow(db, absorbedId, oh.absorbed)
  if (!survivor || !absorbed) return null

  const w = { inventoryItemId: absorbedId }
  const scan = await db.invoiceScanItem.findMany({ where: { matchedItemId: absorbedId }, select: { id: true } })
  const ili = await db.invoiceLineItem.findMany({ where: w, select: { id: true } })
  const pa = await db.priceAlert.findMany({ where: w, select: { id: true } })
  const mr = await db.invoiceMatchRule.findMany({ where: w, select: { id: true } })
  const tr = await db.stockTransfer.findMany({ where: w, select: { id: true } })
  const wl = await db.wastageLog.findMany({ where: w, select: { id: true } })
  const ri = await db.recipeIngredient.findMany({ where: w, select: { id: true, unit: true } })
  const cl = await db.countLine.findMany({
    where: w,
    select: {
      id: true, countedQtyBase: true,
      countedQty: true, selectedUom: true, entries: true,
    },
  })
  const sn = await db.inventorySnapshot.findMany({ where: w })
  const of = await db.inventorySupplierPrice.findMany({ where: w })
  const al = await db.stockAllocation.findMany({ where: w })
  const rc = await db.itemRevenueCenter.findMany({ where: w })
  const prior = await db.inventoryItem.findMany({ where: { mergedIntoId: absorbedId }, select: { id: true } })
  const last = await db.invoiceScanItem.findFirst({
    where: { matchedItemId: absorbedId, approved: true, session: { supplierName: { not: null } } },
    orderBy: { session: { purchaseDate: 'desc' } },
    select: { session: { select: { supplierId: true, supplierName: true } } },
  })

  const rel: MergeRelations = {
    scanItemIds: scan.map(x => x.id),
    invoiceLineItemIds: ili.map(x => x.id),
    priceAlertIds: pa.map(x => x.id),
    matchRuleIds: mr.map(x => x.id),
    transferIds: tr.map(x => x.id),
    wastageIds: wl.map(x => x.id),
    recipeIngredients: ri.map(x => ({ id: x.id, unit: x.unit })),
    countLines: cl.map(x => ({
      id: x.id,
      countedQtyBase: x.countedQtyBase == null ? null : Number(x.countedQtyBase),
      countedQty: x.countedQty == null ? null : Number(x.countedQty),
      selectedUom: x.selectedUom,
      entries: asCountEntries(x.entries),
    })),
    snapshots: sn.map(x => ({
      ...toPlainRow(x),
      id: x.id, sessionId: x.sessionId, unit: x.unit, source: x.source,
      qtyOnHand: n(x.qtyOnHand), pricePerBaseUnit: n(x.pricePerBaseUnit), totalValue: n(x.totalValue),
    })),
    // every column is here, not a subset, because a dropped offer's delete op
    // has to re-create the row on undo.
    offers: of.map(o => ({
      ...toPlainRow(o),
      id: o.id, supplierName: o.supplierName, supplierId: o.supplierId,
      isPrimary: o.isPrimary, lastUpdated: o.lastUpdated.toISOString(),
    })),
    allocations: al.map(a => ({
      ...toPlainRow(a),
      id: a.id, revenueCenterId: a.revenueCenterId, quantity: n(a.quantity),
      parLevel: a.parLevel == null ? null : Number(a.parLevel),
      reorderQty: a.reorderQty == null ? null : Number(a.reorderQty),
    })),
    itemRcs: rc.map(r => ({ ...toPlainRow(r), id: r.id, revenueCenterId: r.revenueCenterId })),
    latestPurchaseSupplier: last?.session.supplierName
      ? { supplierId: last.session.supplierId, supplierName: last.session.supplierName }
      : null,
    priorAbsorbeeIds: prior.map(x => x.id),
  }

  const sw = { inventoryItemId: survivorId }
  const sOf = await db.inventorySupplierPrice.findMany({ where: sw })
  const sAl = await db.stockAllocation.findMany({ where: sw, select: { id: true, revenueCenterId: true, quantity: true } })
  const sRc = await db.itemRevenueCenter.findMany({ where: sw, select: { revenueCenterId: true } })
  // Only the sessions the absorbed item also has a snapshot in can collide.
  const sSn = await db.inventorySnapshot.findMany({ where: { ...sw, sessionId: { in: sn.map(x => x.sessionId) } } })

  const sRel: SurvivorRelations = {
    offers: sOf.map(o => ({
      ...toPlainRow(o),
      id: o.id, supplierName: o.supplierName, isPrimary: o.isPrimary, lastUpdated: o.lastUpdated.toISOString(),
    })),
    allocations: sAl.map(a => ({ id: a.id, revenueCenterId: a.revenueCenterId, quantity: n(a.quantity) })),
    itemRcs: sRc,
    snapshots: sSn.map(x => ({
      id: x.id, sessionId: x.sessionId, qtyOnHand: n(x.qtyOnHand), totalValue: n(x.totalValue), source: x.source,
    })),
  }

  return { survivor, absorbed, rel, sRel }
}

// ── applying ─────────────────────────────────────────────────────────────────

interface Delegate {
  updateMany(a: { where: object; data: object }): Promise<unknown>
  update(a: { where: object; data: object }): Promise<unknown>
  delete(a: { where: object }): Promise<unknown>
  create(a: { data: object }): Promise<unknown>
  count(a: { where: object }): Promise<number>
}

const delegateFor = (tx: Prisma.TransactionClient, table: UpdateTable): Delegate =>
  (tx as unknown as Record<string, Delegate>)[TABLE_DELEGATE[table]]

/**
 * One op. A `repoint` is ONE `updateMany` — a busy item carries hundreds of
 * scan lines and a loop of single updates would blow the transaction budget —
 * and `batchUpdateOps` has already collapsed any run of consecutive identical
 * `update`s into an `updateMany` too. What is left is per-row by nature and
 * stays sequential: no `Promise.all` inside an interactive transaction.
 */
async function applyOp(tx: Prisma.TransactionClient, op: BatchedOp, repointTo: string): Promise<void> {
  const d = delegateFor(tx, op.table)
  if (op.t === 'repoint') {
    if (op.ids.length === 0) return
    await d.updateMany({ where: { id: { in: op.ids } }, data: { [REPOINT_FK[op.table]]: repointTo } })
    return
  }
  if (op.t === 'updateMany') {
    await d.updateMany({ where: { id: { in: op.ids } }, data: writeData(op.table, op.after) })
    return
  }
  if (op.t === 'update') {
    await d.update({ where: { id: op.id }, data: writeData(op.table, op.after) })
    return
  }
  const id = op.row.id
  if (op.t === 'delete') {
    if (typeof id !== 'string') throw new Error(`Manifest ${op.table} delete op has no row id`)
    await d.delete({ where: { id } })
    return
  }
  if (typeof id !== 'string') throw new Error(`Manifest ${op.table} create op has no row id`)
  await d.create({ data: writeData(op.table, op.row) })
}

async function applyOps(tx: Prisma.TransactionClient, ops: MergeOp[], repointTo: string): Promise<void> {
  for (const op of batchUpdateOps(ops)) await applyOp(tx, op, repointTo)
}

// ── merge ────────────────────────────────────────────────────────────────────

/** Re-check, with the transaction's own client, that the plan still describes
 *  reality. Between planning and this moment another manager may have merged
 *  either row away, deactivated it, or opened a count on it. */
async function assertStillMergeable(tx: Prisma.TransactionClient, survivorId: string, absorbedId: string): Promise<void> {
  for (const [role, id] of [['survivor', survivorId], ['absorbed', absorbedId]] as const) {
    const row = await tx.inventoryItem.findUnique({
      where: { id },
      select: { id: true, itemName: true, isActive: true, mergedIntoId: true },
    })
    if (!row) throw new MergeConflictError(`The ${role} item no longer exists.`)
    if (row.mergedIntoId || !row.isActive)
      throw new MergeConflictError(`${row.itemName} was merged or deactivated while this merge was being prepared.`)
    const open = await tx.countLine.findFirst({
      where: { inventoryItemId: id, session: { status: { not: 'FINALIZED' } } },
      select: { id: true },
    })
    if (open) throw new MergeConflictError(`${row.itemName} was added to an open count while this merge was being prepared.`)
  }
}

/**
 * After every op has been applied: nothing anywhere may still point at the
 * absorbed item.
 *
 * The plan is built inside this transaction, but READ COMMITTED means a row
 * another session INSERTED after that load and COMMITTED before ours is simply
 * invisible to it — an invoice approved, a wastage logged, a recipe line
 * re-pointed, in the seconds the merge takes. Such a row would survive the
 * merge attached to a tombstone, silently. One count per re-pointable table
 * (the list derived from the same FK map the re-points use, so a new table
 * cannot be forgotten) turns that into a refusal instead.
 *
 * Zero is the only correct answer: every row the planner loads is either
 * re-pointed or deleted, on every table.
 */
async function assertNothingLeftOnAbsorbed(tx: Prisma.TransactionClient, absorbedId: string): Promise<void> {
  for (const { table, fk } of repointTableChecks()) {
    const left = await delegateFor(tx, table).count({ where: { [fk]: absorbedId } })
    if (left > 0)
      throw new MergeConflictError(
        `${left} ${table} row(s) were attached to the absorbed item while this merge was running.`)
  }
}

export type MergeOutcome =
  | { ok: true; mergeId: string; summary: MergeSummary }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'guard'; plan: Extract<MergePlan, { ok: false }> }

/**
 * Plan and apply a merge in ONE interactive transaction.
 *
 * The plan is built HERE, with the transaction's own client, not handed in:
 * planning outside and applying inside leaves a window in which a row attached
 * to the absorbed item is missing from the manifest and ends up stranded on the
 * tombstone. Order of business:
 *
 *   1. re-read both item rows (a conflict → 409, clearer than a guard),
 *   2. load every relation with `tx`,
 *   3. `planMerge` — a guard here aborts with nothing written (the callback
 *      returns early; the transaction commits, having done nothing),
 *   4. apply: all `delete` ops first (each frees a unique slot a later re-point
 *      needs), then the rest in the planner's own order — deliberately arranged
 *      (offer demote before re-point, promote after) so no step trips the
 *      partial unique index on a primary offer,
 *   5. prove nothing still references the absorbed item,
 *   6. record the manifest.
 *
 * `onHand` is the one input from outside the transaction — see
 * {@link loadTheoreticalOnHand} for why that is safe.
 */
export async function planAndExecuteMerge(a: {
  survivorId: string
  absorbedId: string
  combinedOnHandProvided: boolean
  onHand: MergeOnHand
  mergedBy: string
  newId: () => string
}): Promise<MergeOutcome> {
  try {
    return await prisma.$transaction(async (tx): Promise<MergeOutcome> => {
      await assertStillMergeable(tx, a.survivorId, a.absorbedId)

      const inputs = await loadMergeInputs(a.survivorId, a.absorbedId, tx, a.onHand)
      if (!inputs) return { ok: false, kind: 'not_found' }

      const plan = planMerge(inputs.survivor, inputs.absorbed, inputs.rel, inputs.sRel, {
        combinedOnHandProvided: a.combinedOnHandProvided,
        newId: a.newId,
      })
      if (!plan.ok) return { ok: false, kind: 'guard', plan }

      await applyOps(tx, mergeOpOrder(plan.manifest.ops), a.survivorId)
      await assertNothingLeftOnAbsorbed(tx, a.absorbedId)

      const merge = await tx.itemMerge.create({
        data: {
          survivorId: plan.manifest.survivorId,
          absorbedId: plan.manifest.absorbedId,
          mergedBy: a.mergedBy,
          manifest: plan.manifest as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
      return { ok: true, mergeId: merge.id, summary: plan.summary }
    }, { timeout: 30_000, maxWait: 15_000 })
  } catch (e) {
    throw asConflict(e, 'merge')
  }
}

// ── undo ─────────────────────────────────────────────────────────────────────

export interface UndoableMerge {
  survivorId: string
  absorbedId: string
  mergedAt: Date
  manifest: unknown
}

/**
 * Why this merge can no longer be undone, or null when it still can.
 *
 * Undo rewrites history rows back onto the absorbed item. That is safe only
 * while nothing NEW hangs off the survivor through a relationship the merge
 * re-pointed — and only while the absorbed row is still the tombstone the merge
 * made it.
 */
export async function undoBlocker(merge: UndoableMerge): Promise<string | null> {
  const since = { gte: merge.mergedAt }
  const manifest = parseManifest(merge.manifest)
  if (!manifest) return 'This merge’s record cannot be read, so it cannot be reversed.'

  const recipeLineIds = recipeIngredientRepointIds(manifest)
  // The singleton on purpose: this runs BEFORE (and outside) the undo
  // transaction, and the route also calls it per row when listing merges.
  const [inv, cnt, rec, absorbed] = await Promise.all([
    prisma.invoiceScanItem.count({
      where: { matchedItemId: merge.survivorId, approved: true, session: { approvedAt: since } },
    }),
    prisma.countLine.count({
      where: { inventoryItemId: merge.survivorId, session: { finalizedAt: since } },
    }),
    recipeLineIds.length === 0 ? Promise.resolve(0) : prisma.recipe.count({
      where: {
        updatedAt: since,
        ingredients: { some: { id: { in: recipeLineIds }, inventoryItemId: merge.survivorId } },
      },
    }),
    prisma.inventoryItem.findUnique({
      where: { id: merge.absorbedId },
      select: { isActive: true, mergedIntoId: true },
    }),
  ])

  // The combined-on-hand Quick Count the merge route records is NOT in the
  // manifest and cannot be inverted — this is the check that catches it.
  if (cnt) return 'This item has been counted since the merge.'
  if (inv) return 'An invoice has been approved on this item since the merge.'
  if (rec) return 'A recipe using this item has been edited since the merge.'
  if (!absorbed) return 'The absorbed item no longer exists.'
  if (absorbed.mergedIntoId !== merge.survivorId || absorbed.isActive)
    return 'The absorbed item is no longer the tombstone this merge left behind.'
  return null
}

/**
 * Reverse a merge: `planUndo`'s ops (inverted, reverse order) with every
 * re-point aimed back at the absorbed item — non-`create` ops first, then the
 * `create`s, so a restored row only lands once the re-points have freed its
 * unique slot.
 */
export async function undoMerge(mergeId: string): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const merge = await prisma.itemMerge.findUnique({ where: { id: mergeId } })
  if (!merge || merge.undoneAt) return { ok: false, status: 404, error: 'Merge not found or already undone.' }

  const manifest = parseManifest(merge.manifest)
  if (!manifest) return { ok: false, status: 409, error: 'Undo is no longer safe: this merge’s record cannot be read.' }

  const blocker = await undoBlocker(merge)
  if (blocker) return { ok: false, status: 409, error: `Undo is no longer safe: ${blocker}` }

  try {
    await prisma.$transaction(async tx => {
      // Same re-read-inside-the-transaction guard the merge uses: two managers
      // clicking Undo at once must not replay the manifest twice.
      const fresh = await tx.itemMerge.findUnique({ where: { id: mergeId }, select: { undoneAt: true } })
      if (!fresh || fresh.undoneAt) throw new MergeConflictError('This merge was already undone.')
      const absorbed = await tx.inventoryItem.findUnique({
        where: { id: manifest.absorbedId },
        select: { isActive: true, mergedIntoId: true },
      })
      if (!absorbed || absorbed.mergedIntoId !== manifest.survivorId || absorbed.isActive)
        throw new MergeConflictError('The absorbed item is no longer the tombstone this merge left behind.')

      await applyOps(tx, undoOpOrder(planUndo(manifest)), manifest.absorbedId)
      await tx.itemMerge.update({ where: { id: mergeId }, data: { undoneAt: new Date() } })
    }, { timeout: 30_000, maxWait: 15_000 })
  } catch (raw) {
    const e = asConflict(raw, 'undo')
    if (e instanceof MergeConflictError) return { ok: false, status: 409, error: `Undo is no longer safe: ${e.message}` }
    throw e
  }
  return { ok: true }
}
