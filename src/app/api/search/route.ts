import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost } from '@/lib/recipeCosts'
import { convertQty } from '@/lib/uom'

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ inventory: [], recipes: [], invoices: [], suppliers: [] })

  const contains = { contains: q, mode: 'insensitive' as const }

  const [inventory, rawRecipes, invoices, suppliers] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { isActive: true, itemName: contains },
      select: { id: true, itemName: true, category: true, stockOnHand: true, baseUnit: true, pricePerBaseUnit: true },
      orderBy: { itemName: 'asc' },
      take: 6,
    }),
    prisma.recipe.findMany({
      where: { isActive: true, name: contains },
      include: {
        category: { select: { name: true } },
        ingredients: {
          include: {
            inventoryItem: { select: { itemName: true, baseUnit: true, pricePerBaseUnit: true } },
            linkedRecipe: {
              include: {
                ingredients: { include: { inventoryItem: { select: { baseUnit: true, pricePerBaseUnit: true } } } },
              },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
      take: 6,
    }),
    prisma.invoice.findMany({
      where: {
        OR: [
          { invoiceNumber: contains },
          { supplier: { name: contains } },
        ],
      },
      select: {
        id: true, invoiceNumber: true, status: true,
        invoiceDate: true, totalAmount: true,
        supplier: { select: { name: true } },
      },
      orderBy: { invoiceDate: 'desc' },
      take: 5,
    }),
    prisma.supplier.findMany({
      where: { name: contains },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 4,
    }),
  ])

  // Compute totalCost for each recipe the same way the recipes API does
  const recipes = rawRecipes.map(recipe => {
    const ingredientsWithLinked = recipe.ingredients.map(ing => {
      let linkedCostPerUnit = 0
      let linkedYieldUnit = ing.unit
      if (ing.linkedRecipe) {
        const linkedTotal = ing.linkedRecipe.ingredients.reduce((s, li) => {
          const baseUnit = li.inventoryItem?.baseUnit ?? li.unit
          const qtyInBase = convertQty(Number(li.qtyBase), li.unit, baseUnit)
          return s + qtyInBase * Number(li.inventoryItem?.pricePerBaseUnit ?? 0)
        }, 0)
        const linkedYield = Number(ing.linkedRecipe.baseYieldQty)
        linkedCostPerUnit = linkedYield > 0 ? linkedTotal / linkedYield : 0
        linkedYieldUnit = ing.linkedRecipe.yieldUnit
      }
      return { ...ing, _linkedRecipeCostPerUnit: linkedCostPerUnit, _linkedRecipeYieldUnit: linkedYieldUnit }
    })

    const { totalCost } = computeRecipeCost({ ...recipe, ingredients: ingredientsWithLinked })

    return {
      id: recipe.id,
      name: recipe.name,
      type: recipe.type,
      menuPrice: recipe.menuPrice !== null ? Number(recipe.menuPrice) : null,
      totalCost,
      category: recipe.category,
    }
  })

  return NextResponse.json({ inventory, recipes, invoices, suppliers })
}
