import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeRecipeCost, linkedRecipeUnitCost, resyncPrepRecipe } from '@/lib/recipeCosts'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'
import { PRICING_SELECT, dimensionOf } from '@/lib/item-model'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { requireSession, AuthError } from '@/lib/auth'
import { resolveScopedRcIds, scopedRcWhere, assertRcWritable } from '@/lib/rc-scope'

export async function GET(req: NextRequest) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type')
  const categoryId = searchParams.get('categoryId')
  const isActiveParam = searchParams.get('isActive')
  const search = searchParams.get('search')
  const rcId = searchParams.get('rcId') || ''

  const allowed = await resolveScopedRcIds(user)

  // MENU: strict per-RC (unchanged). PREP: shared (null) + the active RC shown together.
  // scopedRcWhere reproduces these shapes AND narrows to the user's scope (fails
  // closed for an out-of-scope rcId). For PREP we always union shared (null) rows:
  // passing isDefault=true gives the null-union shape, and the no-rcId PREP case is
  // widened to "shared OR in-scope" so shared prep stays visible to scoped users.
  let rcFilter: Record<string, unknown>
  if (type === 'MENU') {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  } else if (type === 'PREP') {
    rcFilter = rcId
      ? scopedRcWhere(allowed, rcId, true)
      : (allowed === null
          ? {}
          : { OR: [{ revenueCenterId: null }, { revenueCenterId: { in: [...allowed] } }] })
  } else {
    rcFilter = scopedRcWhere(allowed, rcId || null, false)
  }

  const recipes = await prisma.recipe.findMany({
    where: {
      AND: [
        type ? { type } : {},
        categoryId ? { categoryId } : {},
        isActiveParam !== null ? { isActive: isActiveParam === 'true' } : {},
        search ? { name: { contains: search, mode: 'insensitive' as const } } : {},
        rcFilter,
      ],
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

    const { totalCost, costPerPortion, foodCostPct, dimensionConflicts, ingredients } = computeRecipeCost({
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
      dimensionConflicts,
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
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const {
    name, type, categoryId, baseYieldQty, yieldUnit,
    portionSize, portionUnit, menuPrice, notes, isActive, revenueCenterId, steps,
  } = body

  if (!name || !type || !categoryId || !baseYieldQty || !yieldUnit) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // Recipes may be Shared (revenueCenterId null) — only guard when one is set.
  if (revenueCenterId) {
    try { await assertRcWritable(user, revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  // Validate + normalize units against the UOM backbone.
  let canonYield: string
  let canonPortion: string | null
  try {
    canonYield = assertKnownUnit(yieldUnit, 'yield unit')
    canonPortion = portionUnit ? assertKnownUnit(portionUnit, 'portion unit') : null
  } catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }

  const recipe = await prisma.recipe.create({
    data: {
      name,
      type,
      categoryId,
      baseYieldQty: parseFloat(baseYieldQty),
      yieldUnit: canonYield,
      portionSize: portionSize ? parseFloat(portionSize) : null,
      portionUnit: canonPortion,
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
          data: { baseUnit: canonYield, lastUpdated: new Date() },
        })
      : await prisma.inventoryItem.create({
          data: {
            itemName: name,
            category: 'PREPD',
            purchasePrice: 0,
            baseUnit: canonYield,
            stockOnHand: 0,
            // Chain placeholder — syncPrepToInventory fills in the real cost/yield.
            dimension: dimensionOf(canonYield),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            packChain: [{ unit: canonYield, per: parseFloat(baseYieldQty) || 1 }] as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pricing: { mode: 'PACK', purchasePrice: 0 } as any,
            countUnit: canonYield,
          },
        })

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { inventoryItemId: invItem.id },
    })

    // Initialise the linked item from the recipe (near no-op at create — no ingredients yet —
    // but keeps the create path uniform with edits).
    await resyncPrepRecipe(recipe.id).catch(e => console.error('[recipe POST] resync', e))
    await syncPrepItemFromRecipe(recipe.id).catch(e => console.error('[recipe POST] prep-item sync', e))
    return NextResponse.json({ ...recipe, inventoryItemId: invItem.id }, { status: 201 })
  }

  return NextResponse.json(recipe, { status: 201 })
}
