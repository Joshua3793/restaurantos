import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit, QTY_UOMS, canonicalUom } from '@/lib/utils'
import { syncPrepToInventory } from '@/lib/recipeCosts'
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
  return NextResponse.json(item)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
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
  // is unambiguous downstream (buildPurchaseDescription, getCountableUoms, etc.)
  const pu    = hasWeightPerEach ? (packUOM ?? 'each') : 'each'
  const qu    = canonQtyUom ?? 'each'
  const iq    = innerQty != null ? Number(innerQty) : null
  // Count UOM derives from the purchase format: keep an explicit, still-valid
  // choice (switchable per item) but never let it sit at a stale/invalid value —
  // fall back to the derived primary so count sessions read the right unit.
  const cu    = resolveCountUom({
    baseUnit:           '',                 // unused by the derivation
    purchaseUnit:       rest.purchaseUnit ?? 'each',
    qtyPerPurchaseUnit: qty,
    qtyUOM:             qu,
    innerQty:           iq,
    packSize:           ps,
    packUOM:            pu,
    countUOM:           hasWeightPerEach ? (countUOM ?? 'each') : 'each',
  })
  const existingPriceType = (before?.priceType === 'UOM' ? 'UOM' : 'CASE') as 'CASE' | 'UOM'
  const pt: 'CASE' | 'UOM' = priceType === 'UOM' ? 'UOM' : priceType === 'CASE' ? 'CASE' : existingPriceType

  // Save using standard purchase formula first
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, qu, iq, ps, pu, pt)
  const conversionFactor = calcConversionFactor(cu, qty, qu, iq, ps, pu)
  const baseUnit         = deriveBaseUnit(qu, pu, hasWeightPerEach ? rawPs : 0)

  await prisma.inventoryItem.update({
    where: { id: params.id },
    data: {
      ...rest,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
      qtyUOM: qu,
      innerQty: iq,
      priceType: pt,
      needsReview: false,
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
  })

  // If this item is the output of a PREP recipe, re-sync to override the
  // purchase-formula values with recipe-derived costs (preserves countUOM).
  const linkedRecipe = await prisma.recipe.findFirst({
    where: { inventoryItemId: params.id, type: 'PREP' },
    select: { id: true },
  })
  if (linkedRecipe) {
    await syncPrepToInventory(linkedRecipe.id)
  }

  // If allergens changed, cascade-sync every PREP recipe that uses this item
  // as an ingredient so their linked PREPD items stay up to date.
  const newAllergens: string[] = rest.allergens ?? before?.allergens ?? []
  const allergensChanged =
    JSON.stringify([...(before?.allergens ?? [])].sort()) !==
    JSON.stringify([...newAllergens].sort())

  if (allergensChanged) {
    const affectedRecipes = await prisma.recipe.findMany({
      where: {
        type: 'PREP',
        inventoryItemId: { not: null },
        ingredients: { some: { inventoryItemId: params.id } },
      },
      select: { id: true },
    })
    await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
  }

  // Return the final state (may have been updated by recipe sync)
  const updated = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(updated)
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
