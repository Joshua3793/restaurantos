import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  DIMENSION_BASE, validateChainItem, withPpb, dimensionOf, type ChainItem,
} from '@/lib/item-model'
import { syncPrepToInventory, propagatePrepCostChanges } from '@/lib/recipeCosts'
import { mirrorItemToPrimaryOffer } from '@/lib/primary-offer'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    include: {
      supplier: true,
      storageArea: true,
      invoiceLineItems: { include: { invoice: true } },
      recipeIngredients: { include: { recipe: true } },
      recipe: { select: { id: true, name: true, baseYieldQty: true, yieldUnit: true } },
    },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Populate a computed `pricePerBaseUnit` so the InventoryItemDrawer / recipes
  // PREP modal keep reading it after the legacy column is dropped.
  return NextResponse.json(withPpb(item))
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()

  // The chain columns (dimension/baseUnit/packChain/pricing/countUnit) are the
  // single source of truth. Every edit form sends a chain body — there is no
  // legacy-field update path.
  const {
    dimension, packChain, pricing, countUnit, supplierId, storageAreaId,
    eachMeasureQty, eachMeasureUnit, densityGPerMl,
    supplier, storageArea, invoiceLineItems, recipeIngredients, recipe,
    ...rest
  } = body
  if (!packChain) {
    return NextResponse.json({ error: 'packChain is required' }, { status: 400 })
  }
  delete rest.pricePerBaseUnit; delete rest.baseUnit
  delete rest.dimension; delete rest.pricing; delete rest.countUnit
  delete rest.needsReview

  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { allergens: true },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ci: ChainItem = {
    dimension,
    baseUnit: DIMENSION_BASE[dimension as keyof typeof DIMENSION_BASE],
    packChain,
    pricing,
    countUnit,
  }
  const errors = validateChainItem(ci)
  if (errors.length) return NextResponse.json({ error: errors.join('; ') }, { status: 400 })

  await prisma.inventoryItem.update({
    where: { id: params.id },
    data: {
      ...rest,
      dimension,
      packChain: packChain as any,
      pricing: pricing as any,
      countUnit,
      baseUnit: ci.baseUnit,
      needsReview: false,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
      // Count↔weight bridge ("1 each = N g/ml"). Valid in EITHER direction — a
      // per-each weight on a COUNT item, or how much one each weighs on a
      // measured item — so it is NOT gated on dimension. The unit must be a
      // measured one (the bridge always spans count↔measured).
      eachMeasureQty: Number(eachMeasureQty) > 0 && eachMeasureUnit && dimensionOf(String(eachMeasureUnit)) !== 'COUNT'
        ? Number(eachMeasureQty) : null,
      eachMeasureUnit: Number(eachMeasureQty) > 0 && eachMeasureUnit && dimensionOf(String(eachMeasureUnit)) !== 'COUNT'
        ? String(eachMeasureUnit) : null,
      // Weight↔volume density bridge. Non-destructive: allows a measured invoice
      // in the other dimension to cost correctly without changing the item's
      // dimension, chain, or stock. Written only when a positive value is provided.
      ...(densityGPerMl != null && Number(densityGPerMl) > 0
        ? { densityGPerMl: Number(densityGPerMl) }
        : {}),
    },
  })

  return await postUpdate(params.id, before.allergens ?? [], (rest as any).allergens)
}

/**
 * Shared post-update side-effects for the inventory PUT route. After any spine
 * write we must: re-sync the item's own PREP recipe,
 * propagate the price change to dependent PREP recipes, cascade allergen changes,
 * and return the final (possibly recipe-overridden) state.
 */
