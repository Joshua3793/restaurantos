import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q') ?? ''

  const [invItems, prepRecipes] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: {
        isActive: true,
        ...(q ? { itemName: { contains: q } } : {}),
      },
      select: { id: true, itemName: true, baseUnit: true, pricePerBaseUnit: true, category: true },
      orderBy: { itemName: 'asc' },
      take: 20,
    }),
    prisma.recipe.findMany({
      where: {
        type: 'PREP',
        isActive: true,
        ...(q ? { name: { contains: q } } : {}),
      },
      include: {
        ingredients: {
          include: { inventoryItem: { select: { pricePerBaseUnit: true } } },
        },
      },
      orderBy: { name: 'asc' },
      take: 20,
    }),
  ])

  const invResults = invItems.map(item => ({
    type: 'inventory' as const,
    id: item.id,
    name: item.itemName,
    unit: item.baseUnit,
    pricePerBaseUnit: Number(item.pricePerBaseUnit),
    category: item.category,
  }))

  const recipeResults = prepRecipes.map(recipe => {
    const totalCost = recipe.ingredients.reduce(
      (s, ing) => s + Number(ing.qtyBase) * Number(ing.inventoryItem?.pricePerBaseUnit ?? 0),
      0
    )
    const yieldQty = Number(recipe.baseYieldQty)
    const pricePerBaseUnit = yieldQty > 0 ? totalCost / yieldQty : 0
    return {
      type: 'recipe' as const,
      id: recipe.id,
      name: recipe.name,
      unit: recipe.yieldUnit,
      pricePerBaseUnit,
      category: 'PREPD',
    }
  })

  return NextResponse.json([...invResults, ...recipeResults])
}
