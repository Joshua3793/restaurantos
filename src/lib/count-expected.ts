import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { computeScale } from '@/lib/prep-utils'
import { portionsPerBatch } from '@/lib/recipe-portions'
import { asChainItem, PRICING_SELECT } from '@/lib/item-model'
import { parseInvoiceDate } from '@/lib/purchase-date'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'

/**
 * ── Ledger sink ─────────────────────────────────────────────────────────────
 *
 * The drawer's movement track used to be a hand-rolled second implementation of
 * everything below: its own purchase query, its own prep traversal, its own
 * window rule. It drifted on every axis — most visibly it multiplied a
 * catch-weight line's billed weight by the case size (44.61 lb received showed
 * as "+446.10 lb"), and it dated prep by `updatedAt`, so a data-repair script
 * that touched a June log resurrected it into the August ledger.
 *
 * There is no second implementation any more. A caller that wants the individual
 * movements passes a sink, and every builder below records an event at the exact
 * line where it accumulates into its map. The list and the total are therefore
 * the same computation, and cannot disagree.
 */
export type LedgerEventType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE' | 'TRANSFER'

export interface LedgerEvent {
  id:          string
  /** The date the movement is APPLIED on — received date, log date, sale date. */
  date:        Date
  type:        LedgerEventType
  itemId:      string
  /** Signed, in the item's baseUnit: positive adds stock, negative removes it. */
  qtyBase:     number
  description: string
  revenueCenterId: string | null
}

/** Collects events as the maps are built. Array-compatible on purpose. */
export interface LedgerSink { push(event: LedgerEvent): void }

/**
 * Threaded through {@link getTheoreticalStockMap} by a caller that needs to show
 * its WORKING, not just its answer.
 *
 * `onRcResult` fires once per (revenue centre, item) with the baseline the sum
 * started from and the floored result it ended at. Because "All RCs" is Σ RC and
 * each RC is floored at zero independently, Σ baselines + Σ events does not always
 * equal the total — the caller reconciles the difference explicitly rather than
 * quietly presenting a column that doesn't add up.
 */
export interface TheoreticalTrace {
  sink: LedgerSink
  onRcResult?: (rcId: string, itemId: string, baseStock: number, expected: number) => void
}

type IngredientWithLinks = {
  inventoryItemId: string | null
  inventoryItem:   { id: string; baseUnit: string } | null
  linkedRecipeId:  string | null
  linkedRecipe: null | {
    id: string
    inventoryItemId: string | null
    inventoryItem:   { id: string; baseUnit: string } | null
    ingredients: Array<{
      inventoryItemId: string | null
      inventoryItem:   { id: string; baseUnit: string } | null
      qtyBase: string | number | { toString(): string }
      unit: string
    }>
  }
  qtyBase: string | number | { toString(): string }
  unit: string
}

type RecipeForExpansion = {
  id: string
  ingredients: IngredientWithLinks[]
}

/**
 * Per-item lookback gate. The movement maps are queried over a single wide
 * window (the earliest `lastCountDate` in the batch) for efficiency, but each
 * item's baseline is its OWN count.
 *
 * A count OWNS its day: the physical count on day D already reflects every
 * movement dated on/before D, so an event may only be applied to item X if it
 * occurred STRICTLY AFTER the day of X's own `lastCountDate`. `lastCountDate`
 * is day-floored (the session's date, no time), so the gate is
 * `eventDate >= lastCountDate + 1 day`. Anything dated on the count day itself
 * is already baked into the baseline and would be double-counted.
 *
 * When `cutoff` is omitted, every event passes (legacy single-window behaviour).
 * When provided, an item present in the map is gated at its own count day.
 * An item ABSENT from the map has never been counted: its baseline is its current
 * `stockOnHand` (0 for most items, an imported opening balance for a few), so its
 * entire movement history is "new" and must be applied — every event passes.
 * (Previously such items received nothing, which silently dropped their purchases.)
 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `until` closes the window at the top. A count is a statement about one date, so
 * its expected quantities must reflect the world on THAT date — movements after it
 * belong to the next period. Without an upper bound, re-syncing a session weeks
 * later rebuilds its baseline against today and subtracts everything consumed since:
 * the reopened 1 Aug count had 177 of 413 lines driven to zero, because stock that
 * was genuinely on the shelf on the 1st had been eaten by the 11th.
 *
 * Omitted for live theoretical stock, which legitimately means "as of now".
 */
