import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost, linkedRecipeUnitCost } from '@/lib/recipeCosts'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit } from '@/lib/item-model'

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ inventory: [], recipes: [], invoices: [], suppliers: [] })

  const contains = { contains: q, mode: 'insensitive' as const }

  const [inventoryRaw, rawRecipes, invoices, suppliers] = await Promise.all([
    prisma.inventoryItem.findMany({
      // non-stocked items are valid recipe ingredients — do NOT filter isStocked
      where: { isActive: true, itemName: contains },
      select: { id: true, itemName: true, category: true, stockOnHand: true, ...PRICING_SELECT },
      orderBy: { itemName: 'asc' },
      take: 6,
    }),
    prisma.recipe.findMany({
      where: { isActive: true, name: contains },
      include: {
        category: { select: { name: true } },
        ingredients: {
          include: {
            inventoryItem: { select: { itemName: true, ...PRICING_SELECT } },
            linkedRecipe: {
              select: {
                name: true,
                yieldUnit: true,
                inventoryItem: { select: { ...PRICING_SELECT } },
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

  // Keep the response's inventory[].pricePerBaseUnit field populated by
  // computing it from the chain (survives the legacy column drop).
  const inventory = inventoryRaw.map(i => ({ ...i, pricePerBaseUnit: pricePerBaseUnit(asChainItem(i)) }))

  // Compute totalCost for each recipe the same way the recipes API does
  const recipes = rawRecipes.map(recipe => {
    const ingredientsWithLinked = recipe.ingredients.map(ing => {
      let linkedCostPerUnit = 0
      let linkedYieldUnit = ing.unit
      if (ing.linkedRecipe) {
        const resolved = linkedRecipeUnitCost(ing.linkedRecipe)
        linkedCostPerUnit = resolved.costPerUnit
        linkedYieldUnit = resolved.yieldUnit
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
