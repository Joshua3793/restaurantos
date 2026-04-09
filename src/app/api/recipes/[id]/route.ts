import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, syncPrepToInventory } from '@/lib/recipeCosts'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(recipe)
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive } = body

  await prisma.recipe.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(baseYieldQty !== undefined ? { baseYieldQty: parseFloat(baseYieldQty) } : {}),
      ...(yieldUnit !== undefined ? { yieldUnit } : {}),
      ...(portionSize !== undefined ? { portionSize: portionSize ? parseFloat(portionSize) : null } : {}),
      ...(portionUnit !== undefined ? { portionUnit } : {}),
      ...(menuPrice !== undefined ? { menuPrice: menuPrice ? parseFloat(menuPrice) : null } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    },
  })

  await syncPrepToInventory(params.id)
  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Soft delete
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.recipe.update({ where: { id: params.id }, data: { isActive: false } })
  return NextResponse.json({ success: true })
}
