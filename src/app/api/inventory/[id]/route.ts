import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'
import { syncPrepToInventory } from '@/lib/recipeCosts'

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

  const validQtyUoms = ['each', 'pack', 'kg', 'g', 'lb', 'oz', 'l', 'ml']
  if (qtyUOM && !validQtyUoms.includes(qtyUOM)) {
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
  const cu    = hasWeightPerEach ? (countUOM ?? 'each') : 'each'
  const qu    = qtyUOM ?? 'each'
  const iq    = innerQty != null ? Number(innerQty) : null
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
  await prisma.inventoryItem.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
