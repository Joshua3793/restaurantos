import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { calcPricePerBaseUnit } from '@/lib/utils'
import { requireSession, AuthError } from '@/lib/auth'

const WEIGHT_VOL_SET = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
const isWeightVol = (uom: string | null | undefined) => !!uom && WEIGHT_VOL_SET.has(uom.toLowerCase())

// POST /api/invoices/sessions/[id]/approve
// Applies all approved scan items: updates inventory prices, creates supplier price records,
// creates price alerts and recipe alerts.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let currentUser
  try { currentUser = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const body = await req.json().catch(() => ({}))
  const approvedBy: string = currentUser.name ?? currentUser.email

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

        // For weight/vol items: use invoice pack format (the actual size purchased) so
        // pricePerBaseUnit reflects the real $/g or $/ml. Also update the inventory pack
        // format to stay consistent with the new purchasePrice.
        const useInvoicePack = isWeightVol(scanItem.invoicePackUOM) && scanItem.invoicePackSize !== null
        const packQty  = useInvoicePack ? (Number(scanItem.invoicePackQty) || 1) : Number(item.qtyPerPurchaseUnit)
        const packSize = useInvoicePack ? Number(scanItem.invoicePackSize)        : Number(item.packSize)
        const packUOM  = useInvoicePack ? scanItem.invoicePackUOM!                : item.packUOM

        const newPricePerBase = calcPricePerBaseUnit(newPurchasePrice, packQty, packSize, packUOM)

        // Update inventory item price (and pack format for weight/vol so purchasePrice stays consistent)
        await tx.inventoryItem.update({
          where: { id: scanItem.matchedItemId },
          data: {
            purchasePrice:    newPurchasePrice,
            pricePerBaseUnit: newPricePerBase,
            lastUpdated:      new Date(),
            ...(useInvoicePack ? { qtyPerPurchaseUnit: packQty, packSize, packUOM } : {}),
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

  // ── Clone session generation ──────────────────────────────────────────
  // Only generate clones when the session has RC attribution
  if (session.revenueCenterId) {
    const sessionRcId = session.revenueCenterId

    // Group items by their effective RC, excluding items that belong to the session's own RC
    const itemsByRc = new Map<string, typeof session.scanItems>()
    for (const item of session.scanItems) {
      const effectiveRcId = item.revenueCenterId ?? sessionRcId
      if (effectiveRcId === sessionRcId) continue  // belongs to session RC — no clone
      if (!itemsByRc.has(effectiveRcId)) itemsByRc.set(effectiveRcId, [])
      itemsByRc.get(effectiveRcId)!.push(item)
    }

    for (const [rcId, rcItems] of itemsByRc) {
      const clone = await prisma.invoiceSession.create({
        data: {
          status:         'APPROVED',
          supplierName:   session.supplierName,
          supplierId:     session.supplierId,
          invoiceDate:    session.invoiceDate,
          invoiceNumber:  session.invoiceNumber ? `${session.invoiceNumber} (copy)` : null,
          revenueCenterId: rcId,
          parentSessionId: params.id,
          approvedBy,
          approvedAt:     new Date(),
        },
      })

      await prisma.invoiceScanItem.createMany({
        data: rcItems.map(item => ({
          sessionId:       clone.id,
          rawDescription:  item.rawDescription,
          rawQty:          item.rawQty,
          rawUnit:         item.rawUnit,
          rawUnitPrice:    item.rawUnitPrice,
          rawLineTotal:    item.rawLineTotal,
          matchedItemId:   item.matchedItemId,
          matchConfidence: item.matchConfidence,
          matchScore:      item.matchScore,
          action:          item.action,
          approved:        true,
          newPrice:        item.newPrice,
          previousPrice:   item.previousPrice,
          priceDiffPct:    item.priceDiffPct,
          revenueCenterId: rcId,
          sortOrder:       item.sortOrder,
        })),
      })
    }
  }

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
