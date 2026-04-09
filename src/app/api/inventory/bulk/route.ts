import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const { ids, action, value } = await req.json()

  switch (action) {
    case 'activate':
      await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { isActive: true } })
      break
    case 'deactivate':
      await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { isActive: false } })
      break
    case 'setSupplier':
      await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { supplierId: value } })
      break
    case 'setStorageArea':
      await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { storageAreaId: value } })
      break
    case 'setCategory':
      await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { category: value } })
      break
    case 'delete':
      await prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } })
      break
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  return NextResponse.json({ success: true, affected: ids.length })
}
