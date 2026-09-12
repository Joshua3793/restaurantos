import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { fetchRecipeWithCost, resyncPrepRecipe, propagatePrepCostChanges } from '@/lib/recipeCosts'
import { syncPrepItemFromRecipe } from '@/lib/prep-sync'
import { assertKnownUnit, UnitError } from '@/lib/uom'
import { Prisma } from '@prisma/client'
import { validateStages } from '@/lib/prep-stages'
import { validateMethod } from '@/lib/recipe-method'
import { numOrNull } from '@/lib/prep-utils'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const recipe = await fetchRecipeWithCost(params.id)
  if (!recipe) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const upstream = await prisma.recipeIngredient.findMany({
    where: { linkedRecipeId: params.id },
    select: { recipe: { select: { id: true, name: true, type: true } } },
  })
  const usedInRecipes = upstream
    .map(u => u.recipe)
    .filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i)

  return NextResponse.json({ ...recipe, usedInRecipes })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const {
    name, categoryId, baseYieldQty, yieldUnit, portionSize, portionUnit, menuPrice, notes, isActive, baseIngredientId, steps, revenueCenterId,
    // Run-sheet timing on the recipe itself (the PrepItem overrides sit above these),
    // and the staged-prep chain. `stages: null` / `[]` clears the chain.
    activeMinutes, passiveMinutes, passiveNote, stages,
    // One Method, with waits — supersedes `steps` + `stages` (both still accepted for a release).
    method,
    prep,
  } = body

  // Validate + normalize units when they're being changed.
  let canonYield: string | undefined
  let canonPortion: string | null | undefined
  try {
    if (yieldUnit   !== undefined) canonYield   = assertKnownUnit(yieldUnit, 'yield unit')
    if (portionUnit !== undefined) canonPortion = portionUnit ? assertKnownUnit(portionUnit, 'portion unit') : null
  } catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }

  // Stages are validated by the lib (≥1, last ACTIVE, no back-to-back PASSIVE,
  // integer minutes, unique keys) — a chain the run sheet cannot walk never lands.
  let stagesData: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined
  if (stages !== undefined) {
    if (stages === null || (Array.isArray(stages) && stages.length === 0)) {
      stagesData = Prisma.DbNull
    } else {
      const v = validateStages(stages)
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
      stagesData = v.stages as unknown as Prisma.InputJsonValue
    }
  }

  // The method is validated by the lib; the one rule a chef can trip is a wait on
  // the last step, and the message says what to do. null / [] clears it.
  let methodData: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined
  if (method !== undefined) {
    const v = validateMethod(method)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    methodData = v.method.length ? (v.method as unknown as Prisma.InputJsonValue) : Prisma.DbNull
  }

  // Line settings live on the prep task row (par / shelf life / stations) — the
  // recipe editor is their only writer. Each key is optional; the row is
  // matched by linkedRecipeId so a PREP recipe without a row is a no-op.
  let prepData: { parLevel?: number; shelfLifeDays?: number | null; stations?: string[] } | undefined
  if (prep !== undefined) {
    if (!prep || typeof prep !== 'object') return NextResponse.json({ error: 'prep must be an object' }, { status: 400 })
    prepData = {}
    if (prep.parLevel !== undefined) {
      const n = Number(prep.parLevel)
      if (!Number.isFinite(n) || n < 0) return NextResponse.json({ error: 'prep.parLevel must be a number ≥ 0' }, { status: 400 })
      prepData.parLevel = n
    }
    if (prep.shelfLifeDays !== undefined) {
      const n = numOrNull(prep.shelfLifeDays)
      if (n != null && n < 0) return NextResponse.json({ error: 'prep.shelfLifeDays must be ≥ 0' }, { status: 400 })
      prepData.shelfLifeDays = n
    }
    if (prep.stations !== undefined) {
      if (!Array.isArray(prep.stations) || !prep.stations.every((s: unknown) => typeof s === 'string')) {
        return NextResponse.json({ error: 'prep.stations must be a list of station names' }, { status: 400 })
      }
      prepData.stations = [...new Set((prep.stations as string[]).map(s => s.trim()).filter(Boolean))]
    }
  }

  await prisma.recipe.update({
    where: { id: params.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(baseYieldQty !== undefined ? { baseYieldQty: parseFloat(baseYieldQty) } : {}),
      ...(canonYield !== undefined ? { yieldUnit: canonYield } : {}),
      ...(portionSize !== undefined ? { portionSize: portionSize ? parseFloat(portionSize) : null } : {}),
      ...(canonPortion !== undefined ? { portionUnit: canonPortion } : {}),
      ...(menuPrice !== undefined ? { menuPrice: menuPrice ? parseFloat(menuPrice) : null } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(baseIngredientId !== undefined ? { baseIngredientId: baseIngredientId ?? null } : {}),
      ...(revenueCenterId !== undefined ? { revenueCenterId: revenueCenterId || null } : {}),
      ...(Array.isArray(steps) ? { steps: steps.filter((s: unknown) => typeof s === 'string') } : {}),
      // `0` is meaningful ("no unattended phase") and must survive; '' clears. See numOrNull.
      ...(activeMinutes  !== undefined ? { activeMinutes:  numOrNull(activeMinutes) }  : {}),
      ...(passiveMinutes !== undefined ? { passiveMinutes: numOrNull(passiveMinutes) } : {}),
      ...(passiveNote    !== undefined ? { passiveNote: passiveNote || null } : {}),
      ...(stagesData     !== undefined ? { stages: stagesData } : {}),
      ...(methodData     !== undefined ? { method: methodData } : {}),
    },
  })

  if (prepData && Object.keys(prepData).length) {
    await prisma.prepItem.updateMany({ where: { linkedRecipeId: params.id }, data: prepData })
  }

  // Re-sync the linked item (and dependents) when cost- or name-affecting fields change.
  // name flows to the PREPD item's itemName; yield qty/unit drive cost.
  const costAffecting = baseYieldQty !== undefined || yieldUnit !== undefined || name !== undefined
  if (costAffecting) await resyncPrepRecipe(params.id).catch(e => console.error('[recipe PATCH] resync', e))

  // Keep the PrepItem task-row in step when its source fields change — including
  // isActive, so deactivating/reactivating a recipe flows to its prep task row.
  const prepItemAffecting = name !== undefined || categoryId !== undefined || yieldUnit !== undefined || isActive !== undefined || revenueCenterId !== undefined
  if (prepItemAffecting) await syncPrepItemFromRecipe(params.id).catch(e => console.error('[recipe PATCH] prep-item sync', e))

  const updated = await fetchRecipeWithCost(params.id)
  return NextResponse.json(updated)
}

