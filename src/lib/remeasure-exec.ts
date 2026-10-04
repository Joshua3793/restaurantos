/**
 * "Change how it's measured" — the server half (item backbone Stage 2c).
 *
 * load → lock → plan → apply in ONE transaction → manifest → undo.
 *
 * The maths is all in the pure planner (src/lib/remeasure-plan.ts). This file
 * only loads its inputs (the same selects and `where`s as
 * scripts/repair-create-new-shape.ts, through the transaction client), writes
 * what it planned, and records an `ItemRemeasure` manifest holding the
 * before-value of every row it wrote so undo can replay it backwards.
 *
 * The pure parts — `buildManifest`, `undoBlocker`, `undoWrites` and the shared
 * `writtenRows` predicate — are exported for tests. Apply and the manifest read
 * the SAME `writtenRows`, so the manifest is exactly the set of rows that moved.
 */
import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, type Dimension } from '@/lib/item-model'
import {
  planRemeasure, type Bridge, type Measure, type RemeasureInput, type RemeasurePlan, type RemeasureCountLine,
} from '@/lib/remeasure-plan'
import { isMaterial } from '@/lib/invoice/create-new-repair'
import { isSafeRowId, lockItemsSql } from '@/lib/item-merge-rows'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

export type RemeasureRefusalCode =
  | 'NOT_FOUND' | 'PREP_OWNED' | 'TOMBSTONE' | 'OPEN_COUNT' | 'SAME_MEASURE'
  | 'NEEDS_BRIDGE' | 'STALE' | 'INVALID' | 'UNDO_UNSAFE'

export class RemeasureRefusal extends Error {
  constructor(public code: RemeasureRefusalCode, message: string) {
    super(message)
    this.name = 'RemeasureRefusal'
  }
}

