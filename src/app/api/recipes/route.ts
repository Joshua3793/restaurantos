import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost } from '@/lib/recipeCosts'
import { convertQty } from '@/lib/uom'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const categoryId = searchParams.get('categoryId')
  const isActiveParam = searchParams.get('isActive')
  const search = searchParams.get('search')

  const recipes = await prisma.recipe.findMany({
    where: {
      ...(type ? { type } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(isActiveParam !== null ? { isActive: isActiveParam === 'true' } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
    },
    include: {
      category: true,
      _count: { select: { usedInRecipes: true } },
      ingredients: {
        include: {
          inventoryItem: { select: { itemName: true, baseUnit: true, pricePerBaseUnit: true, allergens: true } },
          linkedRecipe: {
            include: {
              ingredients: { include: { inventoryItem: { select: { baseUnit: true, pricePerBaseUnit: true, allergens: true } } } },
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
        const linkedTotal = ing.linkedRecipe.ingredients.reduce((s, li) => {
          const baseUnit  = li.inventoryItem?.baseUnit ?? li.unit
          const qtyInBase = convertQty(Number(li.qtyBase), li.unit, baseUnit)
          return s + qtyInBase * Number(li.inventoryItem?.pricePerBaseUnit ?? 0)
        }, 0)
        const linkedYield  = Number(ing.linkedRecipe.baseYieldQty)
        linkedCostPerUnit  = linkedYield > 0 ? linkedTotal / linkedYield : 0
        linkedYieldUnit    = ing.linkedRecipe.yieldUnit
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
      baseYieldQty: Number(recipe.baseYieldQty),
      yieldUnit: recipe.yieldUnit,
      portionSize: recipe.portionSize !== null ? Number(recipe.portionSize) : null,
      portionUnit: recipe.portionUnit,
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
        ...(ing.linkedRecipe?.ingredients.flatMap(li => li.inventoryItem?.allergens ?? []) ?? []),
      ]))),
    }
  })

  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const {
    name, type, categoryId, baseYieldQty, yieldUnit,
    portionSize, portionUnit, menuPrice, notes, isActive,
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
