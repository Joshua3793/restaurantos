import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { deriveBaseUnit, QTY_UOMS, canonicalUom } from '@/lib/utils'
import { formToChain } from '@/lib/item-model-form'
import {
  DIMENSION_BASE, validateChainItem, withPpb, type ChainItem,
} from '@/lib/item-model'
import { assertKnownUnit, UnitError, purchaseUnitToken } from '@/lib/uom'
import { syncPrepToInventory, propagatePrepCostChanges } from '@/lib/recipeCosts'
import { resolveCountUom } from '@/lib/count-uom'

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

  // ── New chain-form body ──────────────────────────────────────────────────
  // When `packChain` is present the chain columns are authoritative; derive the
  // legacy fields from them (dual-write) and leave the unread legacy pack columns
  // (qtyUOM/packSize/packUOM/innerQty/qtyPerPurchaseUnit) untouched.
  if (body.packChain) {
    const {
      dimension, packChain, pricing, countUnit, supplierId, storageAreaId,
      supplier, storageArea, invoiceLineItems, recipeIngredients, recipe,
      ...rest
    } = body
    delete rest.purchasePrice; delete rest.qtyPerPurchaseUnit; delete rest.packSize
    delete rest.packUOM; delete rest.countUOM; delete rest.qtyUOM; delete rest.innerQty
    delete rest.priceType; delete rest.conversionFactor; delete rest.pricePerBaseUnit
    delete rest.baseUnit; delete rest.dimension; delete rest.pricing; delete rest.countUnit
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
        countUOM: countUnit,
        priceType: pricing.mode === 'RATE' ? 'UOM' : 'CASE',
        purchaseUnit: packChain[0]?.unit ?? 'each',
        purchasePrice: pricing.mode === 'PACK' ? pricing.purchasePrice : pricing.rate,
        needsReview: false,
        lastUpdated: new Date(),
        supplierId: supplierId || null,
        storageAreaId: storageAreaId || null,
      },
    })

    return await postUpdate(params.id, before.allergens ?? [], (rest as any).allergens)
  }

  const {
    purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM,
    qtyUOM, innerQty, needsReview, priceType,
    supplierId, storageAreaId,
    // strip relation objects — never written directly
    supplier, storageArea, invoiceLineItems, recipeIngredients, recipe,
    ...rest
  } = body

  // Canonicalize so spelling variants (L, KG, Litre…) resolve to the shared
  // QTY_UOMS tokens; reject anything outside the canonical set.
  const canonQtyUom = qtyUOM ? canonicalUom(qtyUOM) : undefined
  if (canonQtyUom && !(QTY_UOMS as readonly string[]).includes(canonQtyUom)) {
    return NextResponse.json({ error: `Invalid qtyUOM: ${qtyUOM}` }, { status: 400 })
  }
  if (innerQty !== null && innerQty !== undefined && Number(innerQty) <= 0) {
    return NextResponse.json({ error: 'innerQty must be > 0' }, { status: 400 })
  }

  // Capture previous allergens and priceType before update to detect changes
  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { allergens: true, priceType: true },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const pp    = parseFloat(purchasePrice)  || 0
  const qty   = parseFloat(qtyPerPurchaseUnit) || 1
  const rawPs = parseFloat(packSize)  // NaN when blank
  const hasWeightPerEach = rawPs > 0
  const ps    = hasWeightPerEach ? rawPs : 1  // default 1 for price math (avoid ÷0)
  // When no weight-per-each was entered, normalize packUOM to 'each' so the data
  // is unambiguous downstream (buildPurchaseDescription, getCountableUoms, etc.).
  // Validate packUOM against the UOM backbone (qtyUOM already validated above).
  let pu: string
  try { pu = assertKnownUnit(hasWeightPerEach ? (packUOM ?? 'each') : 'each', 'packUOM') }
  catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  // Normalize + validate purchaseUnit to a canonical token so the spine always
  // stores a known token (never a display string).
  let purchaseUnitTok: string
  try { purchaseUnitTok = assertKnownUnit(purchaseUnitToken(rest.purchaseUnit ?? 'each'), 'purchaseUnit') }
  catch (e) { if (e instanceof UnitError) return NextResponse.json({ error: e.message }, { status: 400 }); throw e }
  const qu    = canonQtyUom ?? 'each'
  const iq    = innerQty != null ? Number(innerQty) : null
  const existingPriceType = (before?.priceType === 'UOM' ? 'UOM' : 'CASE') as 'CASE' | 'UOM'
  const pt: 'CASE' | 'UOM' = priceType === 'UOM' ? 'UOM' : priceType === 'CASE' ? 'CASE' : existingPriceType

  // Derive the canonical base unit for the legacy column (chain carries pricing).
  const baseUnit         = deriveBaseUnit(qu, pu, hasWeightPerEach ? rawPs : 0)
  // Non-stocked (recipe-only) items carry no inventory value — pricing chain reflects 0.
  const isStocked = rest.isStocked !== false
  // Build the chain first, then derive the count UOM FROM the chain: keep an
  // explicit, still-valid choice (switchable per item) but never let it sit at a
  // stale/invalid value — fall back to the chain's resolved unit.
  const requestedCountUom = hasWeightPerEach ? (countUOM ?? 'each') : 'each'
  const chain = formToChain({
    purchaseUnit: purchaseUnitTok, purchasePrice: isStocked ? pp : 0,
    qtyPerPurchaseUnit: qty, qtyUOM: qu, innerQty: iq, packSize: ps, packUOM: pu,
    priceType: pt, countUOM: requestedCountUom,
  })
  const cu = resolveCountUom({
    dimension: chain.dimension, baseUnit: chain.baseUnit,
    packChain: chain.packChain, countUnit: requestedCountUom,
  })
  chain.countUnit = cu

  await prisma.inventoryItem.update({
    where: { id: params.id },
    data: {
      ...rest,
      purchaseUnit: purchaseUnitTok,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
      qtyUOM: qu,
      innerQty: iq,
      priceType: pt,
      needsReview: false,
      baseUnit,
      dimension: chain.dimension,
      packChain: chain.packChain as any,
      pricing: chain.pricing as any,
      countUnit: chain.countUnit,
      isStocked,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
  })

  return await postUpdate(params.id, before?.allergens ?? [], rest.allergens)
}

/**
 * Shared post-update side-effects for the inventory PUT route. After any spine
 * write (legacy form OR chain form) we must: re-sync the item's own PREP recipe,
 * propagate the price change to dependent PREP recipes, cascade allergen changes,
 * and return the final (possibly recipe-overridden) state.
 */
async function postUpdate(
  id: string,
  prevAllergens: string[],
  newAllergensInput: string[] | undefined,
): Promise<NextResponse> {
  // If this item is the output of a PREP recipe, re-sync to override the
  // purchase-formula values with recipe-derived costs (preserves countUOM).
  const linkedRecipe = await prisma.recipe.findFirst({
    where: { inventoryItemId: id, type: 'PREP' },
    select: { id: true },
  })
  if (linkedRecipe) {
    await syncPrepToInventory(linkedRecipe.id)
  }

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
