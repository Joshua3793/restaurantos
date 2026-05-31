import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computePriority, computeSuggestedQty, PREP_PRIORITY_ORDER } from '@/lib/prep-utils'

const recipeInclude = {
  select: {
    id: true,
    name: true,
    yieldUnit: true,
    baseYieldQty: true,
    inventoryItemId: true,
    inventoryItem: {
      select: { id: true, stockOnHand: true },
    },
    ingredients: {
      include: {
        inventoryItem: {
          select: { id: true, itemName: true, stockOnHand: true },
        },
      },
    },
  },
} as const

export async function GET(req: NextRequest) {
  try {
  const { searchParams } = new URL(req.url)
  const activeOnly = searchParams.get('active') !== 'false'

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const tomorrow = new Date(today.getTime() + 86_400_000)

  const items = await prisma.prepItem.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    include: {
      linkedRecipe: recipeInclude,
      linkedInventoryItem: {
        select: { id: true, itemName: true, stockOnHand: true, baseUnit: true },
      },
      logs: {
        where: { logDate: { gte: today, lt: tomorrow } },
        take: 1,
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const itemIds = items.map(i => i.id)
  const doneLogs = await prisma.prepLog.findMany({
    where: { prepItemId: { in: itemIds }, status: { in: ['DONE', 'PARTIAL'] } },
    orderBy: { logDate: 'desc' },
    select: { prepItemId: true, logDate: true },
  })
  const lastMadeByItem = new Map<string, string>()
  for (const l of doneLogs) {
    if (!lastMadeByItem.has(l.prepItemId)) lastMadeByItem.set(l.prepItemId, l.logDate.toISOString())
  }

  const enriched = items.map(item => {
    // Resolve onHand
    let onHand = 0
    if (item.linkedInventoryItem) {
      onHand = parseFloat(String(item.linkedInventoryItem.stockOnHand))
    } else if (item.linkedRecipe?.inventoryItem) {
      onHand = parseFloat(String(item.linkedRecipe.inventoryItem.stockOnHand))
    }

    const parLevel     = parseFloat(String(item.parLevel))
    const minThreshold = parseFloat(String(item.minThreshold))
    const targetToday  = item.targetToday ? parseFloat(String(item.targetToday)) : null

    const priority     = computePriority(onHand, parLevel, minThreshold, targetToday, item.manualPriorityOverride)
    const suggestedQty = computeSuggestedQty(onHand, parLevel, targetToday)

    // Blocked check — any ingredient at zero stock?
    // The recipe ingredients are already resolved (with stockOnHand) via recipeInclude.
    let isBlocked   = false
    let blockedReason: string | null = null
    let ingredientTotalCount: number | null = null
    let ingredientShortCount: number | null = null
    if (item.linkedRecipe) {
      const ings = item.linkedRecipe.ingredients
      ingredientTotalCount = ings.length
      ingredientShortCount = ings.filter(
        ing => ing.inventoryItem != null && Number(ing.inventoryItem.stockOnHand) <= 0,
      ).length
      const low = ings
        .filter(ing => ing.inventoryItem && parseFloat(String(ing.inventoryItem.stockOnHand)) <= 0)
        .map(ing => ing.inventoryItem!.itemName)
      if (low.length > 0) {
        isBlocked     = true
        blockedReason = `Low stock: ${low.join(', ')}`
      }
    }

    return {
      id: item.id,
      name: item.name,
      category: item.category,
      station: item.station,
      parLevel,
      unit: item.unit,
      minThreshold,
      targetToday,
      shelfLifeDays: item.shelfLifeDays,
      estimatedPrepTime: item.estimatedPrepTime ?? null,
      notes: item.notes,
      manualPriorityOverride: item.manualPriorityOverride,
      isActive: item.isActive,
      isOnList: item.isOnList,
      linkedRecipeId: item.linkedRecipeId,
      linkedRecipe: item.linkedRecipe
        ? {
            id: item.linkedRecipe.id,
            name: item.linkedRecipe.name,
            yieldUnit: item.linkedRecipe.yieldUnit,
            baseYieldQty: parseFloat(String(item.linkedRecipe.baseYieldQty)),
          }
        : null,
      linkedInventoryItemId: item.linkedInventoryItemId,
      onHand,
      priority,
      suggestedQty,
      isBlocked,
      blockedReason,
      ingredientTotalCount,
      ingredientShortCount,
      lastMadeAt: lastMadeByItem.get(item.id) ?? null,
      todayLog: item.logs[0] ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }
  })

  enriched.sort((a, b) => {
    const pa = PREP_PRIORITY_ORDER.indexOf(a.priority)
    const pb = PREP_PRIORITY_ORDER.indexOf(b.priority)
    if (pa !== pb) return pa - pb
    return a.name.localeCompare(b.name)
  })

  return NextResponse.json(enriched, {
    headers: { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' },
  })
  } catch (err) {
    console.error('[prep/items GET]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    name, linkedRecipeId, linkedInventoryItemId,
    category, station, parLevel, unit, minThreshold,
    targetToday, shelfLifeDays, estimatedPrepTime, notes, manualPriorityOverride,
  } = body

  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const item = await prisma.prepItem.create({
    data: {
      name,
      linkedRecipeId:        linkedRecipeId        || null,
      linkedInventoryItemId: linkedInventoryItemId || null,
      category:              category              || 'MISC',
      station:               station               || null,
      parLevel:              parLevel   ? parseFloat(String(parLevel))   : 0,
      unit:                  unit       || 'batch',
      minThreshold:          minThreshold ? parseFloat(String(minThreshold)) : 0,
      targetToday:           targetToday  ? parseFloat(String(targetToday))  : null,
      shelfLifeDays:         shelfLifeDays ? parseInt(String(shelfLifeDays)) : null,
      estimatedPrepTime:     estimatedPrepTime ? parseInt(String(estimatedPrepTime)) : null,
      notes:                 notes || null,
      manualPriorityOverride: manualPriorityOverride || null,
    },
  })

  return NextResponse.json(item, { status: 201 })
}
