import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { calcPricePerBaseUnit } from '@/lib/utils'

// POST /api/invoices/sessions/[id]/approve
// Applies all approved scan items: updates inventory prices, creates supplier price records,
// creates price alerts and recipe alerts.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}))
  const approvedBy: string = body.approvedBy || 'Manager'

  const session = await prisma.invoiceSession.findUnique({
    where: { id: params.id },
    include: {
      scanItems: {
        include: { matchedItem: true },
      },
    },
  })

  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  if (session.status !== 'REVIEW') {
    return NextResponse.json({ error: 'Session is not in REVIEW state' }, { status: 400 })
  }

  const itemsToProcess = session.scanItems.filter(
    item => item.action !== 'SKIP' && item.action !== 'PENDING'
  )

  const updatedItemIds: string[] = []
  let itemsUpdated = 0
  let newItemsCreated = 0

  await prisma.$transaction(async tx => {
    for (const scanItem of itemsToProcess) {
      // ── UPDATE_PRICE or ADD_SUPPLIER ──────────────────────────────────────
      if (
        (scanItem.action === 'UPDATE_PRICE' || scanItem.action === 'ADD_SUPPLIER') &&
        scanItem.matchedItemId &&
        scanItem.newPrice !== null
      ) {
        const newPurchasePrice = Number(scanItem.newPrice)
        const item = scanItem.matchedItem!
        // Use the same formula as the inventory PUT handler — includes getUnitConv(packUOM)
        // so that volumetric/weight items (L, kg) aren't inflated 1000× vs each-based items.
        const newPricePerBase = calcPricePerBaseUnit(
          newPurchasePrice,
          Number(item.qtyPerPurchaseUnit),
          Number(item.packSize),
          item.packUOM,
        )

        // Update inventory item price
        await tx.inventoryItem.update({
          where: { id: scanItem.matchedItemId },
          data: {
            purchasePrice:   newPurchasePrice,
            pricePerBaseUnit: newPricePerBase,
            lastUpdated:     new Date(),
          },
        })
        updatedItemIds.push(scanItem.matchedItemId)
        itemsUpdated++

        // Upsert supplier price record
        if (session.supplierName) {
          const existing = await tx.inventorySupplierPrice.findFirst({
            where: {
              inventoryItemId: scanItem.matchedItemId,
              supplierName: session.supplierName,
            },
          })
          if (existing) {
            await tx.inventorySupplierPrice.update({
              where: { id: existing.id },
              data: { lastPrice: newPurchasePrice, pricePerBaseUnit: newPricePerBase, lastUpdated: new Date() },
            })
          } else {
            await tx.inventorySupplierPrice.create({
              data: {
                inventoryItemId: scanItem.matchedItemId,
                supplierName: session.supplierName,
                supplierId: session.supplierId || null,
                lastPrice: newPurchasePrice,
                pricePerBaseUnit: newPricePerBase,
                isPrimary: false,
              },
            })
          }
        }

        // Create price alert if change ≥ 15%
        const prevPrice = Number(scanItem.previousPrice)
        if (prevPrice > 0 && scanItem.priceDiffPct !== null) {
          const changePct = Number(scanItem.priceDiffPct)
          if (Math.abs(changePct) >= 15) {
            await tx.priceAlert.create({
              data: {
                sessionId:       params.id,
                inventoryItemId: scanItem.matchedItemId,
                previousPrice:   prevPrice,
                newPrice:        newPurchasePrice,
                changePct,
                direction:       changePct > 0 ? 'UP' : 'DOWN',
              },
            })
          }
        }
      }

      // ── CREATE_NEW ────────────────────────────────────────────────────────
      if (scanItem.action === 'CREATE_NEW') {
        const newData = scanItem.newItemData ? JSON.parse(scanItem.newItemData) : {}
        const created = await tx.inventoryItem.create({
          data: {
            itemName:          newData.itemName || scanItem.rawDescription,
            category:          newData.category || 'DRY',
            purchaseUnit:      newData.purchaseUnit || scanItem.rawUnit || 'each',
            qtyPerPurchaseUnit: Number(newData.qtyPerPurchaseUnit) || 1,
            purchasePrice:     Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0,
            baseUnit:          newData.baseUnit || newData.packUOM || 'each',
            packSize:          Number(newData.packSize) || 1,
            packUOM:           newData.packUOM || 'each',
            conversionFactor:  Number(newData.conversionFactor) || 1,
            pricePerBaseUnit:  Number(newData.pricePerBaseUnit) || Number(scanItem.newPrice) || 0,
            supplierId:        session.supplierId || null,
          },
        })
        // Link scan item to the new inventory item
        await tx.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { matchedItemId: created.id, approved: true },
        })
        newItemsCreated++
      }

      // Mark scan item as approved
      await tx.invoiceScanItem.update({
        where: { id: scanItem.id },
        data: { approved: true },
      })
    }

    // Mark session as APPROVED
    await tx.invoiceSession.update({
      where: { id: params.id },
      data: { status: 'APPROVED', approvedBy, approvedAt: new Date() },
    })
  })

  // Save learned match rules (outside transaction — non-critical)
  for (const scanItem of itemsToProcess) {
    if (scanItem.matchedItemId && scanItem.action !== 'SKIP') {
      await saveMatchRule(
        scanItem.rawDescription,
        scanItem.matchedItemId,
        session.supplierName,
        scanItem.invoicePackQty ? {
          packQty: Number(scanItem.invoicePackQty),
          packSize: Number(scanItem.invoicePackSize),
          packUOM: scanItem.invoicePackUOM ?? 'each',
        } : undefined
      ).catch(() => {}) // ignore errors — learning is best-effort
    }
  }

  // Recalculate recipe costs for changed items (outside transaction)
  if (updatedItemIds.length > 0) {
    await recalculateRecipeCosts(updatedItemIds, params.id)
  }

  // Count alerts generated
  const priceAlerts = await prisma.priceAlert.count({ where: { sessionId: params.id } })
  const recipeAlerts = await prisma.recipeAlert.count({ where: { sessionId: params.id } })

  return NextResponse.json({
    ok: true,
    itemsUpdated,
    newItemsCreated,
    priceAlerts,
    recipeAlerts,
  })
}
