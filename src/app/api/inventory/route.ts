import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calcPricePerBaseUnit, calcConversionFactor, deriveBaseUnit } from '@/lib/utils'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const search = searchParams.get('search') || ''
  const category = searchParams.get('category') || ''
  const supplierId = searchParams.get('supplierId') || ''
  const storageAreaId = searchParams.get('storageAreaId') || ''
  const isActive = searchParams.get('isActive')

  const items = await prisma.inventoryItem.findMany({
    where: {
      AND: [
        search ? { itemName: { contains: search } } : {},
        category ? { category } : {},
        supplierId ? { supplierId } : {},
        storageAreaId ? { storageAreaId } : {},
        isActive !== null && isActive !== '' ? { isActive: isActive === 'true' } : {},
      ],
    },
    include: { supplier: true, storageArea: true },
    orderBy: { itemName: 'asc' },
  })
  return NextResponse.json(items)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { purchasePrice, qtyPerPurchaseUnit, packSize, packUOM, countUOM, supplierId, storageAreaId, ...rest } = body
  const pp  = parseFloat(purchasePrice)
  const qty = parseFloat(qtyPerPurchaseUnit)
  const ps  = parseFloat(packSize  ?? '1')
  const pu  = packUOM  ?? 'each'
  const cu  = countUOM ?? 'each'
  const pricePerBaseUnit = calcPricePerBaseUnit(pp, qty, ps, pu)
  const conversionFactor = calcConversionFactor(cu, qty, ps, pu)
  const baseUnit         = deriveBaseUnit(pu)
  const item = await prisma.inventoryItem.create({
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
      supplierId: supplierId || null,
      storageAreaId: storageAreaId || null,
    },
    include: { supplier: true, storageArea: true },
  })
  return NextResponse.json(item, { status: 201 })
}