function inWindow(
  cutoff: Map<string, Date> | undefined,
  id: string,
  date: Date,
  until?: Date,
): boolean {
  if (until && date.getTime() > until.getTime()) return false
  if (!cutoff) return true
  const c = cutoff.get(id)
  if (c == null) return true
  return date.getTime() >= c.getTime() + DAY_MS
}

/**
 * Whether a prep log's movement (output produced, or an ingredient drawn down)
 * should be applied on top of the counted baseline for `id`.
 *
 * The generic "count owns its day" rule ({@link inWindow}) is day-granular: it drops
 * anything dated on the count day, because sales/purchases dated that day are assumed
 * already reflected in an end-of-day count. But a count is a point-in-time snapshot and
 * prep production commonly happens *after* it on the same day — that stock is genuinely
 * new and must be added (the reported bug: count 8 at 00:52, make 72 at 15:05, on-hand
 * stayed 8). PrepLog carries a precise `createdAt`, and a count carries a precise
 * `finalizedAt`, so for prep we order by timestamp instead of by calendar day:
 *   - after the count finalized  → genuinely new, count it
 *   - before/at the count moment → already in the counted baseline, skip it
 * When we don't have a finalize timestamp for the item (never counted, or the count
 * predates snapshot bookkeeping), fall back to the day-granular window.
 */
export function prepEventCounts(
  finalizedAt: Map<string, Date> | undefined,
  cutoff: Map<string, Date> | undefined,
  id: string,
  logCreatedAt: Date,
  logDate: Date,
  until?: Date,
): boolean {
  // Checked first: the finalizedAt branch below ignores the window entirely, so a
  // late prep log would otherwise slip past an upper bound.
  if (until && logDate.getTime() > until.getTime()) return false
  const f = finalizedAt?.get(id)
  if (f != null) return logCreatedAt.getTime() > f.getTime()
  return inWindow(cutoff, id, logDate)
}

/**
 * For each item, the `finalizedAt` of the most recent FINALIZED count in which the
 * item was actually counted (non-skipped, `countedQty != null`) — i.e. the count that
 * established the item's current baseline / `lastCountDate`. Used to order same-day prep
 * against the count moment (see {@link prepEventCounts}). Items with no such count are
 * absent from the map and fall back to the day-granular window.
 */
export async function buildCountFinalizedMap(ids: string[]): Promise<Map<string, Date>> {
  const map = new Map<string, Date>()
  if (ids.length === 0) return map
  const lines = await prisma.countLine.findMany({
    where: {
      inventoryItemId: { in: ids },
      skipped: false,
      countedQty: { not: null },
      session: { status: 'FINALIZED', finalizedAt: { not: null } },
    },
    select: { inventoryItemId: true, session: { select: { finalizedAt: true } } },
  })
  for (const l of lines) {
    const f = l.session.finalizedAt
    if (!f) continue
    const cur = map.get(l.inventoryItemId)
    if (!cur || f.getTime() > cur.getTime()) map.set(l.inventoryItemId, f)
  }
  return map
}

/** What a sale-driven consumption event should call itself in the ledger. */
interface SaleEventMeta {
  sink?:   LedgerSink
  saleId:  string
  label:   string
  rcId:    string | null
}

function expandRecipeIngredients(
  recipe: RecipeForExpansion,
  batches: number,
  map: Map<string, number>,
  visitedRecipes: Set<string>,
  eventDate?: Date,
  cutoff?: Map<string, Date>,
  until?: Date,
  meta?: SaleEventMeta,
): void {
  if (visitedRecipes.has(recipe.id)) return
  visitedRecipes.add(recipe.id)

  for (const ing of recipe.ingredients) {
    if (ing.inventoryItemId && ing.inventoryItem && (!eventDate || inWindow(cutoff, ing.inventoryItemId, eventDate, until))) {
      const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem.baseUnit)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
      if (meta?.sink && eventDate) meta.sink.push({
        id: `sale-${meta.saleId}-${recipe.id}-${ing.inventoryItemId}`,
        date: eventDate, type: 'SALE', itemId: ing.inventoryItemId,
        qtyBase: -consumed, description: meta.label, revenueCenterId: meta.rcId,
      })
    }

    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem && (!eventDate || inWindow(cutoff, prep.inventoryItemId, eventDate, until))) {
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem.baseUnit)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
        if (meta?.sink && eventDate) meta.sink.push({
          id: `sale-${meta.saleId}-${recipe.id}-prep-${prep.inventoryItemId}`,
          date: eventDate, type: 'SALE', itemId: prep.inventoryItemId,
          qtyBase: -consumed, description: meta.label, revenueCenterId: meta.rcId,
        })
      }
    }
  }
}

