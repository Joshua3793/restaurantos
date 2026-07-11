import { prisma } from '@/lib/prisma'
import { convertQty, UNIT_FACTORS, canonicalUom } from '@/lib/uom'
import { computeScale } from '@/lib/prep-utils'
import { asChainItem, basePerUnit, dimensionOf, PRICING_SELECT } from '@/lib/item-model'
import { parseInvoiceDate } from '@/lib/purchase-date'

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
function inWindow(cutoff: Map<string, Date> | undefined, id: string, date: Date): boolean {
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
): boolean {
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

function expandRecipeIngredients(
  recipe: RecipeForExpansion,
  batches: number,
  map: Map<string, number>,
  visitedRecipes: Set<string>,
  eventDate?: Date,
  cutoff?: Map<string, Date>,
): void {
  if (visitedRecipes.has(recipe.id)) return
  visitedRecipes.add(recipe.id)

  for (const ing of recipe.ingredients) {
    if (ing.inventoryItemId && ing.inventoryItem && (!eventDate || inWindow(cutoff, ing.inventoryItemId, eventDate))) {
      const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem.baseUnit)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
    }

    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem && (!eventDate || inWindow(cutoff, prep.inventoryItemId, eventDate))) {
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem.baseUnit)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
      }
    }
  }
}

export async function buildConsumptionMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
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
      sale: { select: { date: true, endDate: true } },
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
    const portionsPerBatch =
      recipe.portionSize && Number(recipe.portionSize) > 0
        ? Number(recipe.baseYieldQty) / Number(recipe.portionSize)
        : 1
    const batches = li.qtySold / portionsPerBatch
    // Gate a period sale by where its range ENDS, not where it starts. A sale spanning
    // (date..endDate) represents consumption across the whole period, so it should apply
    // to any item counted on/before the period end — gating on the start date would drop
    // the entire period whenever the start predates a count. (Caveat: an item recounted
    // mid-period gets the full period's consumption, not just the post-count portion —
    // acceptable until per-day sales granularity exists.)
    const effectiveDate = li.sale.endDate ?? li.sale.date
    expandRecipeIngredients(recipe, batches, map, new Set<string>(), effectiveDate, cutoff)
  }
  return map
}

