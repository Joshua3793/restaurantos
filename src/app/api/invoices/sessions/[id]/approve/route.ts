import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { canonicalSupplierName } from '@/lib/supplier-offers'
import { calcPricePerBaseUnit, getUnitConv, deriveBaseUnit } from '@/lib/utils'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { formToChain } from '@/lib/item-model-form'
import { requireSession, AuthError } from '@/lib/auth'

// Give background work up to 60s after the response is sent
export const maxDuration = 60


interface ApproveResult {
  itemsUpdated: number
  newItemsCreated: number
  priceAlerts: number
  recipeAlerts: number
  skippedLines: number
}

async function doApprove(
  sessionId: string,
  approvedBy: string,
  session: { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; qtyPerPurchaseUnit: any; qtyUOM: string | null; innerQty: any; packSize: any; packUOM: string | null } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; totalQty: any; totalQtyUOM: string | null; rate: any; rateUOM: string | null; rawPriceType: 'CASE' | 'PKG' | 'UOM' | null; revenueCenterId: string | null; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any; supplierItemCode: string | null; applyInvoiceFormat: boolean }> }
): Promise<ApproveResult> {
  let priceAlertsCreated = 0
  let newItemsCreated = 0
  let skippedLines = 0
  try {
    const itemsToProcess = session.scanItems.filter(
      item => item.action !== 'SKIP' && item.action !== 'PENDING'
    )

    const updatedItemIds: string[] = []

    // (itemId, rcId) pairs to register as RC stock allocations. A line assigned to a
    // non-default RC must make its inventory item appear in that RC's inventory list —
    // which is gated by StockAllocation rows. Collected during the loop, upserted after.
    const allocPairs: Array<{ itemId: string; rcId: string }> = []
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })
    const defaultRcId = defaultRc?.id ?? null
    // The line's effective RC is its own override, else the invoice's active RC.
    // Only non-default RCs need an allocation row (default RC reads global stockOnHand).
    const registerAlloc = (itemId: string | null, lineRcId: string | null) => {
      const rcId = lineRcId ?? session.revenueCenterId
      if (itemId && rcId && rcId !== defaultRcId) allocPairs.push({ itemId, rcId })
    }

    // Offers are keyed by canonical supplier name so OCR name variants
    // ("… Inc." vs "… Inc. - Vancouver") can't split one supplier into two.
    const offerSupplierName = session.supplierName
      ? await canonicalSupplierName(session.supplierId, session.supplierName)
      : null

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
        const item = scanItem.matchedItem!

        // Honor the pricing mode the user resolved in the drawer (persisted as
        // `pricingMode`). Derive the mode exactly as the UI does.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isUomMode = derivePricingMode(scanItem as any) === 'per_weight'
        const rawPriceType: 'CASE' | 'UOM' = isUomMode ? 'UOM' : 'CASE'

        // The price to write comes from the RAW, user-editable fields — NEVER
        // the stored `newPrice`. newPrice is computed once at OCR/match time and
        // saved on the scan item; a session matched by the pre-fix matcher kept
        // an INFLATED newPrice (e.g. $172.79 × 25 = $4,319.75 for Butter), and
        // approving it later still wrote the bad value. rawUnitPrice (per-case
        // printed price) and rate ($/kg) are the reliable source and are exactly
        // what the drawer edits, so user corrections are honored.
        const newPurchasePrice = isUomMode
          ? (scanItem.rate != null ? Number(scanItem.rate) : Number(scanItem.newPrice))
          : (scanItem.rawUnitPrice != null ? Number(scanItem.rawUnitPrice) : Number(scanItem.newPrice))

        // Only overwrite the inventory item's stored pack structure when the
        // user explicitly chose "Use invoice format" in the drawer (sets
        // applyInvoiceFormat). A one-off odd shipment must never silently
        // rewrite the item's standard format.
        const useInvoicePack =
          scanItem.applyInvoiceFormat === true &&
          scanItem.invoicePackSize !== null &&
          scanItem.invoicePackQty !== null
        const packQty  = useInvoicePack ? (Number(scanItem.invoicePackQty) || 1) : Number(item.qtyPerPurchaseUnit)
        const packSize = useInvoicePack ? Number(scanItem.invoicePackSize)        : Number(item.packSize)
        const packUOM  = useInvoicePack ? scanItem.invoicePackUOM!                : (item.packUOM ?? 'each')

        let newPricePerBase: number
        // The RATE's resolved unit (only meaningful in UOM mode) — captured here
        // so the chain `pricing` below can store { mode:'RATE', rate, rateUnit }.
        let resolvedRateUnit = 'kg'
        if (rawPriceType === 'UOM') {
          // newPurchasePrice is a rate ($/kg, $/lb…). Divide by the RATE's OWN
          // unit — the scan line's rateUOM — not the physical pack unit. A
          // catch-weight item packed in pieces has packUOM='each' (conv 1),
          // which left the rate unconverted and inflated cost 1000×.
          const WV = ['g', 'mg', 'kg', 'lb', 'oz', 'ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
          const wv = (u: string | null | undefined) => !!u && WV.includes(u.toLowerCase())
          const rateUnit = wv(scanItem.rateUOM) ? scanItem.rateUOM!
            : wv(item.packUOM) ? item.packUOM!
            : 'kg'
          resolvedRateUnit = rateUnit
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

        // If the invoice's pack format genuinely differs from the stored item
        // format and the user did NOT consent to adopting it, the CASE fallback
        // below would divide an invoice-format price by inventory-format units —
        // wrong by the format ratio. Skip the write; the line stays un-approved.
        const invoiceFormatDiffers =
          scanItem.invoicePackQty !== null &&
          scanItem.invoicePackSize !== null &&
          (Number(scanItem.invoicePackQty)  !== Number(item.qtyPerPurchaseUnit) ||
           Number(scanItem.invoicePackSize) !== Number(item.packSize))
        const usedCaseFallback =
          rawPriceType !== 'UOM' &&
          !(scanItem.totalQty !== null && scanItem.totalQty !== undefined && Number(scanItem.totalQty) > 0)
        if (!useInvoicePack && invoiceFormatDiffers && usedCaseFallback) {
          console.error(
            `[approve] Skipping price write for "${scanItem.rawDescription}" — invoice pack format differs from stored format without consent`
          )
          skippedLines++
          continue
        }

        // Never write a zero/NaN price to the spine — a 0 pricePerBaseUnit
        // silently zeroes every recipe cost that reads this item. Leave the
        // line un-approved so it stays visible in the session for follow-up.
        if (!Number.isFinite(newPricePerBase) || newPricePerBase <= 0) {
          console.error(
            `[approve] Skipping price write for "${scanItem.rawDescription}" — computed pricePerBaseUnit=${newPricePerBase}`
          )
          skippedLines++
          continue
        }

        // Wrap all writes for this item in a transaction so a mid-item failure
        // doesn't leave inventory updated but the scan item un-approved.
        const prevPrice = Number(scanItem.previousPrice)
        const changePct = scanItem.priceDiffPct !== null ? Number(scanItem.priceDiffPct) : 0

        // ── Dual-write the chain pricing (Principle: keep legacy writes, ADD chain) ──
        // `pricing` always follows the resolved mode: UOM → RATE{rate,rateUnit};
        // otherwise PACK{purchasePrice}. The pack FORMAT (packChain/dimension/
        // countUnit) only changes when the user consented to adopt the invoice's
        // format (useInvoicePack) — otherwise the stored format is preserved.
        const newPricing = rawPriceType === 'UOM'
          ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: resolvedRateUnit }
          : { mode: 'PACK', purchasePrice: newPurchasePrice }
        // matchedItem is loaded with `include: { matchedItem: true }` (full row)
        // but typed narrowly above — read the extra fields off an `any` view.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemAny = item as any
        const formatChain = useInvoicePack
          ? formToChain({
              purchaseUnit:       itemAny.purchaseUnit ?? scanItem.rawUnit ?? 'case',
              purchasePrice:      newPurchasePrice,
              qtyPerPurchaseUnit: packQty,
              qtyUOM:             'each', // invoice-format pack is expressed via packSize/packUOM
              innerQty:           null,
              packSize,
              packUOM,
              priceType:          rawPriceType,
              countUOM:           itemAny.countUOM ?? 'each',
            })
          : null

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
              // Chain dual-write: pricing always; format only under consent.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing: newPricing as any,
              ...(formatChain
                ? {
                    dimension: formatChain.dimension,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    packChain: formatChain.packChain as any,
                    countUnit: formatChain.countUnit,
                  }
                : {}),
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
          priceAlertsCreated++
        }

        await prisma.$transaction(itemOps)
        updatedItemIds.push(scanItem.matchedItemId)
        registerAlloc(scanItem.matchedItemId, scanItem.revenueCenterId)

        // Upsert this supplier's offer: their last price, their pack format
        // (post-review resolved values), their SKU. Non-critical, outside the
        // transaction. Unique (inventoryItemId, supplierName) replaced the old
        // findFirst/create dance (the SP-1 migration deduped old rows).
        //
        // PRICE DENOMINATION: lastPrice must be the supplier's own price over
        // the pack format stored on this same row — the matcher divides one by
        // the other next invoice. UOM mode: the rate ($/uom). CASE mode: the
        // case price as printed (rawUnitPrice), NOT newPrice (which may have
        // been normalized into the ITEM's purchase format).
        if (offerSupplierName) {
          const hasLinePack = scanItem.invoicePackQty !== null && scanItem.invoicePackSize !== null
          const offerLastPrice = rawPriceType === 'UOM'
            ? newPurchasePrice
            : (hasLinePack && scanItem.rawUnitPrice != null ? Number(scanItem.rawUnitPrice) : newPurchasePrice)
          // No line pack → store the ITEM-format price with cleared pack columns
          // so the matcher falls back to item format on BOTH price and format.
          const offerPack = hasLinePack
            ? {
                packQty:  Number(scanItem.invoicePackQty),
                packSize: Number(scanItem.invoicePackSize),
                packUOM:  scanItem.invoicePackUOM ?? 'each',
              }
            : { packQty: null, packSize: null, packUOM: null }
          await prisma.inventorySupplierPrice.upsert({
            where: {
              inventoryItemId_supplierName: {
                inventoryItemId: scanItem.matchedItemId,
                supplierName:    offerSupplierName,
              },
            },
            create: {
              inventoryItemId:      scanItem.matchedItemId,
              supplierName:         offerSupplierName,
              supplierId:           session.supplierId || null,
              lastPrice:            offerLastPrice,
              pricePerBaseUnit:     newPricePerBase,
              isPrimary:            false,
              supplierItemCode:     scanItem.supplierItemCode ?? null,
              lastInvoiceSessionId: sessionId,
              ...offerPack,
            },
            update: {
              lastPrice:            offerLastPrice,
              pricePerBaseUnit:     newPricePerBase,
              lastUpdated:          new Date(),
              lastInvoiceSessionId: sessionId,
              ...(session.supplierId ? { supplierId: session.supplierId } : {}),
              ...(scanItem.supplierItemCode ? { supplierItemCode: scanItem.supplierItemCode } : {}),
              ...offerPack,
            },
          }).catch((e) => console.error('[approve] offer upsert failed:', e))
        }
      }

      // ── CREATE_NEW ──────────────────────────────────────────────────────
      if (scanItem.action === 'CREATE_NEW') {
        // Only the drawer's AddNewItemModal sets CREATE_NEW, and it always
        // persists newItemData (name, category, pack structure, price type).
        // Without it we'd create a garbage item (category DRY, 1×1 each) —
        // skip instead and leave the line un-approved.
        if (!scanItem.newItemData) {
          console.error(
            `[approve] Skipping CREATE_NEW for "${scanItem.rawDescription}" — no newItemData configured`
          )
          skippedLines++
          continue
        }
        const newData = JSON.parse(scanItem.newItemData)
        const newPurchasePrice = Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0
        const newPackQty  = Number(newData.qtyPerPurchaseUnit) || 1
        const newPackSize = Number(newData.packSize) || 1
        const newPackUOM  = newData.packUOM || 'each'
        const newPriceType: 'CASE' | 'UOM' = newData.priceType === 'UOM' ? 'UOM' : 'CASE'
        const newPricePerBase = Number(newData.pricePerBaseUnit) ||
          calcPricePerBaseUnit(newPurchasePrice, newPackQty, 'each', null, newPackSize, newPackUOM, newPriceType)
        const newCountUOM = newData.countUOM || 'each'
        // Reconstruct the chain from the resolved pack fields so the new item is
        // born with a chain that reproduces newPricePerBase via pricePerBaseUnit().
        const newChain = formToChain({
          purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
          purchasePrice:      newPurchasePrice,
          qtyPerPurchaseUnit: newPackQty,
          qtyUOM:             'each',
          innerQty:           null,
          packSize:           newPackSize,
          packUOM:            newPackUOM,
          priceType:          newPriceType,
          countUOM:           newCountUOM,
          baseUnit:           newData.baseUnit || deriveBaseUnit('each', newPackUOM, newPackSize),
        })
        const created = await prisma.inventoryItem.create({
          data: {
            itemName:           newData.itemName || scanItem.rawDescription,
            category:           newData.category || 'DRY',
            purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
            qtyPerPurchaseUnit: newPackQty,
            purchasePrice:      newPurchasePrice,
            // Canonical SI base (g/ml/each) — never the raw packUOM, which would
            // store ppb ($/SI-base) under a kg/lb/L label and under-cost recipes.
            baseUnit:           newData.baseUnit || deriveBaseUnit('each', newPackUOM, newPackSize),
            packSize:           newPackSize,
            packUOM:            newPackUOM,
            conversionFactor:   Number(newData.conversionFactor) || 1,
            pricePerBaseUnit:   newPricePerBase,
            priceType:          newPriceType,
            supplierId:         session.supplierId || null,
            // Chain dual-write alongside the legacy fields.
            dimension:          newChain.dimension,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            packChain:          newChain.packChain as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pricing:            newChain.pricing as any,
            countUnit:          newChain.countUnit,
          },
        })
        updatedItemIds.push(created.id)
        newItemsCreated++
        registerAlloc(created.id, scanItem.revenueCenterId)
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

    // ── Register RC stock allocations ───────────────────────────────────
    // Ensure each (item, non-default RC) pair has a StockAllocation row so the
    // purchased item shows up in that RC's inventory list. Quantity stays at its
    // existing value (0 for a fresh row) — theoretical on-hand fills in from the
    // purchase history. Non-critical: a failure here must not fail the approval.
    if (allocPairs.length > 0) {
      const seen = new Set<string>()
      for (const { itemId, rcId } of allocPairs) {
        const key = `${rcId}::${itemId}`
        if (seen.has(key)) continue
        seen.add(key)
        await prisma.stockAllocation.upsert({
          where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: itemId } },
          create: { revenueCenterId: rcId, inventoryItemId: itemId, quantity: 0 },
          update: {}, // already allocated — leave quantity/par/reorder untouched
        }).catch((e) => console.error('[approve] stock allocation upsert failed:', e))
      }
    }

    // Mark session as APPROVED. If any lines were skipped (price not safely
    // resolvable), surface that on the session so it isn't silently lost.
    await prisma.invoiceSession.update({
      where: { id: sessionId },
      data: {
        status: 'APPROVED',
        approvedBy,
        approvedAt: new Date(),
        ...(skippedLines > 0
          ? {
              errorMessage: `${skippedLines} line${skippedLines === 1 ? '' : 's'} skipped — price not updated (format or price could not be resolved safely). Re-open the invoice to review.`,
            }
          : {}),
      },
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

        // Copy the lines into the clone and flag the parent originals atomically,
        // so a failure can never leave both sets of lines live (double-count).
        await prisma.$transaction([
          prisma.invoiceScanItem.createMany({
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
          }),
          // Move-not-copy: flag the parent's originals so they are excluded from
          // spend aggregation. The clone's copies (splitToSessionId = null) are the
          // canonical home for these lines. Parent keeps the lines for fidelity.
          prisma.invoiceScanItem.updateMany({
            where: { id: { in: rcItems.map(i => i.id) } },
            data:  { splitToSessionId: clone.id },
          }),
        ])
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
            // Save under the CANONICAL supplier name so the rule applies to every
            // name variant ("SYSCO Canada, Inc." / "… - Vancouver") next time.
            offerSupplierName ?? session.supplierName,
            item.invoicePackQty ? {
              packQty:  Number(item.invoicePackQty),
              packSize: Number(item.invoicePackSize),
              packUOM:  item.invoicePackUOM ?? 'each',
            } : undefined,
            item.supplierItemCode
          ).catch(() => {})
        )
    )

    // ── Re-sync PREP costs + recalculate recipe costs for changed items ──
    let recipeAlertsCreated = 0
    if (updatedItemIds.length > 0) {
      // Re-sync every PREP recipe whose cost depends on a changed item — directly
      // OR transitively (prep-in-prep) — so its spine price (the value every other
      // recipe/report/count reads) reflects the new ingredient price NOW, not only
      // on the next manual recipe edit. Returns the prep output items that moved.
      const movedPrepItemIds = await propagatePrepCostChanges(updatedItemIds)
      // Alerts should cover recipes using a changed raw item OR a prep whose cost
      // moved, so feed both sets into the recipe-cost recalc.
      const alerts = await recalculateRecipeCosts(
        [...new Set([...updatedItemIds, ...movedPrepItemIds])],
        sessionId,
      )
      recipeAlertsCreated = alerts.length
    }

    return {
      itemsUpdated:    updatedItemIds.length - newItemsCreated,
      newItemsCreated,
      priceAlerts:     priceAlertsCreated,
      recipeAlerts:    recipeAlertsCreated,
      skippedLines,
    }
  } catch (err) {
    await prisma.invoiceSession.update({
      where: { id: sessionId },
      data: { status: 'REVIEW', errorMessage: String(err).slice(0, 500) },
    })
    throw err
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

  const body = await req.json().catch(() => ({} as Record<string, unknown>))

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

  // ── Duplicate gate ──────────────────────────────────────────────────────
  // Same supplier + same invoice number already approved → block unless the
  // client re-submits with { force: true } after the user confirms.
  if (body?.force !== true && session.invoiceNumber && session.supplierName) {
    const dup = await prisma.invoiceSession.findFirst({
      where: {
        id:            { not: session.id },
        status:        { in: ['APPROVED', 'APPROVING'] },
        invoiceNumber: session.invoiceNumber,
        supplierName:  session.supplierName,
      },
      select: { id: true, approvedAt: true },
    })
    if (dup) {
      return NextResponse.json(
        {
          error: `Invoice ${session.invoiceNumber} from ${session.supplierName} was already approved${dup.approvedAt ? ` on ${new Date(dup.approvedAt).toLocaleDateString('en-CA')}` : ''}. Approving again will apply its price changes a second time.`,
          duplicate: true,
        },
        { status: 409 }
      )
    }
  }

  // ── Atomic status claim ─────────────────────────────────────────────────
  // Compare-and-set REVIEW → APPROVING so a double-tap (or two reviewers) can
  // never run doApprove twice over the same session.
  const claimed = await prisma.invoiceSession.updateMany({
    where: { id: params.id, status: 'REVIEW' },
    data:  { status: 'APPROVING' },
  })
  if (claimed.count === 0) {
    return NextResponse.json({ error: 'Session is already being approved' }, { status: 409 })
  }

  // waitUntil keeps the Vercel function alive until doApprove finishes,
  // even after the response has been sent to the client.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitUntil(doApprove(params.id, approvedBy, session as any).catch(() => {}))

  return NextResponse.json({ ok: true, queued: true })
}