export async function buildConsumptionMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
  until?: Date,
  sink?: LedgerSink,
): Promise<Map<string, number>> {
  const lineItems = await prisma.saleLineItem.findMany({
    where: {
      sale: {
        // A period sale (date..endDate) is relevant if ANY part of its range falls
        // in the window — match on either bound, then gate per-item by its end below.
        OR: [{ date: { gte: since } }, { endDate: { gte: since } }],
        ...(rcId ? { revenueCenterId: rcId } : {}),
      },
    },
    include: {
      sale: { select: { id: true, date: true, endDate: true, revenueCenterId: true } },
      recipe: {
        include: {
          ingredients: {
            include: {
              inventoryItem: { select: { id: true, baseUnit: true } },
              linkedRecipe: {
                include: {
                  inventoryItem: { select: { id: true, baseUnit: true } },
                  ingredients: {
                    include: { inventoryItem: { select: { id: true, baseUnit: true } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  const map = new Map<string, number>()
  for (const li of lineItems) {
    const recipe = li.recipe
    const perBatch = portionsPerBatch(
      Number(recipe.baseYieldQty), recipe.yieldUnit,
      recipe.portionSize !== null ? Number(recipe.portionSize) : null, recipe.portionUnit,
    ) ?? 1
    const batches = li.qtySold / perBatch
    // Gate a period sale by where its range ENDS, not where it starts. A sale spanning
    // (date..endDate) represents consumption across the whole period, so it should apply
    // to any item counted on/before the period end — gating on the start date would drop
    // the entire period whenever the start predates a count. (Caveat: an item recounted
    // mid-period gets the full period's consumption, not just the post-count portion —
    // acceptable until per-day sales granularity exists.)
    const effectiveDate = li.sale.endDate ?? li.sale.date
    expandRecipeIngredients(recipe, batches, map, new Set<string>(), effectiveDate, cutoff, until, sink && {
      sink, saleId: li.sale.id, label: `${recipe.name} × ${li.qtySold}`, rcId: li.sale.revenueCenterId ?? null,
    })
  }
  return map
}

export async function buildPurchaseMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
  until?: Date,
  sink?: LedgerSink,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      session: {
        status: 'APPROVED',
        // Window on the RECEIVED date, the same date the loop below applies the
        // stock on — with `createdAt` kept as an OR so the filter stays a superset
        // and `inWindow` remains the only real gate. Filtering on `createdAt` alone
        // silently dropped a receipt dated AFTER the session was keyed in (goods
        // still to arrive, or a corrected forward date): the row never reached
        // inWindow to be judged. `purchaseDate` is null only on sessions that
        // predate the column, which the createdAt leg still catches.
        OR: [
          { purchaseDate: { gte: since } },
          { createdAt:    { gte: since } },
        ],
        ...(rcId ? { revenueCenterId: rcId } : {}),   // null = all RCs (matches sibling maps)
      },
      approved: true,
      splitToSessionId: null,                          // count each line in exactly ONE RC (bug #1)
      // CREATE_NEW is a real purchase too — the line that CREATED the item also
      // received its first stock. Excluding it dropped every invoice-created item's
      // opening receipt (showed 0 on-hand despite being bought).
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      matchedItemId: { not: null },
      // NOT filtered on rawQty: a per-weight line can carry the billed weight in
      // totalQty with no container count at all. Excluding those credited zero
      // stock for goods that were bought and paid for.
    },
    select: {
      id: true,
      matchedItemId: true,
      rawQty: true,
      rawUnit: true,
      totalQty: true,
      totalQtyUOM: true,
      rateUOM: true,
      invoicePackQty: true,
      invoicePackSize: true,
      invoicePackUOM: true,
      session: { select: { createdAt: true, purchaseDate: true, invoiceDate: true, supplierName: true, invoiceNumber: true, revenueCenterId: true } },
      matchedItem: {
        select: {
          id: true,
          ...PRICING_SELECT,
        },
      },
    },
  })

  for (const si of scanItems) {
    if (!si.matchedItemId || !si.matchedItem) continue
    // A purchase enters theoretical stock on the day the goods were RECEIVED,
    // not the day the invoice was keyed in. Gating on entry time double-counts an
    // invoice for pre-count goods that is entered AFTER the count — the goods were
    // already on the shelf when it was counted.
    //
    // `purchaseDate` is THE resolved received date (src/lib/purchase-date.ts): it is
    // written at approval, re-resolved whenever the invoice date is corrected, and
    // is what every spend, COGS and supplier report already windows on. This engine
    // used to re-derive its own date from the raw `invoiceDate` string instead, so a
    // purchase could land in one period for money and another for stock — and any
    // correction to the resolved date never reached theoretical stock at all.
    // The fallbacks cover only sessions written before the column existed.
    const receivedDate = si.session.purchaseDate
      ?? parseInvoiceDate(si.session.invoiceDate)
      ?? si.session.createdAt
    // `until` gate arrives from upstream (#81 count-reopen window).
    if (!inWindow(cutoff, si.matchedItemId, receivedDate, until)) continue
    // ONE receiving rule, shared with the RC split editor and the approved-invoice
    // report. This used to be a hand-copied duplicate of lineReceivedBaseUnits and
    // the two had already drifted (this copy grew a pack-dimension guard the other
    // never got), so the same line credited different stock depending on who asked.
    // Decimal columns are stringified here rather than widening LineQtyInput —
    // line-qty.ts is client-safe and must not learn about Prisma types.
    const baseUnits = lineReceivedBaseUnits({
      rawQty:         si.rawQty?.toString() ?? null,
      rawUnit:        si.rawUnit,
      totalQty:       si.totalQty?.toString() ?? null,
      totalQtyUOM:    si.totalQtyUOM,
      rateUOM:        si.rateUOM,
      invoicePackQty:  si.invoicePackQty?.toString() ?? null,
      invoicePackSize: si.invoicePackSize?.toString() ?? null,
      invoicePackUOM:  si.invoicePackUOM,
    }, asChainItem(si.matchedItem))
    if (baseUnits <= 0) continue

    map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
    sink?.push({
      id: si.id, date: receivedDate, type: 'PURCHASE', itemId: si.matchedItemId,
      qtyBase: baseUnits,
      description: `${si.session.supplierName ?? 'Purchase'}${si.session.invoiceNumber ? ` · #${si.session.invoiceNumber}` : ''}`,
      revenueCenterId: si.session.revenueCenterId ?? null,
    })
  }

  return map
}

export async function buildWastageMap(
  since: Date,
  itemIds: string[],
  rcId?: string | null,
  cutoff?: Map<string, Date>,
  until?: Date,
  sink?: LedgerSink,
): Promise<Map<string, number>> {
  const wastageRows = await prisma.wastageLog.findMany({
    where: {
      date:            { gte: since },
      inventoryItemId: { in: itemIds },
      ...(rcId ? { revenueCenterId: rcId } : {}),
    },
    select: {
      id:              true,
      inventoryItemId: true,
      qtyWasted:       true,
      unit:            true,
      date:            true,
      reason:          true,
      revenueCenterId: true,
      inventoryItem:   { select: { baseUnit: true } },
    },
  })

  const map = new Map<string, number>()
  for (const w of wastageRows) {
    if (!inWindow(cutoff, w.inventoryItemId, w.date, until)) continue
    const converted = convertQty(Number(w.qtyWasted), w.unit, w.inventoryItem.baseUnit)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
    sink?.push({
      id: w.id, date: w.date, type: 'WASTAGE', itemId: w.inventoryItemId,
      qtyBase: -converted,
      description: w.reason && w.reason !== 'UNKNOWN' ? w.reason : 'Wastage',
      revenueCenterId: w.revenueCenterId,
    })
  }
  return map
}

/**
 * Net RC-to-RC stock transfers since `since`, scoped to one revenue center.
 *
 * A transfer (StockTransfer row) is a purely THEORETICAL movement — it never
 * writes real stock (only a count does). It contributes `+quantity` to the
 * destination RC and `-quantity` to the source RC, so summed across every RC a
 * transfer nets to zero (total on-hand is unchanged; it just moved between RCs).
 *
 * `quantity` is stored in baseUnit (like `stockOnHand`/`StockAllocation.quantity`),
 * so no unit conversion is needed.
 *
 * Chronology: a transfer carries a precise `createdAt`, and a count a precise
 * `finalizedAt`, so — exactly like prep ({@link prepEventCounts}) — a transfer is
 * ordered against the count MOMENT, not the calendar day:
 *   - createdAt AFTER the count finalized  → genuinely new, apply it
 *   - createdAt before/at the count moment → already in the counted baseline, skip
 * Without a finalize timestamp (never counted, or a pre-snapshot count) it falls back
 * to the day-granular "count owns its day" window. This is what lets a pull done in
 * the afternoon still register against a count taken that morning.
 *
 * Called only with a concrete `rcId` (the per-RC computation path). With no rcId
 * the map is empty — the "All RCs" aggregate sums the per-RC maps, where transfers
 * already cancel out.
 */
export async function buildTransferMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
  finalizedAt?: Map<string, Date>,
  until?: Date,
  sink?: LedgerSink,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (!rcId) return map

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      createdAt: { gte: since },
      OR: [{ fromRcId: rcId }, { toRcId: rcId }],
    },
    select: {
      id: true, inventoryItemId: true, fromRcId: true, toRcId: true, quantity: true, createdAt: true,
      fromRc: { select: { name: true } }, toRc: { select: { name: true } },
    },
  })

  for (const t of transfers) {
    // Timestamp-precise vs the count moment, with a day-granular fallback — the same
    // rule prep uses (see prepEventCounts). logCreatedAt and logDate are both createdAt.
    if (!prepEventCounts(finalizedAt, cutoff, t.inventoryItemId, t.createdAt, t.createdAt, until)) continue
    // A transfer can't have fromRcId === toRcId (validated on write), so at most
    // one branch applies per row.
    const signed = t.toRcId === rcId ? Number(t.quantity) : -Number(t.quantity)
    map.set(t.inventoryItemId, (map.get(t.inventoryItemId) ?? 0) + signed)
    sink?.push({
      id: `${t.id}-${rcId}`, date: t.createdAt, type: 'TRANSFER', itemId: t.inventoryItemId,
      qtyBase: signed, description: `${t.fromRc.name} → ${t.toRc.name}`, revenueCenterId: rcId,
    })
  }
  return map
}

/**
 * Compute theoretical expected qty for an inventory item given its base stock
 * and the consumption/purchase/wastage maps for a period.
 * prepConsumptionMap and prepOutputMap are optional for backward compatibility.
 * `prepConsumptionMap`/`prepOutputMap` (optional): ingredients drawn down by prep
 * production (subtracted) and prep yield produced (added).
 */
export function computeExpected(
  itemId: string,
  baseStock: number,
  consumptionMap: Map<string, number>,
  purchaseMap: Map<string, number>,
  wastageMap: Map<string, number>,
  prepConsumptionMap?: Map<string, number>,
  prepOutputMap?: Map<string, number>,
  // Net RC-to-RC transfers (signed: +into this RC, -out of it). Optional so pre-existing
  // callers keep compiling; every theoretical call site passes it (see buildTransferMap).
  transferMap?: Map<string, number>,
): number {
  const consumption = consumptionMap.get(itemId) ?? 0
  const purchases   = purchaseMap.get(itemId)    ?? 0
  const wastage     = wastageMap.get(itemId)     ?? 0
  const prepCons    = prepConsumptionMap?.get(itemId) ?? 0
  const prepOut     = prepOutputMap?.get(itemId)      ?? 0
  const transfers   = transferMap?.get(itemId)        ?? 0
  return Math.max(0, baseStock + purchases + prepOut + transfers - consumption - wastage - prepCons)
}

/**
 * Theoretical on-hand (in baseUnit) for a single inventory item, scoped to a
 * revenue centre — the single-item analogue of what the full-session create
 * route computes per line. Used by the quick-count endpoint (GET preview +
 * POST finalize) so both read the same baseline.
 *
 * Baseline rules mirror the session create route:
 *   - default RC  → global `stockOnHand`
 *   - non-default → this RC's `StockAllocation.quantity`, falling back to 0
 *     (NOT global stock) when the RC has never been counted.
 *   - no RC       → global `stockOnHand`.
 * The lookback window is the item's own `lastCountDate`, or epoch when the item
 * has never been counted (baseline = current `stockOnHand`, so its whole movement
 * history is applied rather than ignored — mirrors getTheoreticalStockMap).
 */
export async function computeExpectedForItem(
  itemId: string,
  rcId?: string | null,
  sink?: LedgerSink,
): Promise<{ expectedBase: number; baseStock: number } | null> {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    select: { id: true, stockOnHand: true, lastCountDate: true },
  })
  if (!item) return null

  // No RC selected → mirror getTheoreticalStockMap(null): sum across RCs.
  if (!rcId) {
    const m = await getTheoreticalStockMap(null, [itemId])
    const q = m.get(itemId) ?? 0
    return { expectedBase: q, baseStock: q }
  }

  let isDefaultRc = false
  let baseStock = Number(item.stockOnHand)
  if (rcId) {
    const rc = await prisma.revenueCenter.findUnique({
      where: { id: rcId },
      select: { isDefault: true },
    })
    isDefaultRc = !!rc?.isDefault
    if (!isDefaultRc) {
      const alloc = await prisma.stockAllocation.findUnique({
        where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: itemId } },
        select: { quantity: true },
      })
      // Never-counted RC falls back to 0, not the warehouse total.
      baseStock = alloc ? Number(alloc.quantity) : 0
    }
  }

  // Never-counted item → epoch window so its full purchase/prep history is applied
  // (these buildXMap calls pass no cutoff, so inWindow includes every event within
  // the window). For a counted item the window is its own lastCountDate.
  const since = item.lastCountDate ?? new Date(0)
  // Pass a per-item cutoff so this single-item path gets the same gating as the
  // batched getTheoreticalStockMap: "count owns its day" (movements on the count
  // day are already in the baseline) and invoiceDate-based purchase timing. A
  // never-counted item has no cutoff entry → its full history applies (since=epoch).
  const cutoff = new Map<string, Date>()
  if (item.lastCountDate) cutoff.set(itemId, item.lastCountDate)

  // finalizedAt orders same-day prep AND transfers against the count moment.
  const finalizedAt = await buildCountFinalizedMap([itemId])
  // A sink only wants THIS item's events; the maps are per-item-keyed anyway, so
  // filter at the sink rather than narrowing every query.
  const itemSink: LedgerSink | undefined = sink && {
    push: (e: LedgerEvent) => { if (e.itemId === itemId) sink.push(e) },
  }
  const [consumptionMap, purchaseMap, wastageMap, prepMap, transferMap] = await Promise.all([
    buildConsumptionMap(since, rcId, cutoff, undefined, itemSink),
    buildPurchaseMap(since, rcId, cutoff, undefined, itemSink),
    buildWastageMap(since, [itemId], rcId, cutoff, undefined, itemSink),
    buildPrepMap(since, rcId, cutoff, finalizedAt, undefined, itemSink),
    buildTransferMap(since, rcId, cutoff, finalizedAt, undefined, itemSink),
  ])

  return {
    expectedBase: computeExpected(itemId, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output, transferMap),
    baseStock,
  }
}