async function postUpdate(
  id: string,
  prevAllergens: string[],
  newAllergensInput: string[] | undefined,
): Promise<NextResponse> {
  // If this item is the output of a PREP recipe, re-sync to override the
  // purchase-formula values with recipe-derived costs (preserves count unit).
  const linkedRecipe = await prisma.recipe.findFirst({
    where: { inventoryItemId: id, type: 'PREP' },
    select: { id: true },
  })
  if (linkedRecipe) {
    await syncPrepToInventory(linkedRecipe.id)
  }

  // A manual edit to an item that has supplier offers also updates its PRIMARY
  // offer, so the offer table doesn't silently disagree with the item spine.
  // No-op when the item has no primary offer (PREP-linked / manual-only items).
  await mirrorItemToPrimaryOffer(id)

  // A manual price edit is a spine write: propagate it to every PREP recipe that
  // uses this item (directly or transitively) so their costs don't go stale —
  // same reason the invoice-approve path does. Runs after the own-prep sync above
  // so a prep item's freshly-derived price also propagates to its parents.
  await propagatePrepCostChanges([id])

  // If allergens changed, cascade-sync every PREP recipe that uses this item
  // as an ingredient so their linked PREPD items stay up to date.
  const newAllergens: string[] = newAllergensInput ?? prevAllergens ?? []
  const allergensChanged =
    JSON.stringify([...(prevAllergens ?? [])].sort()) !==
    JSON.stringify([...newAllergens].sort())

  if (allergensChanged) {
    const affectedRecipes = await prisma.recipe.findMany({
      where: {
        type: 'PREP',
        inventoryItemId: { not: null },
        ingredients: { some: { inventoryItemId: id } },
      },
      select: { id: true },
    })
    await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
  }

  // Return the final state (may have been updated by recipe sync)
  const updated = await prisma.inventoryItem.findUnique({
    where: { id },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(updated ? withPpb(updated) : updated)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = params.id

  const item = await prisma.inventoryItem.findUnique({ where: { id }, select: { id: true } })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Block the hard delete when the item carries real usage/history. Deleting it
  // would either violate a FK (Restrict) or destroy costing/financial history that
  // the pricePerBaseUnit spine depends on. Tell the caller to deactivate instead.
  const [
    recipeUses, linkedRecipe, invoiceLines, countLines,
    snapshots, wastageLogs, stockTransfers, prepItems,
  ] = await Promise.all([
    prisma.recipeIngredient.count({ where: { inventoryItemId: id } }),
    prisma.recipe.count({ where: { inventoryItemId: id } }),
    prisma.invoiceLineItem.count({ where: { inventoryItemId: id } }),
    prisma.countLine.count({ where: { inventoryItemId: id } }),
    prisma.inventorySnapshot.count({ where: { inventoryItemId: id } }),
    prisma.wastageLog.count({ where: { inventoryItemId: id } }),
    prisma.stockTransfer.count({ where: { inventoryItemId: id } }),
    prisma.prepItem.count({ where: { linkedInventoryItemId: id } }),
  ])

  const blockers: string[] = []
  if (recipeUses)     blockers.push(`used in ${recipeUses} recipe ingredient${recipeUses > 1 ? 's' : ''}`)
  if (linkedRecipe)   blockers.push(`the output of a prep recipe`)
  if (invoiceLines)   blockers.push(`on ${invoiceLines} invoice line${invoiceLines > 1 ? 's' : ''}`)
  if (countLines)     blockers.push(`in ${countLines} stock count${countLines > 1 ? 's' : ''}`)
  if (snapshots)      blockers.push(`in ${snapshots} count snapshot${snapshots > 1 ? 's' : ''}`)
  if (wastageLogs)    blockers.push(`in ${wastageLogs} wastage log${wastageLogs > 1 ? 's' : ''}`)
  if (stockTransfers) blockers.push(`in ${stockTransfers} stock transfer${stockTransfers > 1 ? 's' : ''}`)
  if (prepItems)      blockers.push(`linked to ${prepItems} prep item${prepItems > 1 ? 's' : ''}`)

  if (blockers.length) {
    return NextResponse.json(
      {
        error: `Can't delete — this item is ${blockers.join(', ')}. Deactivate it instead to hide it without losing history.`,
        blocked: true,
        canDeactivate: true,
      },
      { status: 409 },
    )
  }

  // Truly unreferenced — safe to hard-delete. Clean up the metadata-only relations
  // (match rules / scan matches / price alerts) that would otherwise FK-block it.
  // StockAllocation + InventorySupplierPrice cascade automatically.
  try {
    await prisma.$transaction(async tx => {
      await tx.invoiceMatchRule.deleteMany({ where: { inventoryItemId: id } })
      await tx.priceAlert.deleteMany({ where: { inventoryItemId: id } })
      await tx.invoiceScanItem.updateMany({ where: { matchedItemId: id }, data: { matchedItemId: null } })
      await tx.inventoryItem.delete({ where: { id } })
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[DELETE /api/inventory/:id]', err)
    return NextResponse.json({ error: 'Failed to delete item' }, { status: 500 })
  }
}
