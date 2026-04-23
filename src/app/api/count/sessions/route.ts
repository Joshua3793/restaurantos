import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'

// ── GET /api/count/sessions ───────────────────────────────────────────────────
export async function GET() {
  const sessions = await prisma.countSession.findMany({
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

// ── Compute consumption per inventory item from sales since a given date ──────
async function buildConsumptionMap(since: Date): Promise<Map<string, number>> {
  const lineItems = await prisma.saleLineItem.findMany({
    where: { sale: { date: { gte: since } } },
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

  const map = new Map<string, number>() // inventoryItemId → consumed (in item's baseUnit)

  for (const li of lineItems) {
    const recipe = li.recipe
    const qtySold = li.qtySold

    // How many "full batches" does qtySold represent?
    const portionsPerBatch =
      recipe.portionSize && Number(recipe.portionSize) > 0
        ? Number(recipe.baseYieldQty) / Number(recipe.portionSize)
        : 1
    const batches = qtySold / portionsPerBatch

    for (const ing of recipe.ingredients) {
      // Direct inventory ingredient
      if (ing.inventoryItemId && ing.inventoryItem) {
        const itemBaseUnit = ing.inventoryItem.baseUnit
        const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, itemBaseUnit)
        map.set(ing.inventoryItemId, (map.get(ing.inventoryItemId) ?? 0) + consumed)
      }

      // PREP recipe ingredient — deduct from the PREP recipe's linked InventoryItem
      if (ing.linkedRecipeId && ing.linkedRecipe) {
        const prepRecipe = ing.linkedRecipe
        if (prepRecipe.inventoryItemId && prepRecipe.inventoryItem) {
          const itemBaseUnit = prepRecipe.inventoryItem.baseUnit
          const consumed = convertQty(Number(ing.qtyBase) * batches, ing.unit, itemBaseUnit)
          map.set(prepRecipe.inventoryItemId, (map.get(prepRecipe.inventoryItemId) ?? 0) + consumed)
        }
      }
    }
  }

  return map
}

// ── POST /api/count/sessions ──────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { label, type = 'FULL', areaFilter, countedBy, sessionDate } = await req.json()

  // areaFilter is a comma-separated list of storageArea IDs
  const areaIds = areaFilter ? areaFilter.split(',').map((s: string) => s.trim()).filter(Boolean) : []

  const items = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      ...(areaIds.length > 0 ? { storageAreaId: { in: areaIds } } : {}),
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  // Earliest "last count date" across all items (use as the consumption lookback window)
  const earliestLastCount = items
    .map(i => i.lastCountDate)
    .filter(Boolean)
    .sort((a, b) => (a as Date) > (b as Date) ? 1 : -1)[0] as Date | undefined

  // Consumption map since earliest last count
  const consumptionMap = earliestLastCount
    ? await buildConsumptionMap(earliestLastCount)
    : new Map<string, number>()

  // Wastage since earliest last count per item
  const wastageRows = earliestLastCount
    ? await prisma.wastageLog.findMany({
        where: { date: { gte: earliestLastCount } },
        select: { inventoryItemId: true, qtyWasted: true, unit: true },
      })
    : []
  const wastageMap = new Map<string, number>()
  for (const w of wastageRows) {
    // Get item baseUnit for conversion — we'll look it up per item below
    wastageMap.set(w.inventoryItemId, (wastageMap.get(w.inventoryItemId) ?? 0) + Number(w.qtyWasted))
  }

  // Purchases (invoice line items) since earliest last count per item
  const purchaseRows = earliestLastCount
    ? await prisma.invoiceLineItem.findMany({
        where: { invoice: { invoiceDate: { gte: earliestLastCount }, status: { not: 'CANCELLED' } } },
        include: { inventoryItem: { select: { id: true, baseUnit: true, qtyPerPurchaseUnit: true, packSize: true, packUOM: true } } },
      })
    : []
  const purchaseMap = new Map<string, number>()
  for (const p of purchaseRows) {
    if (!p.inventoryItem) continue
    // qtyReceived is in purchase units; convert to base units
    const unitsPerCase = Number(p.inventoryItem.qtyPerPurchaseUnit) * Number(p.inventoryItem.packSize)
    const baseUnits = Number(p.qtyPurchased) * unitsPerCase
    purchaseMap.set(p.inventoryItemId!, (purchaseMap.get(p.inventoryItemId!) ?? 0) + baseUnits)
  }

  const session = await prisma.countSession.create({
    data: {
      label: label?.trim() || (type === 'FULL' ? 'Full count' : 'Partial count'),
      sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
      type,
      areaFilter: areaFilter || null,
      countedBy,
      lines: {
        create: items.map((item, i) => {
          // Theoretical expected qty:
          //   stockOnHand (from last count) + purchases - sales consumption - wastage
          const consumption = consumptionMap.get(item.id) ?? 0
          const purchases   = purchaseMap.get(item.id) ?? 0
          const wastage     = wastageMap.get(item.id) ?? 0
          const expected = Math.max(0, Number(item.stockOnHand) + purchases - consumption - wastage)

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
    { status: 201 }
  )
}
