import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { convertQty } from '@/lib/uom'
import { convertCountQtyToBase } from '@/lib/count-uom'
import { requireSession, AuthError } from '@/lib/auth'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

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
        select: {
          baseYieldQty: true,
          portionSize: true,
          ingredients: {
            select: {
              qtyBase: true, unit: true, inventoryItemId: true, linkedRecipeId: true,
              inventoryItem: { select: { id: true, itemName: true, ...PRICING_SELECT } },
              // A linked PREP is its OWN tracked stock item (PREPD). Selling depletes
              // that prep stock — NOT its raw ingredients, which were already consumed
              // (and the prep credited) at prep time. See prep/logs/[id]/route.ts.
              linkedRecipe: { select: { inventoryItem: { select: { id: true, itemName: true, ...PRICING_SELECT } } } },
            },
          },
        },
      },
    },
  })

  // ── 2. Accumulate theoretical usage per inventory item ───────────────────
  // Theoretical usage stops at the PREP item (mirrors src/lib/count-expected.ts), so
  // this report reconciles with count variance and never double-counts raws that moved
  // at prep time. Recursing into a prep's raws here would double-count those raws.
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
    // batches sold = portions sold ÷ portions per batch (same math as count-expected)
    const portionsPerBatch =
      recipe.portionSize && Number(recipe.portionSize) > 0
        ? Number(recipe.baseYieldQty) / Number(recipe.portionSize)
        : 1
    const batches = sli.qtySold / portionsPerBatch

    for (const ing of recipe.ingredients) {
      const qty = Number(ing.qtyBase) * batches

      if (ing.inventoryItemId && ing.inventoryItem) {
        // Direct inventory item
        const it = ing.inventoryItem
        addUsage(it.id, it.itemName, it.baseUnit, pricePerBaseUnit(asChainItem(it)), convertQty(qty, ing.unit, it.baseUnit))
      } else if (ing.linkedRecipeId && ing.linkedRecipe?.inventoryItem) {
        // Linked PREP → charge the prep item's own stock and stop (no recursion)
        const prep = ing.linkedRecipe.inventoryItem
        addUsage(prep.id, prep.itemName, prep.baseUnit, pricePerBaseUnit(asChainItem(prep)), convertQty(qty, ing.unit, prep.baseUnit))
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
          inventoryItem: {
            select: {
              id: true, baseUnit: true,
              dimension: true, packChain: true, countUnit: true,
            },
          },
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
      if (cl.countedQty === null) continue
      const item = cl.inventoryItem
      const dims = {
        dimension: item.dimension, baseUnit: item.baseUnit,
        packChain: item.packChain, countUnit: item.countUnit,
      }
      openMap[item.id] = convertCountQtyToBase(Number(cl.countedQty), cl.selectedUom, dims)
    }
    for (const cl of closingSession.lines) {
      if (cl.countedQty === null) continue
      const item = cl.inventoryItem
      const dims = {
        dimension: item.dimension, baseUnit: item.baseUnit,
        packChain: item.packChain, countUnit: item.countUnit,
      }
      closeMap[item.id] = convertCountQtyToBase(Number(cl.countedQty), cl.selectedUom, dims)
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
