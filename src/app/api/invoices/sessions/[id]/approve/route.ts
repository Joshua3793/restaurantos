import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { canonicalSupplierName } from '@/lib/supplier-offers'
import { getUnitConv, deriveBaseUnit } from '@/lib/utils'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { formToChain } from '@/lib/item-model-form'
import { dimensionOf, pricePerBaseUnit, asChainItem, PRICING_SELECT, type PackLink } from '@/lib/item-model'
import { dimensionallyCostable } from '@/lib/uom'
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
  session: { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; dimension: string; baseUnit: string | null; packChain: any; pricing: any; countUnit: string | null } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; totalQty: any; totalQtyUOM: string | null; rate: any; rateUOM: string | null; revenueCenterId: string | null; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any; supplierItemCode: string | null }> }
): Promise<ApproveResult> {
  let priceAlertsCreated = 0
  let newItemsCreated = 0
  let skippedLines = 0
  try {
    const itemsToProcess = session.scanItems.filter(
      item => item.action !== 'SKIP' && item.action !== 'PENDING'
    )

    const updatedItemIds: string[] = []

    // Pre-approval ppb per item we reprice — captured BEFORE the spine write so
    // recipe-cost alerts can compute the real cost change (old → new) on the fly.
    const priorPpbByItem = new Map<string, number>()

    // (itemId, rcId) pairs to register as RC stock allocations. A line assigned to a
    // non-default RC must make its inventory item appear in that RC's inventory list —
    // which is gated by StockAllocation rows. Collected during the loop, upserted after.
    const allocPairs: Array<{ itemId: string; rcId: string }> = []
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })
    const defaultRcId = defaultRc?.id ?? null
    // Approving without an RC attributes the invoice's purchases to no revenue
    // center (dropped from per-RC theoretical stock). Default to the default RC.
    const effectiveSessionRcId = session.revenueCenterId ?? defaultRcId
    // The line's effective RC is its own override, else the invoice's active RC.
    // Only non-default RCs need an allocation row (default RC reads global stockOnHand).
    const registerAlloc = (itemId: string | null, lineRcId: string | null) => {
      const rcId = lineRcId ?? effectiveSessionRcId
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

        // The line's pricing mode comes straight from the OCR (per_case /
        // per_weight). per_weight → RATE pricing, otherwise PACK. There is no
        // "mode mismatch" to resolve — the offer's mode is authoritative.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isUomMode = derivePricingMode(scanItem as any) === 'per_weight'

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

        let newPricePerBase: number
        // The RATE's resolved unit (only meaningful in UOM mode) — captured here
        // so the chain `pricing` below can store { mode:'RATE', rate, rateUnit }.
        let resolvedRateUnit = 'kg'
        if (isUomMode) {
          // newPurchasePrice is a rate ($/kg, $/lb…). Divide by the RATE's OWN
          // unit — the scan line's rateUOM — not the physical pack unit. A
          // catch-weight item packed in pieces has packUOM='each' (conv 1),
          // which left the rate unconverted and inflated cost 1000×.
          const WV = ['g', 'mg', 'kg', 'lb', 'oz', 'ml', 'cl', 'dl', 'l', 'lt', 'fl oz', 'tsp', 'tbsp', 'cup', 'gal']
          const wv = (u: string | null | undefined) => !!u && WV.includes(u.toLowerCase())
          // Fallback when the line carries no usable rateUOM: the item's own
          // base unit (a measured base IS the rate denominator for a UOM item).
          const rateUnit = wv(scanItem.rateUOM) ? scanItem.rateUOM!
            : wv(item.baseUnit) ? item.baseUnit!
            : 'kg'
          resolvedRateUnit = rateUnit
          const uomConv = getUnitConv(rateUnit)
          newPricePerBase = uomConv > 0 ? newPurchasePrice / uomConv : 0
        } else {
          // CASE: the price is PER CASE. pricePerBaseUnit derives from the pack
          // STRUCTURE — never from the line's totalQty. rawUnitPrice is a per-case
          // price, so dividing it by a total quantity is dimensionally wrong (and
          // OCR totalQty is often inconsistent with the confirmed pack — e.g.
          // Butter 2 CS @ $172.79 carried a stray totalQty 2.86 kg, yielding
          // $0.0604/g instead of the correct $0.0152/g).
          //
          // The invoice updates the item's PRICE over its OWN canonical chain; it
          // never silently rewrites the item's pack FORMAT (that's a deliberate
          // inventory edit). So the per-case price always divides by the base
          // units in one top container of the item's STORED chain. This matches
          // the DELETE-revert path (which also derives from `pricing`).
          newPricePerBase = pricePerBaseUnit({
            dimension: dimensionOf(item.baseUnit ?? 'each'),
            baseUnit: item.baseUnit ?? 'each',
            packChain: (item.packChain as PackLink[]) ?? [],
            pricing: { mode: 'PACK', purchasePrice: newPurchasePrice },
          })
        }

        // ── Dimension-conflict guard (gap #2) ───────────────────────────────
        // In UOM/rate mode the incoming price is a $/<rateUnit> rate; its base
        // is `resolvedRateUnit`'s dimension. If that differs from the matched
        // item's own dimension, this rate is denominated in a unit the item
        // can't be costed in (e.g. a $/kg line landing on an each-priced item).
        // Writing newPricePerBase ($/g) onto an each-item would silently corrupt
        // every recipe/count that reads the spine. Skip the price write instead.
        // CASE mode is dimension-agnostic (a case price resolves via the item's
        // own pack structure), so it can never conflict — only UOM/rate mode is
        // checked here. Weight↔volume is tolerated (density≈1); the genuine
        // catastrophe is a $/kg (or $/L) rate landing on a COUNT/each item.
        if (isUomMode && item.baseUnit &&
            !dimensionallyCostable(resolvedRateUnit, item.baseUnit)) {
          console.error(
            `[approve] Skipping price write for "${scanItem.rawDescription}" — ` +
            `rate unit '${resolvedRateUnit}' (${dimensionOf(resolvedRateUnit)}) ` +
            `can't be costed against item base '${item.baseUnit}' (${item.dimension}). ` +
            `A cross-dimension rate can never overwrite this item's price.`
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
        //
        // The PriceAlert is recorded on the SPINE ($/base-unit) basis — the value
        // every recipe cost reads — using the item's OLD ppb (before this write)
        // and the NEW ppb (newPricePerBase). The stored previousPrice/newPrice/
        // changePct are therefore internally consistent and agree across every
        // inbox renderer (some re-derive % from the two prices, some show the
        // stored %). The old path stored a per-base previousPrice next to a
        // per-CASE newPrice and a separately-computed scanItem.priceDiffPct, so
        // the three disagreed and the displayed percentages were nonsense.
        const oldPpb = pricePerBaseUnit({
          dimension: item.dimension as 'MASS' | 'VOLUME' | 'COUNT',
          baseUnit: item.baseUnit ?? 'each',
          packChain: (item.packChain as PackLink[]) ?? [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pricing: item.pricing as any,
        })
        const changePct = oldPpb > 0 ? ((newPricePerBase - oldPpb) / oldPpb) * 100 : 0
        if (scanItem.matchedItemId) priorPpbByItem.set(scanItem.matchedItemId, oldPpb)

        // ── Write the item's pricing (the spine) ────────────────────────────
        // `pricing` follows the line's mode: per_weight → RATE{rate,rateUnit};
        // otherwise PACK{purchasePrice}. The item's pack FORMAT (packChain/
        // dimension/countUnit) is its canonical structure and is NEVER rewritten
        // by an invoice — ppb derives from `pricing` over the item's stored
        // chain. Changing an item's format is a deliberate inventory edit.
        const newPricing = isUomMode
          ? { mode: 'RATE', rate: newPurchasePrice, rateUnit: resolvedRateUnit }
          : { mode: 'PACK', purchasePrice: newPurchasePrice }
        // The top container name comes from the item's own stored chain — used by
        // the per-supplier offer chain below (no legacy-column reads).
        const itemTopUnit = (item.packChain as PackLink[] | null)?.[0]?.unit

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemOps: any[] = [
          prisma.inventoryItem.update({
            where: { id: scanItem.matchedItemId },
            data: {
              purchasePrice:    newPurchasePrice,
              lastUpdated:      new Date(),
              // Spine write: pricing only. The item's chain/format is preserved.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing: newPricing as any,
            },
          }),
          prisma.invoiceScanItem.update({
            where: { id: scanItem.id },
            data: { approved: true },
          }),
        ]

        if (oldPpb > 0 && Math.abs(changePct) >= 15) {
          itemOps.push(
            prisma.priceAlert.create({
              data: {
                sessionId,
                inventoryItemId: scanItem.matchedItemId,
                previousPrice:   oldPpb,
                newPrice:        newPricePerBase,
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
          const offerLastPrice = isUomMode
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

          // ── Per-offer pack chain + pricing (ItemOffer semantics) ──────────
          // This offer carries its OWN chain reflecting THIS supplier's pack
          // format + price (exactly what this line resolved), so the offer's
          // pricePerBaseUnit derives on read and cross-supplier comparison is a
          // single numeric compare. UOM mode → RATE{rate,rateUnit} (the rate the
          // line resolved); CASE mode → PACK over this offer's own pack format.
          // The chain's dimension/baseUnit follow the parent item (the price was
          // resolved against it). With a line pack we build a fresh chain from
          // the invoice format; with NO line pack we reuse the item's OWN stored
          // chain (no legacy-column reads) so the offer still reproduces
          // newPricePerBase exactly.
          const itemChain = (item.packChain as PackLink[]) ?? []
          // formToChain is the SANCTIONED legacy-form → pack-chain adapter; the
            // object below is a transient input DTO (qtyUOM/innerQty are vestigial
            // adapter params, never persisted), NOT legacy columns. Do not inline.
          const offerChain = hasLinePack
            ? formToChain({
                purchaseUnit:       itemTopUnit ?? scanItem.rawUnit ?? 'case',
                purchasePrice:      offerLastPrice,
                qtyPerPurchaseUnit: Number(scanItem.invoicePackQty),
                qtyUOM:             'each', // offer pack is expressed via packSize/packUOM
                innerQty:           null,
                packSize:           Number(scanItem.invoicePackSize),
                // UOM mode: pass the RESOLVED rate unit as packUOM so formToChain's
                // RATE branch denominates by it (matches newPricePerBase exactly).
                packUOM:            isUomMode
                  ? resolvedRateUnit
                  : (scanItem.invoicePackUOM ?? 'each'),
                priceType:          isUomMode ? 'UOM' : 'CASE',
                countUOM:           item.countUnit ?? 'each',
                baseUnit:           item.baseUnit ?? undefined,
              })
            : {
                // Reuse the item's stored chain; pricing follows the resolved mode
                // over the offer's last price. CASE: PACK over the item chain (ppb
                // = offerLastPrice / basePerPurchase = item ppb when prices match).
                // UOM: RATE over the resolved rate unit.
                packChain: itemChain,
                pricing: isUomMode
                  ? { mode: 'RATE', rate: offerLastPrice, rateUnit: resolvedRateUnit }
                  : { mode: 'PACK', purchasePrice: offerLastPrice },
              }

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
              isPrimary:            false,
              supplierItemCode:     scanItem.supplierItemCode ?? null,
              lastInvoiceSessionId: sessionId,
              ...offerPack,
              // Per-offer chain (ItemOffer): offer ppb derives from this on read.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              packChain:            offerChain.packChain as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing:              offerChain.pricing as any,
            },
            update: {
              lastPrice:            offerLastPrice,
              lastUpdated:          new Date(),
              lastInvoiceSessionId: sessionId,
              ...(session.supplierId ? { supplierId: session.supplierId } : {}),
              ...(scanItem.supplierItemCode ? { supplierItemCode: scanItem.supplierItemCode } : {}),
              ...offerPack,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              packChain:            offerChain.packChain as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing:              offerChain.pricing as any,
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
            purchasePrice:      newPurchasePrice,
            // Canonical SI base (g/ml/each) — never the raw packUOM, which would
            // store ppb ($/SI-base) under a kg/lb/L label and under-cost recipes.
            baseUnit:           newChain.baseUnit,
            supplierId:         session.supplierId || null,
            // Chain columns (authoritative).
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
        revenueCenterId: effectiveSessionRcId,
        ...(skippedLines > 0
          ? {
              errorMessage: `${skippedLines} line${skippedLines === 1 ? '' : 's'} skipped — price not updated (a dimension conflict or unresolvable price blocked the write). Re-open the invoice to review.`,
            }
          : {}),
      },
    })

    // ── Clone session per RC ────────────────────────────────────────────
    // Idempotency: a prior approval (before a reset → re-approve) may have created RC
    // clone sessions and flagged parent lines with splitToSessionId. Re-approving must
    // REPLACE those, not stack a second set — otherwise each clone's copies
    // (splitToSessionId = null) are counted again as purchases/spend (double-count).
    // Remove prior clones (cascade-deletes their copied scan items) and un-split the
    // parent lines so each approval rebuilds exactly one set of clones.
    const priorClones = await prisma.invoiceSession.findMany({
      where: { parentSessionId: sessionId },
      select: { id: true },
    })
    if (priorClones.length > 0) {
      const cloneIds = priorClones.map(c => c.id)
      await prisma.invoiceScanItem.updateMany({
        where: { splitToSessionId: { in: cloneIds } },
        data:  { splitToSessionId: null },
      })
      await prisma.invoiceSession.deleteMany({ where: { id: { in: cloneIds } } })
    }

    if (effectiveSessionRcId) {
      const sessionRcId = effectiveSessionRcId
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
      // Snapshot every PREP output item's ppb BEFORE the cascade recomputes it —
      // that's its pre-approval (old) cost, needed for an accurate recipe-cost
      // change. Raw items repriced in the loop are already in priorPpbByItem.
      const prepOutputs = await prisma.recipe.findMany({
        where: { type: 'PREP', inventoryItemId: { not: null } },
        select: { inventoryItem: { select: { id: true, ...PRICING_SELECT } } },
      })
      for (const p of prepOutputs) {
        if (p.inventoryItem && !priorPpbByItem.has(p.inventoryItem.id)) {
          priorPpbByItem.set(p.inventoryItem.id, pricePerBaseUnit(asChainItem(p.inventoryItem)))
        }
      }

      const movedPrepItemIds = await propagatePrepCostChanges(updatedItemIds)
      // Alerts should cover recipes using a changed raw item OR a prep whose cost
      // moved, so feed both sets into the recipe-cost recalc.
      const alerts = await recalculateRecipeCosts(
        [...new Set([...updatedItemIds, ...movedPrepItemIds])],
        sessionId,
        priorPpbByItem,
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
