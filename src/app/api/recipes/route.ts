import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost, linkedRecipeUnitCost } from '@/lib/recipeCosts'
import { PRICING_SELECT } from '@/lib/item-model'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const categoryId = searchParams.get('categoryId')
  const isActiveParam = searchParams.get('isActive')
  const search = searchParams.get('search')
  const rcId = searchParams.get('rcId') || ''

  // MENU: strict per-RC (unchanged). PREP: shared (null) + the active RC shown together.
  const rcFilter = !rcId
    ? {}
    : type === 'MENU'
      ? { revenueCenterId: rcId }
      : type === 'PREP'
        ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
        : {}

  const recipes = await prisma.recipe.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(isActiveParam !== null ? { isActive: isActiveParam === 'true' } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
      ...rcFilter,
    },
    include: {
      category: true,
      _count: { select: { usedInRecipes: true } },
      ingredients: {
        include: {
          inventoryItem: { select: { itemName: true, allergens: true, ...PRICING_SELECT } },
          linkedRecipe: {
            select: {
              name: true,
              yieldUnit: true,
              inventoryItem: { select: { allergens: true, ...PRICING_SELECT } },
            },
          },
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
  })

  const result = recipes.map(recipe => {
    const ingredientsWithLinked = recipe.ingredients.map(ing => {
      let linkedCostPerUnit = 0
      let linkedYieldUnit   = ing.unit
      if (ing.linkedRecipe) {
        const resolved    = linkedRecipeUnitCost(ing.linkedRecipe)
        linkedCostPerUnit = resolved.costPerUnit
        linkedYieldUnit   = resolved.yieldUnit
      }
      return { ...ing, _linkedRecipeCostPerUnit: linkedCostPerUnit, _linkedRecipeYieldUnit: linkedYieldUnit }
    })

    const { totalCost, costPerPortion, foodCostPct, ingredients } = computeRecipeCost({
      ...recipe,
      ingredients: ingredientsWithLinked,
    })

    return {
      id: recipe.id,
      name: recipe.name,
      type: recipe.type,
      categoryId: recipe.categoryId,
      categoryName: recipe.category.name,
      categoryColor: recipe.category.color,
      inventoryItemId: recipe.inventoryItemId,
      revenueCenterId: recipe.revenueCenterId,
      baseYieldQty: Number(recipe.baseYieldQty),
      yieldUnit: recipe.yieldUnit,
      portionSize: recipe.portionSize !== null ? Number(recipe.portionSize) : null,
      portionUnit: recipe.portionUnit,
      baseIngredientId: recipe.baseIngredientId ?? null,
      menuPrice: recipe.menuPrice !== null ? Number(recipe.menuPrice) : null,
      isActive: recipe.isActive,
      notes: recipe.notes,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
      ingredients,
      totalCost,
      costPerPortion,
      foodCostPct,
      usedInCount: recipe._count.usedInRecipes,
      allergens: Array.from(new Set(recipe.ingredients.flatMap(ing => [
        ...(ing.inventoryItem?.allergens ?? []),
        ...(ing.linkedRecipe?.inventoryItem?.allergens ?? []),
      ]))),
    }
  })

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    name, type, categoryId, baseYieldQty, yieldUnit,
    portionSize, portionUnit, menuPrice, notes, isActive, revenueCenterId, steps,
  } = body

  if (!name || !type || !categoryId || !baseYieldQty || !yieldUnit) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const recipe = await prisma.recipe.create({
    data: {
      name,
      type,
      categoryId,
      baseYieldQty: parseFloat(baseYieldQty),
      yieldUnit,
      portionSize: portionSize ? parseFloat(portionSize) : null,
      portionUnit: portionUnit || null,
      menuPrice: menuPrice ? parseFloat(menuPrice) : null,
      notes: notes || null,
      isActive: isActive !== undefined ? isActive : true,
      // PREP and MENU both carry an RC now; null = Shared (visible in all RCs).
      revenueCenterId: revenueCenterId || null,
      steps: Array.isArray(steps) ? steps.filter((s: unknown) => typeof s === 'string') : [],
    },
  })

  // Auto-sync PREP recipes to Inventory
  if (type === 'PREP') {
    const existing = await prisma.inventoryItem.findFirst({
      where: { itemName: name, category: 'PREPD' },
    })

    const invItem = existing
      ? await prisma.inventoryItem.update({
          where: { id: existing.id },
          data: { baseUnit: yieldUnit, lastUpdated: new Date() },
        })
      : await prisma.inventoryItem.create({
          data: {
            itemName: name,
            category: 'PREPD',
            purchaseUnit: yieldUnit,
            qtyPerPurchaseUnit: parseFloat(baseYieldQty),
            purchasePrice: 0,
            baseUnit: yieldUnit,
            packSize: 1,
            packUOM: yieldUnit,
            countUOM: yieldUnit,
            conversionFactor: 1,
            pricePerBaseUnit: 0,
            stockOnHand: 0,
          },
        })

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { inventoryItemId: invItem.id },
    })

    return NextResponse.json({ ...recipe, inventoryItemId: invItem.id }, { status: 201 })
  }

  return NextResponse.json(recipe, { status: 201 })
}