/** Theoretical on-hand quantity (baseUnit) for one item, scoped to an RC. null if the item doesn't exist. */
export async function getTheoreticalStock(itemId: string, rcId?: string | null): Promise<number | null> {
  const r = await computeExpectedForItem(itemId, rcId)
  return r ? r.expectedBase : null
}

/**
 * Net prep movement since `since`, scoped via the **log's `revenueCenterId`**
 * (inherited from the prep item when the log was created). When `rcId` is
 * provided, logs whose `revenueCenterId` doesn't match — including null-RC logs
 * — are excluded, consistent with `buildConsumptionMap` / `buildWastageMap`.
 * Mirrors the old prep-apply write but accumulates into maps instead of writing
 * stockOnHand: raws drawn down (consumption) and the prep item produced (output).
 * Stops at sub-prep items (charges the sub-prep's own inventory item), exactly like
 * the theoretical-usage report, so prep-in-prep never double-counts.
 */
export async function buildPrepMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
  finalizedAt?: Map<string, Date>,
  until?: Date,
  sink?: LedgerSink,
): Promise<{ consumption: Map<string, number>; output: Map<string, number> }> {
  const logs = await prisma.prepLog.findMany({
    where: {
      status: { in: ['DONE', 'PARTIAL'] },
      actualPrepQty: { not: null },
      logDate: { gte: since },
      ...(rcId ? { revenueCenterId: rcId } : {}),
    },
    include: {
      prepItem: {
        include: {
          linkedRecipe: {
            include: {
              inventoryItem: { select: { id: true, baseUnit: true } },
              ingredients: {
                include: {
                  inventoryItem: { select: { id: true, baseUnit: true } },
                  linkedRecipe: { select: { inventoryItem: { select: { id: true, baseUnit: true } } } },
                },
              },
            },
          },
        },
      },
    },
  })

  const consumption = new Map<string, number>()
  const output = new Map<string, number>()
  const add = (m: Map<string, number>, id: string, q: number) => m.set(id, (m.get(id) ?? 0) + q)

  for (const log of logs) {
    const recipe = log.prepItem.linkedRecipe
    if (!recipe) continue
    // Skip logs with no positive qty — a PARTIAL with 0 entered contributes nothing.
    if (Number(log.actualPrepQty) <= 0) continue

    // When prepItem.unit doesn't match recipe yieldUnit, computeScale returns
    // scale: 1 (one full batch regardless of actualPrepQty) with unitMismatch: true.
    // We ignore unitMismatch here — same fallback the old applyInventoryTransaction
    // used; a future enhancement could surface these as warnings.
    const { scale } = computeScale(
      Number(log.actualPrepQty),
      log.prepItem.unit,
      recipe.yieldUnit,
      Number(recipe.baseYieldQty),
    )

    for (const ing of recipe.ingredients) {
      // qtyBase is in ing.unit (not yet base units); convertQty handles the
      // conversion afterward — same pattern as recipeCosts.ts.
      const qty = Number(ing.qtyBase) * scale
      if (ing.inventoryItemId && ing.inventoryItem) {
        if (prepEventCounts(finalizedAt, cutoff, ing.inventoryItem.id, log.createdAt, log.logDate, until)) {
          const drawn = convertQty(qty, ing.unit, ing.inventoryItem.baseUnit)
          add(consumption, ing.inventoryItem.id, drawn)
          sink?.push({
            id: `prep-in-${log.id}-${ing.inventoryItem.id}`, date: log.logDate, type: 'PREP_IN',
            itemId: ing.inventoryItem.id, qtyBase: -drawn,
            description: `Prep: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
          })
        }
      } else if (ing.linkedRecipeId && ing.linkedRecipe?.inventoryItem) {
        const prep = ing.linkedRecipe.inventoryItem
        if (prepEventCounts(finalizedAt, cutoff, prep.id, log.createdAt, log.logDate, until)) {
          const drawn = convertQty(qty, ing.unit, prep.baseUnit)
          add(consumption, prep.id, drawn)
          sink?.push({
            id: `prep-in-${log.id}-${prep.id}`, date: log.logDate, type: 'PREP_IN',
            itemId: prep.id, qtyBase: -drawn,
            description: `Prep: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
          })
        }
      }
    }

    if (recipe.inventoryItemId && recipe.inventoryItem && prepEventCounts(finalizedAt, cutoff, recipe.inventoryItem.id, log.createdAt, log.logDate, until)) {
      const yieldInBase = convertQty(Number(recipe.baseYieldQty), recipe.yieldUnit, recipe.inventoryItem.baseUnit) * scale
      add(output, recipe.inventoryItem.id, yieldInBase)
      sink?.push({
        id: `prep-out-${log.id}`, date: log.logDate, type: 'PREP_OUT',
        itemId: recipe.inventoryItem.id, qtyBase: yieldInBase,
        description: `Prep output: ${recipe.name}`, revenueCenterId: log.revenueCenterId ?? null,
      })
    }
  }

  return { consumption, output }
}

