import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'

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
        const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
        const newPricePerBase = unitsPerPurchase > 0
          ? newPurchasePrice / unitsPerPurchase
          : newPurchasePrice

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
      if (scanItem.action === 'CREATE_NEW' && scanItem.newItemData) {
        const newData = JSON.parse(scanItem.newItemData)
        const created = await tx.inventoryItem.create({
          data: {
            itemName:          newData.itemName || scanItem.rawDescription,
            category:          newData.category || 'UNCATEGORIZED',
            purchaseUnit:      newData.purchaseUnit || scanItem.rawUnit || 'each',
            qtyPerPurchaseUnit: newData.qtyPerPurchaseUnit || 1,
            purchasePrice:     scanItem.newPrice || 0,
            baseUnit:          newData.baseUnit || 'each',
            packSize:          newData.packSize || 1,
            packUOM:           newData.packUOM || 'each',
            conversionFactor:  newData.conversionFactor || 1,
            pricePerBaseUnit:  scanItem.newPrice || 0,
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