export async function buildPurchaseMap(
  since: Date,
  rcId?: string | null,
  cutoff?: Map<string, Date>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  const scanItems = await prisma.invoiceScanItem.findMany({
    where: {
      session: {
        status: 'APPROVED',
        createdAt: { gte: since },
        ...(rcId ? { revenueCenterId: rcId } : {}),   // null = all RCs (matches sibling maps)
      },
      approved: true,
      splitToSessionId: null,                          // count each line in exactly ONE RC (bug #1)
      // CREATE_NEW is a real purchase too — the line that CREATED the item also
      // received its first stock. Excluding it dropped every invoice-created item's
      // opening receipt (showed 0 on-hand despite being bought).
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      matchedItemId: { not: null },
      rawQty: { not: null },
    },
    select: {
      matchedItemId: true,
      rawQty: true,
      rawUnit: true,
      totalQty: true,
      totalQtyUOM: true,
      invoicePackQty: true,
      invoicePackSize: true,
      invoicePackUOM: true,
      session: { select: { createdAt: true, invoiceDate: true } },
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
    // A purchase enters theoretical stock on the day the goods were RECEIVED
    // (invoiceDate), not the day the invoice was keyed in (createdAt). Gating on
    // entry time double-counts an invoice for pre-count goods that is entered
    // AFTER the count — the goods were already on the shelf when it was counted.
    // invoiceDate is a nullable "YYYY-MM-DD" OCR string; fall back to createdAt.
    const receivedDate = parseInvoiceDate(si.session.invoiceDate) ?? si.session.createdAt
    if (!inWindow(cutoff, si.matchedItemId, receivedDate)) continue
    const qty = Number(si.rawQty ?? 0)
    if (qty <= 0) continue

    const chainItem = asChainItem(si.matchedItem)
    const baseUnit = chainItem.baseUnit
    let baseUnits: number

    // For RATE (per-weight / catch-weight) pricing, the invoice bills a weight/volume
    // directly. Use the invoice's stated total when present, else rawQty — each paired
    // with ITS OWN unit (never cross totalQty with rawUnit). Multiplying a per-weight
    // qty by case size was a 10× inflation (bug #4).
    const isRate = chainItem.pricing.mode === 'RATE'
    let billedQty = qty
    let billedUOM: string | null = null
    if (isRate) {
      if (si.totalQty != null && Number(si.totalQty) > 0) {
        billedQty = Number(si.totalQty); billedUOM = si.totalQtyUOM ?? baseUnit
      } else {
        billedQty = qty; billedUOM = si.rawUnit ?? baseUnit
      }
    }

    if (isRate && billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) {
      // Billed unit is a real measurement unit → convert the weight/volume directly.
      baseUnits = convertQty(billedQty, billedUOM, baseUnit)
    } else {
      // CASE pricing, OR a RATE line billed in a CONTAINER unit the backbone can't
      // convert (CS, PK, case, tray…): expand the raw line qty (purchase units) via the
      // pack structure. Without this, a RATE line billed in cases passed straight through
      // convertQty unscaled, under-counting purchases (e.g. "Beef Digital" billed in CS).
      const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
      const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
      const packUOM  = si.invoicePackUOM ?? null
      // Only trust the invoice's pack format when its UOM is the SAME dimension as the
      // item's base unit. Otherwise convertQty does a cross-dimension passthrough that
      // silently inflates/zeros (e.g. a COUNT item whose case is described by weight:
      // "6 × 240 G" → convertQty(1440 g → each) returned 1440 muffins instead of 24 →
      // 60× inflation). On a dimension mismatch, derive from the item's OWN chain.
      if (packQty > 0 && packSize > 0 && packUOM && dimensionOf(packUOM) === chainItem.dimension) {
        // Invoice supplied its own pack format (one-off) → compute base from it.
        baseUnits = convertQty(qty * packQty * packSize, packUOM, baseUnit)
      } else {
        // DEFAULT case path: base units received = qtyShipped × the chain's
        // top-level base content (levelBaseUnits[top]). No legacy pack fields.
        const top = chainItem.packChain[0]?.unit
        const perCase = top ? basePerUnit(chainItem, top) : 1
        baseUnits = qty * perCase
      }
    }

    map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
  }

  return map
}

export async function buildWastageMap(
  since: Date,
  itemIds: string[],
  rcId?: string | null,
  cutoff?: Map<string, Date>,
): Promise<Map<string, number>> {
  const wastageRows = await prisma.wastageLog.findMany({
    where: {
      date:            { gte: since },
      inventoryItemId: { in: itemIds },
      ...(rcId ? { revenueCenterId: rcId } : {}),
    },
    select: {
      inventoryItemId: true,
      qtyWasted:       true,
      unit:            true,
      date:            true,
      inventoryItem:   { select: { baseUnit: true } },
    },
  })

  const map = new Map<string, number>()
  for (const w of wastageRows) {
    if (!inWindow(cutoff, w.inventoryItemId, w.date)) continue
    const converted = convertQty(Number(w.qtyWasted), w.unit, w.inventoryItem.baseUnit)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
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
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (!rcId) return map

  const transfers = await prisma.stockTransfer.findMany({
    where: {
      createdAt: { gte: since },
      OR: [{ fromRcId: rcId }, { toRcId: rcId }],
    },
    select: { inventoryItemId: true, fromRcId: true, toRcId: true, quantity: true, createdAt: true },
  })

  for (const t of transfers) {
    // Timestamp-precise vs the count moment, with a day-granular fallback — the same
    // rule prep uses (see prepEventCounts). logCreatedAt and logDate are both createdAt.
    if (!prepEventCounts(finalizedAt, cutoff, t.inventoryItemId, t.createdAt, t.createdAt)) continue
    // A transfer can't have fromRcId === toRcId (validated on write), so at most
    // one branch applies per row.
    const signed = t.toRcId === rcId ? Number(t.quantity) : -Number(t.quantity)
    map.set(t.inventoryItemId, (map.get(t.inventoryItemId) ?? 0) + signed)
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
  const [consumptionMap, purchaseMap, wastageMap, prepMap, transferMap] = await Promise.all([
    buildConsumptionMap(since, rcId, cutoff),
    buildPurchaseMap(since, rcId, cutoff),
    buildWastageMap(since, [itemId], rcId, cutoff),
    buildPrepMap(since, rcId, cutoff, finalizedAt),
    buildTransferMap(since, rcId, cutoff, finalizedAt),
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
        if (prepEventCounts(finalizedAt, cutoff, ing.inventoryItem.id, log.createdAt, log.logDate))
          add(consumption, ing.inventoryItem.id, convertQty(qty, ing.unit, ing.inventoryItem.baseUnit))
      } else if (ing.linkedRecipeId && ing.linkedRecipe?.inventoryItem) {
        const prep = ing.linkedRecipe.inventoryItem
        if (prepEventCounts(finalizedAt, cutoff, prep.id, log.createdAt, log.logDate))
          add(consumption, prep.id, convertQty(qty, ing.unit, prep.baseUnit))
      }
    }

    if (recipe.inventoryItemId && recipe.inventoryItem && prepEventCounts(finalizedAt, cutoff, recipe.inventoryItem.id, log.createdAt, log.logDate)) {
      const yieldInBase = convertQty(Number(recipe.baseYieldQty), recipe.yieldUnit, recipe.inventoryItem.baseUnit) * scale
      add(output, recipe.inventoryItem.id, yieldInBase)
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
): Promise<Map<string, number>> {
  // "All RCs" = the SUM of every revenue center's theoretical map. This makes
  // ALL = ΣRC true by construction (each RC floored at 0 independently).
  // For a scoped user, "All" is the sum of only their allowed RCs.
  if (!rcId) {
    const rcs = await prisma.revenueCenter.findMany({
      where: allowedRcIds ? { id: { in: [...allowedRcIds] } } : undefined,
      select: { id: true },
    })
    const perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, itemIds)))
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
        buildConsumptionMap(since, rcId, cutoff),
        buildPurchaseMap(since, rcId, cutoff),
        buildWastageMap(since, ids, rcId, cutoff),
        buildPrepMap(since, rcId, cutoff, finalizedAt),
        buildTransferMap(since, rcId, cutoff, finalizedAt),
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
    result.set(item.id, computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output, transferMap))
  }
  return result
}
