import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost } from '@/lib/recipeCosts'
import { convertQty } from '@/lib/uom'
import { requireSession, AuthError } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try { await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const startDate = searchParams.get('startDate')
  const endDate   = searchParams.get('endDate')

  // ── 1. Sales line items in range ─────────────────────────────────────────
  const sales = await prisma.saleLineItem.findMany({
    where: {
      sale: {
        date: {
          ...(startDate ? { gte: new Date(startDate) } : {}),
          ...(endDate   ? { lte: new Date(endDate + 'T23:59:59') } : {}),
        },
      },
    },
    include: {
      sale: { select: { date: true } },
      recipe: {
        include: {
          ingredients: {
            include: {
              inventoryItem: { select: { id: true, itemName: true, baseUnit: true, pricePerBaseUnit: true } },
              linkedRecipe: {
                include: {
                  ingredients: {
                    include: {
                      inventoryItem: { select: { id: true, itemName: true, baseUnit: true, pricePerBaseUnit: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  })

  // ── 2. Accumulate theoretical usage per inventory item ───────────────────
  // theoretical usage (baseUnit) = qtySold × ingredientQtyBase / baseYieldQty
  const usageMap: Record<string, {
    itemName: string
    baseUnit: string
    pricePerBaseUnit: number
    theoreticalQty: number   // in baseUnit
  }> = {}

  const addUsage = (itemId: string, itemName: string, baseUnit: string, price: number, qty: number) => {
    if (!usageMap[itemId]) {
      usageMap[itemId] = { itemName, baseUnit, pricePerBaseUnit: price, theoreticalQty: 0 }
    }
    usageMap[itemId].theoreticalQty += qty
  }

  for (const sli of sales) {
    const recipe = sli.recipe
    const qtySold = sli.qtySold
    const batchYield = Number(recipe.baseYieldQty) || 1

    for (const ing of recipe.ingredients) {
      const ingQtyBase = Number(ing.qtyBase)
      const qtyPerPortion = ingQtyBase / batchYield
      const theoreticalUse = qtyPerPortion * qtySold

      if (ing.inventoryItemId && ing.inventoryItem) {
        // Direct inventory item
        const baseUnit = ing.inventoryItem.baseUnit
        const qtyInBase = convertQty(theoreticalUse, ing.unit, baseUnit)
        addUsage(
          ing.inventoryItem.id,
          ing.inventoryItem.itemName,
          baseUnit,
          Number(ing.inventoryItem.pricePerBaseUnit),
          qtyInBase
        )
      } else if (ing.linkedRecipeId && ing.linkedRecipe) {
        // Sub-recipe: expand its ingredients proportionally
        const subYield = Number(ing.linkedRecipe.baseYieldQty) || 1
        for (const subIng of ing.linkedRecipe.ingredients) {
          if (!subIng.inventoryItem) continue
          const subQtyBase = Number(subIng.qtyBase)
          const subQtyPerUnit = subQtyBase / subYield
          const subTheoretical = subQtyPerUnit * theoreticalUse
          const baseUnit = subIng.inventoryItem.baseUnit
          const qtyInBase = convertQty(subTheoretical, subIng.unit, baseUnit)
          addUsage(
            subIng.inventoryItem.id,
            subIng.inventoryItem.itemName,
            baseUnit,
            Number(subIng.inventoryItem.pricePerBaseUnit),
            qtyInBase
          )
        }
      }
    }
  }

  // ── 3. Actual count-based usage (opening − closing stock) ─────────────────
  // Find count sessions that bracket the date range
  const countSessions = await prisma.countSession.findMany({
    where: { status: 'FINALIZED' },
    include: {
      lines: {
        include: {
          inventoryItem: { select: { id: true } },
        },
      },
    },
    orderBy: { sessionDate: 'asc' },
  })

  // Find the closest session before startDate (opening) and after endDate (closing)
  let openingSession = null
  let closingSession = null
  if (startDate && endDate) {
    const start = new Date(startDate)
    const end   = new Date(endDate)
    openingSession = countSessions.filter(s => new Date(s.sessionDate) <= start).at(-1) ?? null
    closingSession = countSessions.filter(s => new Date(s.sessionDate) >= end)[0] ?? null
  }

  // Build actual usage map from count lines
  const actualUsageMap: Record<string, number> = {}
  if (openingSession && closingSession) {
    const openMap: Record<string, number> = {}
    const closeMap: Record<string, number> = {}
    for (const cl of openingSession.lines) {
      openMap[cl.inventoryItem.id] = Number(cl.countedQty)
    }
    for (const cl of closingSession.lines) {
      closeMap[cl.inventoryItem.id] = Number(cl.countedQty)
    }
    // Actual usage = opening - closing (positive = used, negative = gained/purchased)
    for (const id of new Set([...Object.keys(openMap), ...Object.keys(closeMap)])) {
      actualUsageMap[id] = (openMap[id] ?? 0) - (closeMap[id] ?? 0)
    }
  }

  // ── 4. Build result rows ──────────────────────────────────────────────────
  const rows = Object.entries(usageMap).map(([id, item]) => {
    const theoretical = item.theoreticalQty
    const actual = actualUsageMap[id] ?? null
    const gap = actual !== null ? actual - theoretical : null
    const theoreticalCost = theoretical * item.pricePerBaseUnit
    const gapCost = gap !== null ? gap * item.pricePerBaseUnit : null
    return {
      id,
      itemName: item.itemName,
      baseUnit: item.baseUnit,
      theoreticalQty: parseFloat(theoretical.toFixed(3)),
      actualQty: actual !== null ? parseFloat(actual.toFixed(3)) : null,
      gap: gap !== null ? parseFloat(gap.toFixed(3)) : null,
      theoreticalCost: parseFloat(theoreticalCost.toFixed(2)),
      gapCost: gapCost !== null ? parseFloat(gapCost.toFixed(2)) : null,
      pricePerBaseUnit: item.pricePerBaseUnit,
    }
  })
    .sort((a, b) => b.theoreticalCost - a.theoreticalCost)

  const meta = {
    totalSales: sales.reduce((s, li) => s + li.qtySold, 0),
    totalTheoreticalCost: rows.reduce((s, r) => s + r.theoreticalCost, 0),
    totalGapCost: rows.reduce((s, r) => s + (r.gapCost ?? 0), 0),
    hasActual: openingSession !== null && closingSession !== null,
    openingLabel: openingSession?.label ?? null,
    closingLabel: closingSession?.label ?? null,
  }

  return NextResponse.json({ rows, meta })
}
