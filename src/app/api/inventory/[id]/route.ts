import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    include: { supplier: true, storageArea: true, invoiceLineItems: { include: { invoice: true } }, recipeIngredients: { include: { recipe: true } } },
  })
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(item)
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, supplierId, storageAreaId, supplier, storageArea, invoiceLineItems, recipeIngredients, ...rest } = body
  const pp  = parseFloat(purchasePrice)
  const qty = parseFloat(qtyPerPurchaseUnit)
  const ps  = parseFloat(packSize  ?? '1')
  const pu  = packUOM  ?? 'each'
  const cu  = countUOM ?? 'each'
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, ps, pu)
  const conversionFactor = calcConversionFactor(cu, qty, ps, pu)
  const baseUnit         = deriveBaseUnit(pu)
  const item = await prisma.inventoryItem.update({
    where: { id: params.id },
    data: {
      ...rest,
      purchasePrice: pp,
      qtyPerPurchaseUnit: qty,
      packSize: ps,
      packUOM: pu,
      countUOM: cu,
      conversionFactor,
      pricePerBaseUnit,
      baseUnit,
      lastUpdated: new Date(),
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(item)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.inventoryItem.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