export const REMEASURE_SENTENCE = {
  NOT_FOUND: "That item doesn't exist.",
  CHANGE_NOT_FOUND: 'That measure change was already undone.',
  PREP_OWNED: 'A recipe-made item is measured by its recipe.',
  TOMBSTONE: 'This item was merged into another.',
  OPEN_COUNT: 'This item is on a count that is still open. Finalize or discard it first.',
  STALE: 'Someone changed this item a moment ago. Reload to see their change before changing its measure.',
  UNDO_ITEM_CHANGED: 'The item has changed since — undo is no longer safe.',
  UNDO_COUNTED: 'A count was recorded since — undo is no longer safe.',
  UNDO_REMEASURED: 'Its measure was changed again since — undo that one first.',
  UNDO_RECEIVED: 'A delivery was received since — undo is no longer safe.',
  UNDO_MOVED: 'Stock was moved since — undo is no longer safe.',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The planner's input exactly — the loader fills every optional field the
 *  planner reads (supplier refs, snapshot prices, priceAtCount). */
export type RemeasureLoadedInput = RemeasureInput

export interface RemeasureManifest {
  itemId: string
  k: number
  to: Measure
  from: Measure
  item: {
    before: {
      dimension: Dimension; baseUnit: string; packChain: unknown; pricing: unknown; countUnit: string
      eachMeasureQty: number | null; eachMeasureUnit: string | null; densityGPerMl: number | null
      stockOnHand: number; lastCountQty: number | null
    }
  }
  boxes: { id: string; before: { packChain: unknown; pricing: unknown; packQty: number | null; packSize: number | null; packUOM: string | null } }[]
  receipts: { id: string; old: number | null }[]
  counts: { id: string; old: number | null; priceAtCount: number | null }[]
  snapshots: { id: string; before: { qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number } }[]
  allocations: { revenueCenterId: string; old: number }[]
  sessions: { id: string; old: number }[]
  transfers: { id: string; old: number }[]
  /** item.lastUpdated ISO written by apply — undo refuses if it moved. */
  afterLastUpdated: string
}

export interface RemeasureChange {
  id: string
  changedAt: Date
  from: Measure
  to: Measure
  canUndo: boolean
  reason: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** Plain JSON copy of a Json column's contents (never shares state with the row). */
const plain = (v: unknown): unknown => (v == null ? null : JSON.parse(JSON.stringify(v)))

/** Does the change cross COUNT? Then the bridge is the each-measure; else density. */
const crossesCount = (plan: RemeasurePlan) =>
  plan.item.before.dimension === 'COUNT' || plan.item.after.dimension === 'COUNT'

/**
 * The rows apply WRITES, and so the rows the manifest records — one predicate
 * for both. Mirrors `applyItem` in scripts/repair-create-new-shape.ts.
 */
export function writtenRows(plan: RemeasurePlan, input: Pick<RemeasureInput, 'sessions'>) {
  const receipts = plan.receipts.filter((r) => isMaterial(r.old, r.next))
  const countLines = plan.counts.filter((c) => isMaterial(c.old, c.next) || c.priceAtCount != null)
  const snapshots = plan.counts.filter((c) => c.snapshot != null)
  const unitOnly = plan.counts.filter((c) => c.snapshot == null && c.snapshotUnitOnly != null)
  // Every stock baseline is restated — the planner scales one no count sets, so
  // `next` is never null (the `?? old` only satisfies the shared StockTarget
  // type). A baseline that does not move (0 stays 0) is not written.
  const nextOf = (t: { old: number; next: number | null }) => t.next ?? t.old
  const allocations = plan.stock.allocations
    .filter((a) => isMaterial(a.old, nextOf(a)))
    .map((a) => ({ revenueCenterId: a.revenueCenterId, old: a.old, next: nextOf(a) }))
  const soh = plan.stock.stockOnHand
  const stockOnHand = isMaterial(soh.old, nextOf(soh)) ? nextOf(soh) : null
  const lcq = plan.stock.lastCountQty
  const lastCountQty = isMaterial(lcq.old, nextOf(lcq)) ? nextOf(lcq) : null
  // A session total is only re-written when one of ITS snapshots was — the
  // script's rule; a session whose snapshot was left alone keeps its total.
  const rewritten = new Set(snapshots.map((c) => c.snapshot!.id))
  const touched = new Set(input.sessions.filter((s) => s.snapshots.some((sn) => rewritten.has(sn.id))).map((s) => s.id))
  const sessions = plan.sessions.filter((s) => touched.has(s.sessionId) && isMaterial(s.old, s.next))
  const transfers = plan.transfers.filter((t) => isMaterial(t.old, t.next))
  return { receipts, countLines, snapshots, unitOnly, allocations, stockOnHand, lastCountQty, sessions, transfers }
}

/** The before-values of every row `applyRemeasure` writes. PURE. */
export function buildManifest(plan: RemeasurePlan, input: RemeasureLoadedInput, afterLastUpdated: Date): RemeasureManifest {
  const w = writtenRows(plan, input)
  const countById = new Map(input.counts.map((c) => [c.id, c]))
  const item = input.item

  const snapshotBefore = (lineId: string, snapId: string) => {
    const s = countById.get(lineId)?.snapshot
    if (!s || s.id !== snapId) throw new Error(`remeasure: no loaded snapshot ${snapId} for count line ${lineId}`)
    const qtyOnHand = numOrNull(s.qtyOnHand)
    const pricePerBaseUnit = numOrNull(s.pricePerBaseUnit)
    const totalValue = numOrNull(s.totalValue)
    // All NOT NULL columns: a missing one is a loader bug, never a 0 to restore.
    if (qtyOnHand == null || pricePerBaseUnit == null || totalValue == null) {
      throw new Error(`remeasure: snapshot ${snapId} was loaded without its quantity, price or value`)
    }
    return { id: snapId, before: { qtyOnHand, unit: s.unit ?? '', pricePerBaseUnit, totalValue } }
  }

  return {
    itemId: item.id,
    k: plan.k,
    from: { dimension: plan.item.before.dimension, unit: plan.item.before.baseUnit },
    to: { dimension: plan.summary.to.dimension, unit: plan.summary.to.unit },
    item: {
      before: {
        dimension: item.dimension as Dimension,
        baseUnit: item.baseUnit,
        packChain: plain(item.packChain ?? []),
        pricing: plain(item.pricing),
        countUnit: item.countUnit ?? item.baseUnit,
        eachMeasureQty: numOrNull(item.eachMeasureQty),
        eachMeasureUnit: item.eachMeasureUnit ?? null,
        densityGPerMl: numOrNull(item.densityGPerMl),
        stockOnHand: numOrNull(item.stockOnHand) ?? 0,
        lastCountQty: numOrNull(item.lastCountQty),
      },
    },
    boxes: plan.boxes.map((b) => ({
      id: b.id,
      before: {
        packChain: plain(b.before.packChain),
        pricing: plain(b.before.pricing),
        packQty: numOrNull(b.before.packQty),
        packSize: numOrNull(b.before.packSize),
        packUOM: b.before.packUOM ?? null,
      },
    })),
    receipts: w.receipts.map((r) => ({ id: r.id, old: r.old })),
    counts: w.countLines.map((c) => ({ id: c.id, old: c.old, priceAtCount: numOrNull(countById.get(c.id)?.priceAtCount) })),
    snapshots: [
      ...w.snapshots.map((c) => snapshotBefore(c.id, c.snapshot!.id)),
      ...w.unitOnly.map((c) => snapshotBefore(c.id, c.snapshotUnitOnly!.id)),
    ],
    allocations: w.allocations.map((a) => ({ revenueCenterId: a.revenueCenterId, old: a.old })),
    sessions: w.sessions.map((s) => ({ id: s.sessionId, old: s.old })),
    transfers: w.transfers.map((t) => ({ id: t.id, old: t.old })),
    afterLastUpdated: afterLastUpdated.toISOString(),
  }
}

/**
 * Why an undo is no longer safe, or null. PURE.
 *
 * The three required facts are the plan's. The optional ones close the gaps
 * the item's own `lastUpdated` cannot see — writes that land in the NEW base
 * without touching the item row, which a replay of the old values would leave
 * stranded: a box edited since (a non-main box edit does not bump the item),
 * a delivery approved since (a non-main supplier's invoice freezes its receipt
 * without re-pricing the item), and stock moved between revenue centers since.
 */
export function undoBlocker(
  manifest: RemeasureManifest,
  now: {
    itemLastUpdated: Date; countLinesSince: number; remeasuresSince: number
    boxesChanged?: number; receiptsSince?: number; transfersSince?: number
  },
): string | null {
  if (now.itemLastUpdated.toISOString() !== manifest.afterLastUpdated) return REMEASURE_SENTENCE.UNDO_ITEM_CHANGED
  if ((now.boxesChanged ?? 0) > 0) return REMEASURE_SENTENCE.UNDO_ITEM_CHANGED
  if (now.countLinesSince > 0) return REMEASURE_SENTENCE.UNDO_COUNTED
  if ((now.receiptsSince ?? 0) > 0) return REMEASURE_SENTENCE.UNDO_RECEIVED
  if ((now.transfersSince ?? 0) > 0) return REMEASURE_SENTENCE.UNDO_MOVED
  if (now.remeasuresSince > 0) return REMEASURE_SENTENCE.UNDO_REMEASURED
  return null
}

/** Every write an undo makes, from the manifest alone. PURE. A nullable Json
 *  column (a box's chain/pricing) gets `Prisma.DbNull` back, never a JS null. */
export function undoWrites(manifest: RemeasureManifest, now: Date) {
  const jsonOrDbNull = (v: unknown) => (v == null ? Prisma.DbNull : v)
  return {
    item: { id: manifest.itemId, data: { ...manifest.item.before, lastUpdated: now } },
    boxes: manifest.boxes.map((b) => ({
      id: b.id,
      data: {
        packChain: jsonOrDbNull(b.before.packChain),
        pricing: jsonOrDbNull(b.before.pricing),
        packQty: b.before.packQty,
        packSize: b.before.packSize,
        packUOM: b.before.packUOM,
      },
    })),
    receipts: manifest.receipts.map((r) => ({ id: r.id, data: { receivedQtyBase: r.old } })),
    counts: manifest.counts.map((c) => ({
      id: c.id,
      data: { countedQtyBase: c.old, ...(c.priceAtCount != null ? { priceAtCount: c.priceAtCount } : {}) },
    })),
    snapshots: manifest.snapshots.map((s) => ({ id: s.id, data: { ...s.before } })),
    allocations: manifest.allocations.map((a) => ({ revenueCenterId: a.revenueCenterId, data: { quantity: a.old } })),
    sessions: manifest.sessions.map((s) => ({ id: s.id, data: { totalCountedValue: s.old } })),
    transfers: manifest.transfers.map((t) => ({ id: t.id, data: { quantity: t.old } })),
  }
}

/** Null when the Json column is not a manifest — undo refuses rather than half-apply. */
function parseManifest(json: unknown): RemeasureManifest | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const m = json as Partial<RemeasureManifest>
  if (typeof m.itemId !== 'string' || typeof m.afterLastUpdated !== 'string' || !m.item?.before) return null
  for (const k of ['boxes', 'receipts', 'counts', 'snapshots', 'allocations', 'sessions', 'transfers'] as const) {
    if (!Array.isArray(m[k])) return null
  }
  return m as RemeasureManifest
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

type Db = Prisma.TransactionClient | typeof prisma

const dec = (v: unknown): string | null => (v == null ? null : String(v))

/**
 * Everything the planner reads about one item, plus the facts the refusals
 * need. Null when the item does not exist. Selects and `where`s are the
 * create-new repair script's (`fetchItems/fetchOffers/fetchLines/…`).
 */
export async function loadRemeasureInputs(db: Db, itemId: string): Promise<
  (Omit<RemeasureLoadedInput, 'to' | 'bridge'> & {
    meta: { recipe: { id: string } | null; mergedIntoId: string | null; lastUpdated: Date; inOpenCount: boolean }
  }) | null
> {
  const item = await db.inventoryItem.findUnique({
    where: { id: itemId },
    select: {
      id: true, itemName: true, stockOnHand: true, lastCountQty: true, isStocked: true,
      mergedIntoId: true, lastUpdated: true, recipe: { select: { id: true } },
      ...PRICING_SELECT,
    },
  })
  if (!item) return null

  const offers = await db.inventorySupplierPrice.findMany({
    where: { inventoryItemId: itemId },
    select: {
      id: true, supplierId: true, supplierName: true, supplierItemCode: true, isPrimary: true,
      packChain: true, pricing: true, packQty: true, packSize: true, packUOM: true,
    },
    orderBy: [{ isPrimary: 'desc' }, { supplierName: 'asc' }],
  })

  const lines = await db.invoiceScanItem.findMany({
    where: { matchedItemId: itemId, approved: true, session: { status: 'APPROVED' } },
    select: {
      id: true, sessionId: true, sortOrder: true, rawDescription: true,
      rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true, rateUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      rawUnitPrice: true, rate: true, rawLineTotal: true, receivedQtyBase: true, supplierItemCode: true,
      session: {
        select: { parentSessionId: true, supplierId: true, supplierName: true, supplier: { select: { name: true } } },
      },
    },
  })

  const countRows = await db.countLine.findMany({
    where: { inventoryItemId: itemId },
    select: {
      id: true, sessionId: true, countedQty: true, selectedUom: true,
      entries: true, countedQtyBase: true, skipped: true, priceAtCount: true,
      session: {
        select: { sessionDate: true, revenueCenterId: true, revenueCenter: { select: { isDefault: true } } },
      },
    },
    // Deterministic input order — `latestObserved` breaks a shared sessionDate
    // by input order (see the script's fetchCountLines).
    orderBy: [{ session: { sessionDate: 'asc' } }, { id: 'asc' }],
  })

  const snaps = await db.inventorySnapshot.findMany({
    where: { inventoryItemId: itemId },
    select: { id: true, sessionId: true, qtyOnHand: true, unit: true, pricePerBaseUnit: true, totalValue: true },
  })

  // Every session one of this item's snapshots sits in, with ALL its snapshots —
  // a session total is the sum of all of them, not of this item's share.
  const sessionIds = [...new Set(snaps.map((s) => s.sessionId))]
  const sessionRows = sessionIds.length
    ? await db.countSession.findMany({ where: { id: { in: sessionIds } }, select: { id: true, totalCountedValue: true } })
    : []
  const sessionSnaps = sessionIds.length
    ? await db.inventorySnapshot.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { id: true, sessionId: true, source: true, totalValue: true },
    })
    : []

  const allocations = await db.stockAllocation.findMany({
    where: { inventoryItemId: itemId },
    select: { revenueCenterId: true, quantity: true },
  })
  const transfers = await db.stockTransfer.findMany({ where: { inventoryItemId: itemId }, select: { id: true, quantity: true } })
  const recipeLines = await db.recipeIngredient.count({ where: { inventoryItemId: itemId } })
  const wastageRows = await db.wastageLog.count({ where: { inventoryItemId: itemId } })
  const openLines = await db.countLine.count({
    where: { inventoryItemId: itemId, session: { status: { not: 'FINALIZED' } } },
  })

  // Clone→parent key, identical to the script / backfill-received-qty-base:
  // parentSessionId|rawDescription|sortOrder. Two parents at one key make every
  // clone there ambiguous — the planner then leaves those clones alone.
  const byKey = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const l of lines) {
    if (l.session.parentSessionId) continue
    const key = `${l.sessionId}|${l.rawDescription}|${l.sortOrder}`
    if (byKey.has(key)) ambiguous.add(key)
    else byKey.set(key, l.id)
  }
  for (const key of ambiguous) byKey.delete(key)

  const receipts = lines.map((l) => ({
    id: l.id,
    parentLineId: l.session.parentSessionId
      ? byKey.get(`${l.session.parentSessionId}|${l.rawDescription}|${l.sortOrder}`) ?? null
      : null,
    rawQty: dec(l.rawQty), rawUnit: l.rawUnit,
    totalQty: dec(l.totalQty), totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM,
    invoicePackQty: dec(l.invoicePackQty), invoicePackSize: dec(l.invoicePackSize), invoicePackUOM: l.invoicePackUOM,
    rawUnitPrice: dec(l.rawUnitPrice), rate: dec(l.rate), rawLineTotal: dec(l.rawLineTotal),
    receivedQtyBase: dec(l.receivedQtyBase),
    // The line is received through ITS supplier's box (src/lib/invoice/line-format.ts):
    // all three fields + the line's SKU, so the planner picks the same offer approve did.
    supplierId: l.session.supplierId ?? null,
    supplierName: l.session.supplierName ?? null,
    canonicalName: l.session.supplier?.name ?? null,
    supplierItemCode: l.supplierItemCode ?? null,
  }))

  const snapBySession = new Map(snaps.map((s) => [s.sessionId, s]))
  const counts: RemeasureCountLine[] = countRows.map((c) => {
    const snap = snapBySession.get(c.sessionId)
    return {
      id: c.id,
      countedQty: c.countedQty != null ? Number(c.countedQty) : null,
      selectedUom: c.selectedUom,
      entries: c.entries,
      countedQtyBase: c.countedQtyBase != null ? Number(c.countedQtyBase) : null,
      skipped: c.skipped,
      priceAtCount: Number(c.priceAtCount),
      snapshot: snap
        ? {
          id: snap.id, qtyOnHand: Number(snap.qtyOnHand), unit: snap.unit,
          pricePerBaseUnit: Number(snap.pricePerBaseUnit), totalValue: Number(snap.totalValue),
        }
        : null,
    }
  })
  // ONE entry per count line — the planner skips a line with no session row
  // when it builds the stock baselines.
  const countSessions = countRows.map((c) => ({
    lineId: c.id,
    sessionDate: c.session.sessionDate,
    revenueCenterId: c.session.revenueCenterId,
    rcIsDefault: c.session.revenueCenter?.isDefault ?? false,
    skipped: c.skipped,
    countedQty: c.countedQty != null ? Number(c.countedQty) : null,
  }))

  return {
    item: {
      id: item.id,
      itemName: item.itemName,
      isStocked: item.isStocked,
      dimension: item.dimension,
      baseUnit: item.baseUnit,
      packChain: item.packChain,
      pricing: item.pricing,
      countUnit: item.countUnit,
      eachMeasureQty: numOrNull(item.eachMeasureQty),
      eachMeasureUnit: item.eachMeasureUnit,
      densityGPerMl: numOrNull(item.densityGPerMl),
      stockOnHand: Number(item.stockOnHand),
      lastCountQty: numOrNull(item.lastCountQty),
    },
    boxes: offers.map((o) => ({
      id: o.id,
      supplierId: o.supplierId,
      supplierName: o.supplierName,
      supplierItemCode: o.supplierItemCode,
      isPrimary: o.isPrimary,
      packChain: o.packChain,
      pricing: o.pricing,
      packQty: numOrNull(o.packQty),
      packSize: numOrNull(o.packSize),
      packUOM: o.packUOM,
    })),
    receipts,
    counts,
    countSessions,
    allocations: allocations.map((a) => ({ revenueCenterId: a.revenueCenterId, quantity: Number(a.quantity) })),
    sessions: sessionRows.map((s) => ({
      id: s.id,
      totalCountedValue: Number(s.totalCountedValue),
      snapshots: sessionSnaps.filter((sn) => sn.sessionId === s.id)
        .map((sn) => ({ id: sn.id, source: sn.source, totalValue: Number(sn.totalValue) })),
    })),
    transfers: transfers.map((t) => ({ id: t.id, quantity: Number(t.quantity) })),
    recipeLines,
    wastageRows,
    meta: { recipe: item.recipe, mergedIntoId: item.mergedIntoId, lastUpdated: item.lastUpdated, inOpenCount: openLines > 0 },
  }
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadRemeasureInputs>>>

