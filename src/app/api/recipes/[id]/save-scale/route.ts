import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resyncPrepRecipe } from '@/lib/recipeCosts'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'
import { dimensionOf } from '@/lib/item-model'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'

/**
 * Persist a scaled copy of a recipe.
 *
 * This is a second recipe-CREATE path, so everything `POST /api/recipes` does
 * for a new recipe has to happen here too. It previously did not: a scaled PREP
 * recipe got no linked InventoryItem, which left it unusable as an ingredient
 * with its cost stored nowhere, and the copy silently dropped the source's
 * revenue center, steps, custom ingredient names and baker's percentages.
 *
 * The source is read straight from Prisma rather than through
 * fetchRecipeWithCost: a clone needs every stored column, and costs are derived
 * on read anyway.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let user
  try { user = await requireSession() }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json()
  const { newName, factor } = body

  const f = parseFloat(factor)
  if (!newName || !String(newName).trim() || !Number.isFinite(f) || f <= 0) {
    return NextResponse.json({ error: 'newName and a positive numeric factor are required' }, { status: 400 })
  }

  const source = await prisma.recipe.findUnique({
    where: { id: params.id },
    include: { ingredients: { orderBy: { sortOrder: 'asc' } } },
  })
  if (!source) return NextResponse.json({ error: 'Source recipe not found' }, { status: 404 })

  // The copy inherits the source's RC, so it needs the same write guard the
  // canonical create applies. Shared recipes (null) are unguarded.
  if (source.revenueCenterId) {
    try { await assertRcWritable(user, source.revenueCenterId) }
    catch (e) {
      if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
      throw e
    }
  }

  const name = String(newName).trim()
  const recipe = await prisma.recipe.create({
    data: {
      name,
      type: source.type,
      categoryId: source.categoryId,
      baseYieldQty: Number(source.baseYieldQty) * f,
      yieldUnit: source.yieldUnit,
      // portionSize is deliberately NOT scaled. A ×5 batch yields five times as
      // many portions, not portions five times the size — and the read-only
      // preview at /api/recipes/[id]/scale already scales the yield alone and
      // states that cost per portion is unchanged. Scaling it here made the
      // saved copy disagree with the preview it came from, and pushed cost per
      // portion (and so food cost %) out by exactly the scale factor.
      portionSize: source.portionSize,
      portionUnit: source.portionUnit,
      menuPrice: source.menuPrice,
      notes: source.notes,
      isActive: true,
      revenueCenterId: source.revenueCenterId,
      steps: source.steps,
      ingredients: {
        create: source.ingredients.map((ing, i) => ({
          inventoryItemId: ing.inventoryItemId,
          linkedRecipeId: ing.linkedRecipeId,
          // The third ingredient kind: a free-text uncosted line with both ids
          // null. Dropping it silently emptied the row.
          customName: ing.customName,
          qtyBase: Number(ing.qtyBase) * f,
          unit: ing.unit,
          // A baker's percentage is a ratio, so it survives scaling unchanged.
          recipePercent: ing.recipePercent,
          notes: ing.notes,
          sortOrder: i,
        })),
      },
    },
  })

  // Same auto-sync the canonical create runs: a PREP recipe without a linked
  // InventoryItem cannot be used as an ingredient anywhere and its computed cost
  // has nowhere to live.
  if (source.type === 'PREP') {
    const existing = await prisma.inventoryItem.findFirst({
      where: { itemName: name, category: 'PREPD' },
    })

    const invItem = existing
      ? await prisma.inventoryItem.update({
          where: { id: existing.id },
          data: { baseUnit: source.yieldUnit, lastUpdated: new Date() },
        })
      : await prisma.inventoryItem.create({
          data: {
            itemName: name,
            category: 'PREPD',
            purchasePrice: 0,
            baseUnit: source.yieldUnit,
            stockOnHand: 0,
            // Chain placeholder — syncPrepToInventory fills in the real cost/yield.
            dimension: dimensionOf(source.yieldUnit),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            packChain: [{ unit: source.yieldUnit, per: Number(recipe.baseYieldQty) || 1 }] as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pricing: { mode: 'PACK', purchasePrice: 0 } as any,
            countUnit: source.yieldUnit,
          },
        })

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: { inventoryItemId: invItem.id },
    })

    // Unlike the canonical create, the copy already HAS its ingredients here, so
    // this resync is what actually prices the new linked item.
    await resyncPrepRecipe(recipe.id).catch(e => console.error('[save-scale] resync', e))
    await syncPrepItemFromRecipe(recipe.id).catch(e => console.error('[save-scale] prep-item sync', e))
    return NextResponse.json({ ...recipe, inventoryItemId: invItem.id }, { status: 201 })
  }

  return NextResponse.json(recipe, { status: 201 })
}
