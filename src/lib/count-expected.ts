import { prisma } from '@/lib/prisma'
import { convertQty, UNIT_FACTORS, canonicalUom } from '@/lib/uom'
import { computeScale } from '@/lib/prep-utils'
import { asChainItem, basePerUnit, PRICING_SELECT } from '@/lib/item-model'

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
 * item's baseline is its OWN count. An event may only be applied to item X if
 * it occurred on/after X's own `lastCountDate` — otherwise it is already baked
 * into X's baseline and would be double-counted.
 *
 * When `cutoff` is omitted, every event passes (legacy single-window behaviour).
 * When provided, items absent from the map (no count date) receive nothing —
 * matching `computeExpectedForItem`, which collapses to the baseline with no
 * lookback window.
 */
function inWindow(cutoff: Map<string, Date> | undefined, id: string, date: Date): boolean {
  if (!cutoff) return true
  const c = cutoff.get(id)
  return c != null && date >= c
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
        date: { gte: since },
        ...(rcId ? { revenueCenterId: rcId } : {}),
      },
    },
    include: {
      sale: { select: { date: true } },
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
    expandRecipeIngredients(recipe, batches, map, new Set<string>(), li.sale.date, cutoff)
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
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
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
      session: { select: { createdAt: true } },
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
    if (!inWindow(cutoff, si.matchedItemId, si.session.createdAt)) continue
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
      if (packQty > 0 && packSize > 0 && packUOM) {
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
): number {
  const consumption = consumptionMap.get(itemId) ?? 0
  const purchases   = purchaseMap.get(itemId)    ?? 0
  const wastage     = wastageMap.get(itemId)     ?? 0
  const prepCons    = prepConsumptionMap?.get(itemId) ?? 0
  const prepOut     = prepOutputMap?.get(itemId)      ?? 0
  return Math.max(0, baseStock + purchases + prepOut - consumption - wastage - prepCons)
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
 * The lookback window is the item's own `lastCountDate`; with no prior count
 * the maps are empty and expected collapses to the baseline.
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

  const since = item.lastCountDate
  if (!since) return { expectedBase: Math.max(0, baseStock), baseStock }

  const [consumptionMap, purchaseMap, wastageMap, prepMap] = await Promise.all([
    buildConsumptionMap(since, rcId),
    buildPurchaseMap(since, rcId),
    buildWastageMap(since, [itemId], rcId),
    buildPrepMap(since, rcId),
  ])

  return {
    expectedBase: computeExpected(itemId, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output),
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
        if (inWindow(cutoff, ing.inventoryItem.id, log.logDate))
          add(consumption, ing.inventoryItem.id, convertQty(qty, ing.unit, ing.inventoryItem.baseUnit))
      } else if (ing.linkedRecipeId && ing.linkedRecipe?.inventoryItem) {
        const prep = ing.linkedRecipe.inventoryItem
        if (inWindow(cutoff, prep.id, log.logDate))
          add(consumption, prep.id, convertQty(qty, ing.unit, prep.baseUnit))
      }
    }

    if (recipe.inventoryItemId && recipe.inventoryItem && inWindow(cutoff, recipe.inventoryItem.id, log.logDate)) {
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
): Promise<Map<string, number>> {
  // "All RCs" = the SUM of every revenue center's theoretical map. This makes
  // ALL = ΣRC true by construction (each RC floored at 0 independently).
  if (!rcId) {
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })
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

  const empty = new Map<string, number>()
  const [consumptionMap, purchaseMap, wastageMap, prepMap] = earliest
    ? await Promise.all([
        buildConsumptionMap(earliest, rcId, cutoff),
        buildPurchaseMap(earliest, rcId, cutoff),
        buildWastageMap(earliest, ids, rcId, cutoff),
        buildPrepMap(earliest, rcId, cutoff),
      ])
    : [empty, empty, empty, { consumption: empty, output: empty }]

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
    result.set(item.id, computeExpected(item.id, baseStock, consumptionMap, purchaseMap, wastageMap, prepMap.consumption, prepMap.output))
  }
  return result
}