/**
 * Theoretical on-hand (baseUnit) for many items at once, scoped to an RC.
 * Mirrors the count-session route: one lookback window (earliest lastCountDate),
 * RC baseline rule (global stock for default/no RC; StockAllocation else, 0 if
 * the RC never counted the item). Returns a Map itemId -> theoretical qty.
 */
export async function getTheoreticalStockMap(
  rcId: string | null | undefined,
  itemIds?: string[],
  // When provided (a scoped user's allowed RC set), the "All RCs" aggregate is
  // limited to these revenue centers instead of every RC. Ignored when an
  // explicit rcId is given. `null`/undefined = no restriction (all RCs).
  allowedRcIds?: Set<string> | null,
  // Optional working-out recorder — see TheoreticalTrace. Costs nothing when absent.
  trace?: TheoreticalTrace,
): Promise<Map<string, number>> {
  // "All RCs" = the SUM of every revenue center's theoretical map. This makes
  // ALL = ΣRC true by construction (each RC floored at 0 independently).
  // For a scoped user, "All" is the sum of only their allowed RCs.
  if (!rcId) {
    const rcs = await prisma.revenueCenter.findMany({
      where: allowedRcIds ? { id: { in: [...allowedRcIds] } } : undefined,
      select: { id: true },
    })
    const perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, itemIds, null, trace)))
    const sum = new Map<string, number>()
    for (const m of perRc) for (const [id, q] of m) sum.set(id, (sum.get(id) ?? 0) + q)
    return sum
  }

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true, isStocked: true, ...(itemIds ? { id: { in: itemIds } } : {}) },
    select: { id: true, stockOnHand: true, lastCountDate: true },
  })

  const ids = items.map(i => i.id)
  const earliest = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  // Per-item cutoff: each item's movements are only those since its OWN count,
  // even though we query the maps over one wide window. Without this, an item
  // counted more recently than `earliest` double-counts movements that predate
  // its count but are already in its baseline (so the batched map disagreed with
  // the single-item computeExpectedForItem — e.g. a just-counted prep item
  // reading par+yield instead of the counted qty).
  const cutoff = new Map<string, Date>()
  for (const i of items) if (i.lastCountDate) cutoff.set(i.id, i.lastCountDate)

  // Window start. Counted items are gated per-item by `cutoff`; a never-counted item
  // (baseline = its current stockOnHand) must have its FULL history applied, so when
  // any uncounted item is present we widen the query window to epoch. The per-item
  // cutoff still scopes counted items correctly within that wider window. Without this,
  // an uncounted item's purchases that predate `earliest` are filtered out by the
  // `createdAt >= since` DB query before `inWindow` ever sees them.
  const hasUncounted = items.some(i => !i.lastCountDate)
  const since = hasUncounted ? new Date(0) : earliest

  const empty = new Map<string, number>()
  // finalizedAt orders same-day prep AND transfers against the count moment.
  const finalizedAt = since ? await buildCountFinalizedMap(ids) : new Map<string, Date>()
  const [consumptionMap, purchaseMap, wastageMap, prepMap, transferMap] = since
    ? await Promise.all([
        buildConsumptionMap(since, rcId, cutoff, undefined, trace?.sink),
        buildPurchaseMap(since, rcId, cutoff, undefined, trace?.sink),
        buildWastageMap(since, ids, rcId, cutoff, undefined, trace?.sink),
        buildPrepMap(since, rcId, cutoff, finalizedAt, undefined, trace?.sink),
        buildTransferMap(since, rcId, cutoff, finalizedAt, undefined, trace?.sink),
      ])
    : [empty, empty, empty, { consumption: empty, output: empty }, empty]

  const stockAllocationMap = new Map<string, number>()
  let isDefaultRc = false
  if (rcId && ids.length > 0) {
    const rc = await prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { isDefault: true } })
    isDefaultRc = !!rc?.isDefault
    const allocs = await prisma.stockAllocation.findMany({
      where: { revenueCenterId: rcId, inventoryItemId: { in: ids } },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocs) stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
  }

  const result = new Map<string, number>()
  for (const item of items) {
    const baseStock = rcId
      ? (stockAllocationMap.has(item.id) ? stockAllocationMap.get(item.id)! : (isDefaultRc ? Number(item.stockOnHand) : 0))
      : Number(item.stockOnHand)
    const expected = computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output, transferMap)
    result.set(item.id, expected)
    trace?.onRcResult?.(rcId, item.id, baseStock, expected)
  }
  return result
}
