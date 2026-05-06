import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { calcPricePerBaseUnit, getUnitConv } from '@/lib/utils'
import { requireSession, AuthError } from '@/lib/auth'

// Allow up to 60s on Vercel so fire-and-forget work completes before the process exits
export const maxDuration = 60

const WEIGHT_VOL_SET = new Set(['kg', 'g', 'lb', 'oz', 'l', 'ml'])
const isWeightVol = (uom: string | null | undefined) => !!uom && WEIGHT_VOL_SET.has(uom.toLowerCase())

async function doApprove(
  sessionId: string,
  approvedBy: string,
  session: { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; qtyPerPurchaseUnit: any; qtyUOM: string | null; innerQty: any; packSize: any; packUOM: string | null } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; totalQty: any; totalQtyUOM: string | null; rawPriceType: 'CASE' | 'PKG' | 'UOM' | null; revenueCenterId: string | null; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any }> }
): Promise<void> {
  try {
    const itemsToProcess = session.scanItems.filter(
      item => item.action !== 'SKIP' && item.action !== 'PENDING'
    )

    const updatedItemIds: string[] = []

    // Process items sequentially so each item's writes are fully committed before
    // the next begins — prevents concurrent approvals from interleaving updates
    // to the same inventory item and corrupting pricing data.
    for (const scanItem of itemsToProcess) {
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

        const rawPriceType = scanItem.rawPriceType ?? 'CASE'

        let newPricePerBase: number
        if (rawPriceType === 'UOM') {
          // purchasePrice is a rate (e.g. $9.90/kg) — always use inventory's packUOM as the rate denominator
          const rateUnit = item.packUOM ?? packUOM  // always use inventory's packUOM for rate-based items
          const uomConv = getUnitConv(rateUnit)
          newPricePerBase = uomConv > 0 ? newPurchasePrice / uomConv : 0
        } else {
          // CASE and PKG both go through the same path (PKG newPrice is already per-case after drawer normalization)
          if (scanItem.totalQty !== null && scanItem.totalQty !== undefined && Number(scanItem.totalQty) > 0) {
            const tqUOM = scanItem.totalQtyUOM ?? packUOM
            const conv  = getUnitConv(tqUOM)
            newPricePerBase = conv > 0 ? newPurchasePrice / (Number(scanItem.totalQty) * conv) : 0
          } else {
            const iqNum = item.innerQty != null ? Number(item.innerQty) : null
            newPricePerBase = calcPricePerBaseUnit(
              newPurchasePrice,
              packQty,
              useInvoicePack ? 'each' : (item.qtyUOM ?? 'each'),
              useInvoicePack ? null : iqNum,
              packSize,
              packUOM,
            )
          }
        }

        // Wrap all writes for this item in a transaction so a mid-item failure
        // doesn't leave inventory updated but the scan item un-approved.
        const prevPrice = Number(scanItem.previousPrice)
        const changePct = scanItem.priceDiffPct !== null ? Number(scanItem.priceDiffPct) : 0

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemOps: any[] = [
          prisma.inventoryItem.update({
            where: { id: scanItem.matchedItemId },
            data: {
              purchasePrice:    newPurchasePrice,
              pricePerBaseUnit: newPricePerBase,
              priceType:        rawPriceType === 'UOM' ? 'UOM' : 'CASE', // PKG is a purchasing exception; stored as CASE
              lastUpdated:      new Date(),
              ...(useInvoicePack ? { qtyPerPurchaseUnit: packQty, packSize, packUOM } : {}),
            },
          }),
          prisma.invoiceScanItem.update({
            where: { id: scanItem.id },
            data: { approved: true },
          }),
        ]

        if (prevPrice > 0 && Math.abs(changePct) >= 15) {
          itemOps.push(
            prisma.priceAlert.create({
              data: {
                sessionId,
                inventoryItemId: scanItem.matchedItemId,
                previousPrice:   prevPrice,
                newPrice:        newPurchasePrice,
                changePct,
                direction:       changePct > 0 ? 'UP' : 'DOWN',
              },
            })
          )
        }

        await prisma.$transaction(itemOps)
        updatedItemIds.push(scanItem.matchedItemId)

        // Upsert supplier price record (non-critical, outside transaction)
        if (session.supplierName) {
          const existing = await prisma.inventorySupplierPrice.findFirst({
            where: { inventoryItemId: scanItem.matchedItemId, supplierName: session.supplierName },
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
                supplierName:    session.supplierName,
                supplierId:      session.supplierId || null,
                lastPrice:       newPurchasePrice,
                pricePerBaseUnit: newPricePerBase,
                isPrimary:       false,
              },
            })
          }
        }
      }

      // ── CREATE_NEW ──────────────────────────────────────────────────────
      if (scanItem.action === 'CREATE_NEW') {
        const newData = scanItem.newItemData ? JSON.parse(scanItem.newItemData) : {}
        const newPurchasePrice = Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0
        const newPackQty  = Number(newData.qtyPerPurchaseUnit) || 1
        const newPackSize = Number(newData.packSize) || 1
        const newPackUOM  = newData.packUOM || 'each'
        const newPriceType: 'CASE' | 'UOM' = newData.priceType === 'UOM' ? 'UOM' : 'CASE'
        const newPricePerBase = Number(newData.pricePerBaseUnit) ||
          calcPricePerBaseUnit(newPurchasePrice, newPackQty, 'each', null, newPackSize, newPackUOM, newPriceType)
        const created = await prisma.inventoryItem.create({
          data: {
            itemName:           newData.itemName || scanItem.rawDescription,
            category:           newData.category || 'DRY',
            purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
            qtyPerPurchaseUnit: newPackQty,
            purchasePrice:      newPurchasePrice,
            baseUnit:           newData.baseUnit || newPackUOM,
            packSize:           newPackSize,
            packUOM:            newPackUOM,
            conversionFactor:   Number(newData.conversionFactor) || 1,
            pricePerBaseUnit:   newPricePerBase,
            priceType:          newPriceType,
            supplierId:         session.supplierId || null,
          },
        })
        updatedItemIds.push(created.id)
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { matchedItemId: created.id, approved: true },
        })
      }

      // ── All other actions: just mark approved ───────────────────────────
      if (scanItem.action !== 'CREATE_NEW' &&
          scanItem.action !== 'UPDATE_PRICE' &&
          scanItem.action !== 'ADD_SUPPLIER') {
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { approved: true },
        })
      }
    }

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doApprove(params.id, approvedBy, session as any).catch(() => {})

  return NextResponse.json({ ok: true, queued: true })
}
