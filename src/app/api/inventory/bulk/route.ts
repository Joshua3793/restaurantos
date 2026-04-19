import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPrepToInventory } from '@/lib/recipeCosts'

export async function POST(req: NextRequest) {
  try {
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
      case 'assignAllergens': {
        const { allergens: newAllergens, mode } = value as { allergens: string[]; mode: 'add' | 'replace' }
        if (mode === 'replace') {
          await prisma.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { allergens: newAllergens } })
        } else {
          const items = await prisma.inventoryItem.findMany({
            where: { id: { in: ids } },
            select: { id: true, allergens: true },
          })
          await Promise.all(items.map(item => {
            const merged = Array.from(new Set([...item.allergens, ...newAllergens]))
            return prisma.inventoryItem.update({ where: { id: item.id }, data: { allergens: merged } })
          }))
        }
        const affectedRecipes = await prisma.recipe.findMany({
          where: {
            type: 'PREP',
            inventoryItemId: { not: null },
            ingredients: { some: { inventoryItemId: { in: ids } } },
          },
          select: { id: true },
        })
        await Promise.all(affectedRecipes.map(r => syncPrepToInventory(r.id)))
        break
      }
      case 'delete':
        await prisma.$transaction([
          prisma.recipeIngredient.updateMany({
            where: { inventoryItemId: { in: ids } },
            data:  { inventoryItemId: null },
          }),
          prisma.recipe.updateMany({
            where: { inventoryItemId: { in: ids } },
            data:  { inventoryItemId: null },
          }),
          prisma.invoiceScanItem.updateMany({
            where: { matchedItemId: { in: ids } },
            data:  { matchedItemId: null },
          }),
          prisma.invoiceLineItem.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.countLine.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.inventorySnapshot.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.wastageLog.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.priceAlert.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.invoiceMatchRule.deleteMany({ where: { inventoryItemId: { in: ids } } }),
          prisma.inventoryItem.deleteMany({ where: { id: { in: ids } } }),
        ])
        break
      default:
        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }

    return NextResponse.json({ success: true, affected: ids.length })
  } catch (err) {
    console.error('[bulk] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