// Hard delete — cleans up references before removing the row
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id
  try {
    let deactivatedItemId: string | null = null
    await prisma.$transaction(async tx => {
      await tx.recipeIngredient.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null } })
      await tx.saleLineItem.deleteMany({ where: { recipeId: id } })
      // The recipe is being removed — its prep task row is orphaned, so deactivate it
      // (not just unlink) instead of leaving a stale active item on the prep list.
      await tx.prepItem.updateMany({ where: { linkedRecipeId: id }, data: { linkedRecipeId: null, isActive: false } })
      await tx.recipeAlert.deleteMany({ where: { recipeId: id } })
      const recipe = await tx.recipe.findUnique({ where: { id }, select: { inventoryItemId: true } })
      if (recipe?.inventoryItemId) {
        deactivatedItemId = recipe.inventoryItemId
        await tx.inventoryItem.update({ where: { id: recipe.inventoryItemId }, data: { isActive: false } })
      }
      await tx.recipe.delete({ where: { id } })
    })
    // A deleted PREP is no longer a priced ingredient — re-cost any prep that used it.
    if (deactivatedItemId) {
      await propagatePrepCostChanges([deactivatedItemId]).catch(e => console.error('[recipe DELETE] propagate', e))
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/recipes/:id]', err)
    return NextResponse.json({ error: 'Failed to delete recipe' }, { status: 500 })
  }
}