/** The refusals, in the plan's order: NOT_FOUND, TOMBSTONE, PREP_OWNED, OPEN_COUNT. */
function refuseUnlessChangeable(loaded: Loaded | null): asserts loaded is Loaded {
  if (!loaded) throw new RemeasureRefusal('NOT_FOUND', REMEASURE_SENTENCE.NOT_FOUND)
  if (loaded.meta.mergedIntoId) throw new RemeasureRefusal('TOMBSTONE', REMEASURE_SENTENCE.TOMBSTONE)
  if (loaded.meta.recipe) throw new RemeasureRefusal('PREP_OWNED', REMEASURE_SENTENCE.PREP_OWNED)
  if (loaded.meta.inOpenCount) throw new RemeasureRefusal('OPEN_COUNT', REMEASURE_SENTENCE.OPEN_COUNT)
}

function planOrRefuse(input: RemeasureLoadedInput): RemeasurePlan {
  const r = planRemeasure(input)
  if ('error' in r) throw new RemeasureRefusal(r.code, r.error)
  if (r.errors.length > 0) throw new RemeasureRefusal('INVALID', r.errors.join('; '))
  return r
}

const inputOf = (loaded: Loaded, to: Measure, bridge: Bridge): RemeasureLoadedInput => {
  const { meta: _meta, ...rest } = loaded
  return { ...rest, to, bridge }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview / apply
// ─────────────────────────────────────────────────────────────────────────────

export async function previewRemeasure(itemId: string, to: Measure, bridge: Bridge): Promise<RemeasurePlan> {
  const loaded = await loadRemeasureInputs(prisma, itemId)
  refuseUnlessChangeable(loaded)
  return planOrRefuse(inputOf(loaded, to, bridge))
}

/** A row the plan named vanished or a unique slot was taken under us: the same
 *  race the version check catches — report it as STALE, not a 500. */
function asStale(e: unknown, sentence: string, code: RemeasureRefusalCode): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2025' || e.code === 'P2002')) {
    console.error(`[remeasure] hit ${e.code}; reported as ${code}`, e)
    return new RemeasureRefusal(code, sentence)
  }
  return e
}

