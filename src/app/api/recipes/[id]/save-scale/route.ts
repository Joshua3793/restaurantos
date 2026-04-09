import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost } from '@/lib/recipeCosts'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { newName, factor } = body

  if (!newName || !factor) {
    return NextResponse.json({ error: 'newName and factor required' }, { status: 400 })
  }

  const f = parseFloat(factor)
  const source = await fetchRecipeWithCost(params.id)
  if (!source) return NextResponse.json({ error: 'Source recipe not found' }, { status: 404 })

  const newRecipe = await prisma.recipe.create({
    data: {
      name: newName,
      type: source.type,
      categoryId: source.categoryId,
      baseYieldQty: source.baseYieldQty * f,
      yieldUnit: source.yieldUnit,
      portionSize: source.portionSize !== null ? source.portionSize * f : null,
      portionUnit: source.portionUnit,
      menuPrice: source.menuPrice,
      notes: source.notes,
      isActive: true,
      ingredients: {
        create: source.ingredients.map((ing, i) => ({
          inventoryItemId: ing.inventoryItemId,
          linkedRecipeId: ing.linkedRecipeId,
          qtyBase: ing.qtyBase * f,
          unit: ing.unit,
          notes: ing.notes,
          sortOrder: i,
        })),
      },
    },
  })

  return NextResponse.json(newRecipe, { status: 201 })
}
