import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'

// ── GET /api/count/sessions ───────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const rcId      = searchParams.get('rcId')
  const isDefault = searchParams.get('isDefault') === 'true'

  const sessions = await prisma.countSession.findMany({
    where: rcId
      ? (isDefault
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : { revenueCenterId: rcId })
      : {},
    orderBy: { startedAt: 'desc' },
    include: { lines: { select: { countedQty: true, skipped: true } } },
  })

  return NextResponse.json(
    sessions.map(s => {
      const total   = s.lines.length
      const counted = s.lines.filter(l => l.countedQty !== null && !l.skipped).length
      const skipped = s.lines.filter(l => l.skipped).length
      const { lines, ...rest } = s
      return { ...rest, counts: { total, counted, skipped } }
    }),
    { headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' } }
  )
}

// ── Recipe expansion with circular-reference guard ────────────────────────────
// visitedRecipes tracks recipe IDs already processed in the current call chain
// to prevent infinite loops if recipes reference each other.
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
  if (visitedRecipes.has(recipe.id)) return // circular guard
  visitedRecipes.add(recipe.id)

  for (const ing of recipe.ingredients) {
    // Direct inventory ingredient
    if (ing.inventoryItemId && ing.inventoryItem) {
      const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, ing.inventoryItem.baseUnit)
      map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
    }

    // PREP recipe ingredient — deduct from the PREP recipe's linked InventoryItem.
    // We do NOT recurse into its sub-ingredients: the PREP item is counted as its
    // own inventory unit; consumption is already tracked at the PREP level.
    if (ing.linkedRecipeId && ing.linkedRecipe && !visitedRecipes.has(ing.linkedRecipeId)) {
      const prep = ing.linkedRecipe
      if (prep.inventoryItemId && prep.inventoryItem) {
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, prep.inventoryItem.baseUnit)
        map.set(prep.inventoryItemId, (map.get(prep.inventoryItemId) ?? 0) + consumed)
      }
    }
  }
}

// ── Build consumption map from sales since a given date ───────────────────────
// rcId: when set, only counts sales attributed to that revenue center.
async function buildConsumptionMap(
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

    // Fresh visited set per sale line — each sale is independent
    const visitedRecipes = new Set<string>()
    expandRecipeIngredients(recipe, batches, map, visitedRecipes)
  }

  return map
}

// ── Build purchase map from approved invoice scanner sessions ─────────────────
// rcId: when set, uses scanner sessions tagged to that RC.
// fallback: uses legacy InvoiceLineItem records for global (non-RC) counts.
async function buildPurchaseMap(
  since: Date,
  rcId?: string | null,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  if (rcId) {
    // RC-specific: pull from InvoiceScanItem records in approved sessions for this RC
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
        // Use invoice-specific pack structure, then convert to item's base unit
        baseUnits = convertQty(qty * packQty * packSize, packUOM, si.matchedItem.baseUnit)
      } else {
        // Fallback: use the item's recorded pack structure
        const unitsPerCase =
          Number(si.matchedItem.qtyPerPurchaseUnit) * Number(si.matchedItem.packSize)
        baseUnits = qty * unitsPerCase
      }

      map.set(si.matchedItemId, (map.get(si.matchedItemId) ?? 0) + baseUnits)
    }
  } else {
    // Global: use legacy InvoiceLineItem records (non-scanner manual invoices)
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
        Number(p.inventoryItem.qtyPerPurchaseUnit) * Number(p.inventoryItem.packSize)
      const baseUnits = Number(p.qtyPurchased) * unitsPerCase
      map.set(p.inventoryItemId!, (map.get(p.inventoryItemId!) ?? 0) + baseUnits)
    }
  }

  return map
}

// ── Build wastage map with proper unit conversion ─────────────────────────────
// FIX: previously accumulated raw qtyWasted without converting to each item's
// baseUnit, producing incorrect expected quantities for items logged in non-base units.
// rcId: when set, only includes wastage attributed to that revenue center.
async function buildWastageMap(
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
    // Convert logged unit → item's baseUnit before accumulating
    const converted = convertQty(Number(w.qtyWasted), w.unit, w.inventoryItem.baseUnit)
    map.set(w.inventoryItemId, (map.get(w.inventoryItemId) ?? 0) + converted)
  }
  return map
}

// ── POST /api/count/sessions ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const {
    label, type = 'FULL', areaFilter, countedBy, sessionDate, revenueCenterId,
  } = await req.json()

  const areaIds: string[] = areaFilter
    ? areaFilter.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const itemIds = items.map(i => i.id)

  // Earliest "last count date" across all items — defines the lookback window
  const earliestLastCount = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => ((a as Date) > (b as Date) ? 1 : -1))[0] as Date | undefined

  // ── Maps: consumption, purchases, wastage ──────────────────────────────────
  const [consumptionMap, purchaseMap, wastageMap] = await Promise.all([
    earliestLastCount
      ? buildConsumptionMap(earliestLastCount, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildPurchaseMap(earliestLastCount, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
    earliestLastCount
      ? buildWastageMap(earliestLastCount, itemIds, revenueCenterId)
      : Promise.resolve(new Map<string, number>()),
  ])

  // ── RC stock baseline: prefer StockAllocation over global stockOnHand ───────
  // When counting for a specific RC, the starting point is the quantity that RC
  // actually holds (from the last count/allocation), not the global warehouse total.
  const stockAllocationMap = new Map<string, number>()
  if (revenueCenterId && itemIds.length > 0) {
    const allocations = await prisma.stockAllocation.findMany({
      where: {
        revenueCenterId,
        inventoryItemId: { in: itemIds },
      },
      select: { inventoryItemId: true, quantity: true },
    })
    for (const a of allocations) {
      stockAllocationMap.set(a.inventoryItemId, Number(a.quantity))
    }
  }

  const session = await prisma.countSession.create({
    data: {
      label:       label?.trim() || (type === 'FULL' ? 'Full count' : 'Partial count'),
      sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
      type,
      areaFilter:      areaFilter || null,
      revenueCenterId: revenueCenterId || null,
      countedBy,
      lines: {
        create: items.map((item, i) => {
          const consumption = consumptionMap.get(item.id) ?? 0
          const purchases   = purchaseMap.get(item.id)   ?? 0
          const wastage     = wastageMap.get(item.id)    ?? 0

          // Use RC-specific allocation as starting stock when available;
          // fall back to global stockOnHand for items without an allocation.
          const baseStock = revenueCenterId
            ? (stockAllocationMap.has(item.id)
                ? stockAllocationMap.get(item.id)!
                : Number(item.stockOnHand))
            : Number(item.stockOnHand)

          // Theoretical expected: starting stock + received − sold − wasted
          const expected = Math.max(0, baseStock + purchases - consumption - wastage)

          return {
            inventoryItemId: item.id,
            expectedQty:     expected,
            selectedUom:     item.purchaseUnit,
            priceAtCount:    item.pricePerBaseUnit,
            sortOrder:       i,
          }
        }),
      },
    },
    include: {
      lines: {
        include: { inventoryItem: { include: { storageArea: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  return NextResponse.json(
    { ...session, counts: { total: session.lines.length, counted: 0, skipped: 0 } },
    { status: 201 },
  )
}
