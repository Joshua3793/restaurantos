import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { getUnitConv } from '@/lib/utils'

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

function expandRecipeIngredients(
  recipe: RecipeForExpansion,
  batches: number,
  map: Map<string, number>,
  visitedRecipes: Set<string>,
): void {
  if (visitedRecipes.has(recipe.id)) return
  visitedRecipes.add(recipe.id)

  for (const ing of recipe.ingredients) {
    if (ing.inventoryItemId && ing.inventoryItem) {
      const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem.baseUnit)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
    }

    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem) {
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem.baseUnit)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
      }
    }
  }
}

export async function buildConsumptionMap(
  since: Date,
  rcId?: string | null,
): Promise<Map<string, number>> {
  const lineItems = await prisma.saleLineItem.findMany({
    where: {
      sale: {
        date: { gte: since },
        ...(rcId ? { revenueCenterId: rcId } : {}),
      },
    },
    include: {
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
    expandRecipeIngredients(recipe, batches, map, new Set<string>())
  }
  return map
}

export async function buildPurchaseMap(
  since: Date,
  rcId?: string | null,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  if (rcId) {
    const scanItems = await prisma.invoiceScanItem.findMany({
      where: {
        session: {
          revenueCenterId: rcId,
          status: 'APPROVED',
          createdAt: { gte: since },
        },
        approved: true,
        action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER'] },
        matchedItemId: { not: null },
        rawQty: { not: null },
      },
      select: {
        matchedItemId: true,
        rawQty: true,
        invoicePackQty:  true,
        invoicePackSize: true,
        invoicePackUOM:  true,
        matchedItem: {
          select: {
            id: true, baseUnit: true,
            qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
          },
        },
      },
    })

    for (const si of scanItems) {
      if (!si.matchedItemId || !si.matchedItem) continue
      const qty = Number(si.rawQty ?? 0)
      if (qty <= 0) continue

      let baseUnits: number
      const packQty  = si.invoicePackQty  ? Number(si.invoicePackQty)  : 0
      const packSize = si.invoicePackSize ? Number(si.invoicePackSize) : 0
      const packUOM  = si.invoicePackUOM ?? null

      if (packQty > 0 && packSize > 0 && packUOM) {
        baseUnits = convertQty(qty * packQty * packSize, packUOM, si.matchedItem.baseUnit)
      } else {
        // Convert packUOM → baseUnit, matching the branch above and the legacy
        // InvoiceLineItem path below. Omitting getUnitConv understated weight/
        // volume purchases by the conversion factor (1000× for kg→g).
        const unitsPerCase =
          Number(si.matchedItem.qtyPerPurchaseUnit) *
          Number(si.matchedItem.packSize) *
          getUnitConv(si.matchedItem.packUOM)
        baseUnits = qty * unitsPerCase
      }

      map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
    }
  } else {
    const purchaseRows = await prisma.invoiceLineItem.findMany({
      where: {
        invoice: {
          invoiceDate: { gte: since },
          status: { not: 'CANCELLED' },
        },
      },
      include: {
        inventoryItem: {
          select: {
            id: true, baseUnit: true,
            qtyPerPurchaseUnit: true, packSize: true, packUOM: true,
          },
        },
      },
    })

    for (const p of purchaseRows) {
      if (!p.inventoryItem) continue
      const unitsPerCase =
        Number(p.inventoryItem.qtyPerPurchaseUnit) *
        Number(p.inventoryItem.packSize) *
        getUnitConv(p.inventoryItem.packUOM)
      const baseUnits = Number(p.qtyPurchased) * unitsPerCase
      map.set(p.inventoryItemId!, (map.get(p.inventoryItemId!) ?? 0) + baseUnits)
    }
  }

  return map
}

export async function buildWastageMap(
  since: Date,
  itemIds: string[],
  rcId?: string | null,
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
      inventoryItem:   { select: { baseUnit: true } },
    },
  })

  const map = new Map<string, number>()
  for (const w of wastageRows) {
    const converted = convertQty(Number(w.qtyWasted), w.unit, w.inventoryItem.baseUnit)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
  }
  return map
}

/**
 * Compute theoretical expected qty for an inventory item given its base stock
 * and the consumption/purchase/wastage maps for a period.
 */
export function computeExpected(
  itemId: string,
  baseStock: number,
  consumptionMap: Map<string, number>,
  purchaseMap: Map<string, number>,
  wastageMap: Map<string, number>,
): number {
  const consumption = consumptionMap.get(itemId) ?? 0
  const purchases   = purchaseMap.get(itemId)    ?? 0
  const wastage     = wastageMap.get(itemId)     ?? 0
  return Math.max(0, baseStock + purchases - consumption - wastage)
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

  const [consumptionMap, purchaseMap, wastageMap] = await Promise.all([
    buildConsumptionMap(since, rcId),
    buildPurchaseMap(since, rcId),
    buildWastageMap(since, [itemId], rcId),
  ])

  return {
    expectedBase: computeExpected(itemId, baseStock, consumptionMap, purchaseMap, wastageMap),
    baseStock,
  }
}
