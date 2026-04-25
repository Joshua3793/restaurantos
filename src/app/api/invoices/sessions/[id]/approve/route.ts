import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { calcPricePerBaseUnit } from '@/lib/utils'
import { requireSession, AuthError } from '@/lib/auth'

const WEIGHT_VOL_SET = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
const isWeightVol = (uom: string | null | undefined) => !!uom && WEIGHT_VOL_SET.has(uom.toLowerCase())

async function doApprove(
  sessionId: string,
  approvedBy: string,
  session: { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; qtyPerPurchaseUnit: any; packSize: any; packUOM: string | null } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; revenueCenterId: string | null; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any }> }
): Promise<void> {
  try {
    const itemsToProcess = session.scanItems.filter(
      item => item.action !== 'SKIP' && item.action !== 'PENDING'
    )

    const updatedItemIds: string[] = []

    // Run all item updates in parallel
    await Promise.all(itemsToProcess.map(async (scanItem) => {
      // ── UPDATE_PRICE or ADD_SUPPLIER ────────────────────────────────────
      if (
        (scanItem.action === 'UPDATE_PRICE' || scanItem.action === 'ADD_SUPPLIER') &&
        scanItem.matchedItemId &&
        scanItem.newPrice !== null
      ) {
        const newPurchasePrice = Number(scanItem.newPrice)
        const item = scanItem.matchedItem!

        const useInvoicePack = isWeightVol(scanItem.invoicePackUOM) && scanItem.invoicePackSize !== null
        const packQty  = useInvoicePack ? (Number(scanItem.invoicePackQty) || 1) : Number(item.qtyPerPurchaseUnit)
        const packSize = useInvoicePack ? Number(scanItem.invoicePackSize)        : Number(item.packSize)
        const packUOM  = useInvoicePack ? scanItem.invoicePackUOM!                : (item.packUOM ?? 'each')

        const newPricePerBase = calcPricePerBaseUnit(newPurchasePrice, packQty, packSize, packUOM)

        await prisma.inventoryItem.update({
          where: { id: scanItem.matchedItemId },
          data: {
            purchasePrice:    newPurchasePrice,
            pricePerBaseUnit: newPricePerBase,
            lastUpdated:      new Date(),
            ...(useInvoicePack ? { qtyPerPurchaseUnit: packQty, packSize, packUOM } : {}),
          },
        })
        updatedItemIds.push(scanItem.matchedItemId)

        // Upsert supplier price record
        if (session.supplierName) {
          const existing = await prisma.inventorySupplierPrice.findFirst({
            where: {
              inventoryItemId: scanItem.matchedItemId,
              supplierName: session.supplierName,
            },
          })
          if (existing) {
            await prisma.inventorySupplierPrice.update({
              where: { id: existing.id },
              data: { lastPrice: newPurchasePrice, pricePerBaseUnit: newPricePerBase, lastUpdated: new Date() },
            })
          } else {
            await prisma.inventorySupplierPrice.create({
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
            await prisma.priceAlert.create({
              data: {
                sessionId,
                inventoryItemId: scanItem.matchedItemId,
                previousPrice:   prevPrice,
                newPrice:        newPurchasePrice,
                changePct,
                direction:       changePct > 0 ? 'UP' : 'DOWN',
              },
            })
          }
        }

        // Mark scan item approved
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { approved: true },
        })
      }

      // ── CREATE_NEW ──────────────────────────────────────────────────────
      if (scanItem.action === 'CREATE_NEW') {
        const newData = scanItem.newItemData ? JSON.parse(scanItem.newItemData) : {}
        const created = await prisma.inventoryItem.create({
          data: {
            itemName:           newData.itemName || scanItem.rawDescription,
            category:           newData.category || 'DRY',
            purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
            qtyPerPurchaseUnit: Number(newData.qtyPerPurchaseUnit) || 1,
            purchasePrice:      Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0,
            baseUnit:           newData.baseUnit || newData.packUOM || 'each',
            packSize:           Number(newData.packSize) || 1,
            packUOM:            newData.packUOM || 'each',
            conversionFactor:   Number(newData.conversionFactor) || 1,
            pricePerBaseUnit:   Number(newData.pricePerBaseUnit) || Number(scanItem.newPrice) || 0,
            supplierId:         session.supplierId || null,
          },
        })
        // Link scan item to the new inventory item
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { matchedItemId: created.id, approved: true },
        })
      }

      // ── Non-CREATE_NEW: mark scan item approved (UPDATE_PRICE / ADD_SUPPLIER already done above)
      if (scanItem.action !== 'CREATE_NEW' &&
          scanItem.action !== 'UPDATE_PRICE' &&
          scanItem.action !== 'ADD_SUPPLIER') {
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { approved: true },
        })
      }
    }))

    // Mark session as APPROVED
    await prisma.invoiceSession.update({
      where: { id: sessionId },
      data: { status: 'APPROVED', approvedBy, approvedAt: new Date() },
    })

    // ── Clone session per RC ────────────────────────────────────────────
    if (session.revenueCenterId) {
      const sessionRcId = session.revenueCenterId
      const itemsByRc = new Map<string, typeof session.scanItems>()
      for (const item of session.scanItems) {
        const effectiveRcId = item.revenueCenterId ?? sessionRcId
        if (effectiveRcId === sessionRcId) continue
        if (!itemsByRc.has(effectiveRcId)) itemsByRc.set(effectiveRcId, [])
        itemsByRc.get(effectiveRcId)!.push(item)
      }

      for (const [rcId, rcItems] of itemsByRc) {
        const clone = await prisma.invoiceSession.create({
          data: {
            status:          'APPROVED',
            supplierName:    session.supplierName,
            supplierId:      session.supplierId,
            invoiceDate:     session.invoiceDate,
            invoiceNumber:   session.invoiceNumber ? `${session.invoiceNumber} (copy)` : null,
            revenueCenterId: rcId,
            parentSessionId: sessionId,
            approvedBy,
            approvedAt:      new Date(),
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

    // ── Save learned match rules (parallel, non-critical) ───────────────
    await Promise.all(
      itemsToProcess
        .filter(item => item.matchedItemId && item.action !== 'SKIP')
        .map(item =>
          saveMatchRule(
            item.rawDescription,
            item.matchedItemId!,
            session.supplierName,
            item.invoicePackQty ? {
              packQty:  Number(item.invoicePackQty),
              packSize: Number(item.invoicePackSize),
              packUOM:  item.invoicePackUOM ?? 'each',
            } : undefined
          ).catch(() => {})
        )
    )

    // ── Recalculate recipe costs for changed items ──────────────────────
    if (updatedItemIds.length > 0) {
      await recalculateRecipeCosts(updatedItemIds, sessionId)
    }
  } catch (err) {
    await prisma.invoiceSession.update({
      where: { id: sessionId },
      data: { status: 'REVIEW', errorMessage: String(err).slice(0, 500) },
    })
  }
}

// POST /api/invoices/sessions/[id]/approve
// Sets session to APPROVING immediately and runs heavy work in the background.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let currentUser
  try { currentUser = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

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

  // Set APPROVING synchronously so the client knows work has started
  await prisma.invoiceSession.update({
    where: { id: params.id },
    data: { status: 'APPROVING' },
  })

  // NOTE: fire-and-forget in serverless. On Vercel, the Node process is kept
  // alive until microtasks drain after the response is sent — background work
  // completes for normal invoice sizes. Long invoices should use a queue.
  doApprove(params.id, approvedBy, session).catch(() => {})

  return NextResponse.json({ ok: true, queued: true })
}