const json = (v: unknown) => v as Prisma.InputJsonValue

export async function applyRemeasure(a: {
  itemId: string; to: Measure; bridge: Bridge; expectedLastUpdated: string; userId: string
}): Promise<{ remeasureId: string; plan: RemeasurePlan }> {
  // The id is interpolated into the lock's literal SQL.
  if (!isSafeRowId(a.itemId)) throw new RemeasureRefusal('NOT_FOUND', REMEASURE_SENTENCE.NOT_FOUND)

  let out: { remeasureId: string; plan: RemeasurePlan }
  try {
    out = await prisma.$transaction(async (tx) => {
      // FIRST statement: lock the item row, so nothing can attach to or edit it
      // while this re-reads, plans and writes. Literal SQL via $queryRawUnsafe —
      // the transaction-mode pooler has no named prepared statements.
      await tx.$queryRawUnsafe(lockItemsSql([a.itemId]))

      const loaded = await loadRemeasureInputs(tx, a.itemId)
      refuseUnlessChangeable(loaded)
      if (loaded.meta.lastUpdated.toISOString() !== a.expectedLastUpdated) {
        throw new RemeasureRefusal('STALE', REMEASURE_SENTENCE.STALE)
      }
      const input = inputOf(loaded, a.to, a.bridge)
      const plan = planOrRefuse(input)
      const now = new Date()
      const w = writtenRows(plan, input)

      // Boxes — every one: the dimension moved under all of them. The human pack
      // format no longer describes the rewritten chain, so it is cleared.
      for (const b of plan.boxes) {
        await tx.inventorySupplierPrice.update({
          where: { id: b.id },
          data: {
            packChain: json(b.packChain), pricing: json(b.pricing),
            packQty: null, packSize: null, packUOM: null,
            lastUpdated: now,
          },
        })
      }
      for (const r of w.receipts) {
        await tx.invoiceScanItem.update({ where: { id: r.id }, data: { receivedQtyBase: r.next } })
      }
      for (const c of w.countLines) {
        await tx.countLine.update({
          where: { id: c.id },
          data: {
            ...(isMaterial(c.old, c.next) ? { countedQtyBase: c.next } : {}),
            ...(c.priceAtCount != null ? { priceAtCount: c.priceAtCount } : {}),
          },
        })
      }
      for (const c of w.snapshots) {
        const s = c.snapshot!
        await tx.inventorySnapshot.update({
          where: { id: s.id },
          data: { qtyOnHand: s.qtyOnHand, unit: s.unit, pricePerBaseUnit: s.pricePerBaseUnit, totalValue: s.totalValue },
        })
      }
      for (const c of w.unitOnly) {
        // A SKIPPED / THEORETICAL snapshot: its expected quantity and $/base
        // restated in the new base, its unit label with them; value unchanged.
        const s = c.snapshotUnitOnly!
        await tx.inventorySnapshot.update({
          where: { id: s.id },
          data: { unit: s.unit, qtyOnHand: s.qtyOnHand, pricePerBaseUnit: s.pricePerBaseUnit },
        })
      }
      for (const al of w.allocations) {
        await tx.stockAllocation.update({
          where: { revenueCenterId_inventoryItemId: { revenueCenterId: al.revenueCenterId, inventoryItemId: a.itemId } },
          data: { quantity: al.next },
        })
      }
      for (const s of w.sessions) {
        await tx.countSession.update({ where: { id: s.sessionId }, data: { totalCountedValue: s.next } })
      }
      for (const t of w.transfers) {
        await tx.stockTransfer.update({ where: { id: t.id }, data: { quantity: t.next } })
      }

      const after = plan.item.after
      // The bridge the change went through is WRITTEN onto the item, so recipe
      // lines and counts in the old unit keep resolving through it.
      const bridgeData = crossesCount(plan)
        ? { eachMeasureQty: plan.item.eachMeasure?.qty ?? null, eachMeasureUnit: plan.item.eachMeasure?.unit ?? null }
        : { densityGPerMl: plan.item.densityGPerMl ?? null }
      await tx.inventoryItem.update({
        where: { id: a.itemId },
        data: {
          dimension: after.dimension,
          baseUnit: after.baseUnit,
          packChain: json(after.packChain),
          pricing: json(after.pricing),
          countUnit: after.countUnit,
          ...(w.stockOnHand != null ? { stockOnHand: w.stockOnHand } : {}),
          ...(w.lastCountQty != null ? { lastCountQty: w.lastCountQty } : {}),
          ...bridgeData,
          lastUpdated: now,
        },
      })

      const row = await tx.itemRemeasure.create({
        data: { itemId: a.itemId, changedBy: a.userId, manifest: json(buildManifest(plan, input, now)) },
        select: { id: true },
      })
      return { remeasureId: row.id, plan }
    }, { maxWait: 10_000, timeout: 120_000 })
  } catch (e) {
    throw asStale(e, REMEASURE_SENTENCE.STALE, 'STALE')
  }

  await propagatePrepCostChanges([a.itemId])
  invalidateTheoreticalCache()
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// List / undo
// ─────────────────────────────────────────────────────────────────────────────

type RemeasureRow = { id: string; itemId: string; changedAt: Date; manifest: unknown }

/** The "since the change" facts `undoBlocker` judges. */
async function sinceFacts(db: Db, row: RemeasureRow, manifest: RemeasureManifest) {
  const item = await db.inventoryItem.findUnique({ where: { id: row.itemId }, select: { lastUpdated: true } })
  // Apply stamped every box with the same instant as the item; a box that is
  // gone or carries another stamp was edited (or removed) since.
  const boxIds = manifest.boxes.map((b) => b.id)
  const boxesNow = boxIds.length
    ? await db.inventorySupplierPrice.findMany({ where: { id: { in: boxIds } }, select: { lastUpdated: true } })
    : []
  const boxesChanged = boxIds.length - boxesNow.filter((b) => b.lastUpdated.toISOString() === manifest.afterLastUpdated).length
  const receiptsSince = await db.invoiceScanItem.count({
    where: { matchedItemId: row.itemId, approved: true, session: { status: 'APPROVED', approvedAt: { gt: row.changedAt } } },
  })
  const transfersSince = await db.stockTransfer.count({ where: { inventoryItemId: row.itemId, createdAt: { gt: row.changedAt } } })
  // CountSession has no createdAt — `startedAt` (default now()) is when it began.
  const countLinesSince = await db.countLine.count({
    where: { inventoryItemId: row.itemId, session: { startedAt: { gt: row.changedAt } } },
  })
  const remeasuresSince = await db.itemRemeasure.count({
    where: { itemId: row.itemId, undoneAt: null, changedAt: { gt: row.changedAt } },
  })
  return { item, countLinesSince, remeasuresSince, boxesChanged, receiptsSince, transfersSince }
}

async function blockerFor(db: Db, row: RemeasureRow): Promise<string | null> {
  const manifest = parseManifest(row.manifest)
  if (!manifest) return 'This change’s record cannot be read, so it cannot be reversed.'
  const { item, ...f } = await sinceFacts(db, row, manifest)
  if (!item) return REMEASURE_SENTENCE.UNDO_ITEM_CHANGED
  return undoBlocker(manifest, { itemLastUpdated: item.lastUpdated, ...f })
}

/** The item's measure changes that have not been undone, newest first. */
export async function listRemeasures(itemId: string): Promise<RemeasureChange[]> {
  const rows = await prisma.itemRemeasure.findMany({
    where: { itemId, undoneAt: null },
    orderBy: { changedAt: 'desc' },
  })
  const out: RemeasureChange[] = []
  for (const r of rows) {
    const m = parseManifest(r.manifest)
    const reason = await blockerFor(prisma, r)
    out.push({
      id: r.id,
      changedAt: r.changedAt,
      from: m?.from ?? { dimension: 'COUNT', unit: 'each' },
      to: m?.to ?? { dimension: 'COUNT', unit: 'each' },
      canUndo: reason == null,
      reason,
    })
  }
  return out
}

/** Replay a manifest backwards, in one transaction with the item locked. */
export async function undoRemeasure(id: string): Promise<void> {
  const row = await prisma.itemRemeasure.findUnique({ where: { id } })
  if (!row || row.undoneAt) throw new RemeasureRefusal('NOT_FOUND', REMEASURE_SENTENCE.CHANGE_NOT_FOUND)
  const manifest = parseManifest(row.manifest)
  if (!manifest) throw new RemeasureRefusal('UNDO_UNSAFE', 'This change’s record cannot be read, so it cannot be reversed.')
  if (!isSafeRowId(manifest.itemId)) throw new RemeasureRefusal('UNDO_UNSAFE', REMEASURE_SENTENCE.UNDO_ITEM_CHANGED)

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(lockItemsSql([manifest.itemId]))

      // Re-read inside the transaction: two managers clicking Undo at once must
      // not replay the manifest twice, and the "since" facts must be the ones
      // this transaction acts on.
      const fresh = await tx.itemRemeasure.findUnique({ where: { id }, select: { undoneAt: true } })
      if (!fresh || fresh.undoneAt) throw new RemeasureRefusal('NOT_FOUND', REMEASURE_SENTENCE.CHANGE_NOT_FOUND)
      const blocked = await blockerFor(tx, row)
      if (blocked) throw new RemeasureRefusal('UNDO_UNSAFE', blocked)

      const now = new Date()
      const w = undoWrites(manifest, now)
      for (const b of w.boxes) {
        await tx.inventorySupplierPrice.update({
          where: { id: b.id },
          data: { ...b.data, packChain: b.data.packChain as Prisma.InputJsonValue, pricing: b.data.pricing as Prisma.InputJsonValue, lastUpdated: now },
        })
      }
      for (const r of w.receipts) await tx.invoiceScanItem.update({ where: { id: r.id }, data: r.data })
      for (const c of w.counts) await tx.countLine.update({ where: { id: c.id }, data: c.data })
      for (const s of w.snapshots) await tx.inventorySnapshot.update({ where: { id: s.id }, data: s.data })
      for (const al of w.allocations) {
        await tx.stockAllocation.update({
          where: { revenueCenterId_inventoryItemId: { revenueCenterId: al.revenueCenterId, inventoryItemId: manifest.itemId } },
          data: al.data,
        })
      }
      for (const s of w.sessions) await tx.countSession.update({ where: { id: s.id }, data: s.data })
      for (const t of w.transfers) await tx.stockTransfer.update({ where: { id: t.id }, data: t.data })
      await tx.inventoryItem.update({
        where: { id: w.item.id },
        data: { ...w.item.data, packChain: json(w.item.data.packChain), pricing: json(w.item.data.pricing) },
      })
      await tx.itemRemeasure.update({ where: { id }, data: { undoneAt: now } })
    }, { maxWait: 10_000, timeout: 120_000 })
  } catch (e) {
    throw asStale(e, REMEASURE_SENTENCE.UNDO_ITEM_CHANGED, 'UNDO_UNSAFE')
  }

  await propagatePrepCostChanges([manifest.itemId])
  invalidateTheoreticalCache()
}
