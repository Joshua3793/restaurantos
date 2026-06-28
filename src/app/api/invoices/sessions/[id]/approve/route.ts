import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { ensurePrimary, mirrorItemToPrimaryOffer } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { saveMatchRule } from '@/lib/invoice-matcher'
import { canonicalSupplierName } from '@/lib/supplier-offers'
import { getUnitConv, deriveBaseUnit } from '@/lib/utils'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { formToChain } from '@/lib/item-model-form'
import { dimensionOf, pricePerBaseUnit, asChainItem, PRICING_SELECT, DIMENSION_BASE, eachMeasureOf, type PackLink, type Dimension, type Pricing } from '@/lib/item-model'
import { dimensionallyCostable } from '@/lib/uom'
import { lineReceivedCountQty } from '@/lib/invoice/line-qty'
import { lookupDensity } from '@/lib/density'
import { densityCrossedPpb } from '@/lib/invoice/density-bridge'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'

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
  session: { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; itemName: string; dimension: string; baseUnit: string | null; packChain: any; pricing: any; countUnit: string | null; eachMeasureQty: any; eachMeasureUnit: string | null; densityGPerMl?: unknown } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; totalQty: any; totalQtyUOM: string | null; rate: any; rateUOM: string | null; revenueCenterId: string | null; rcSplit: any; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any; supplierItemCode: string | null }> }
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

    // A line's RC split [{rcId, qty}] (count UOM), validated to sum to the line's
    // received quantity. Returns null when absent/invalid (caller falls back to the
    // single revenueCenterId). The review UI blocks approving an invalid split, so
    // this is defensive — an invalid split is ignored rather than mis-allocated.
    const parseValidSplit = (scanItem: typeof session.scanItems[number]): Array<{ rcId: string; qty: number }> | null => {
      const raw = scanItem.rcSplit
      if (!Array.isArray(raw) || raw.length === 0 || !scanItem.matchedItem) return null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries = (raw as any[]).map(e => ({ rcId: String(e?.rcId ?? ''), qty: Number(e?.qty) })).filter(e => e.rcId && e.qty > 0)
      if (entries.length === 0) return null
      const { qty: total } = lineReceivedCountQty(scanItem as any, scanItem.matchedItem as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!(total > 0)) return null
      const sum = entries.reduce((s, e) => s + e.qty, 0)
      if (Math.abs(sum - total) > Math.max(0.001, total * 0.005)) return null
      return entries
    }

    // Register the StockAllocation marker(s) for a line — every RC it touches
    // (each split RC, or the single line RC), so the item shows in each RC.
    const registerLineAllocs = (itemId: string | null, scanItem: typeof session.scanItems[number]) => {
      const split = parseValidSplit(scanItem)
      if (split) split.forEach(e => registerAlloc(itemId, e.rcId))
      else registerAlloc(itemId, scanItem.revenueCenterId)
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
        //
        // A bridged COUNT item is ALWAYS a count purchase — the printed weight
        // (e.g. Brioche "8×1100g") is the per-each size, not a $/weight billing
        // rate. Route it through the PACK/CASE path so ppb derives as $/each from
        // the item's OWN count chain (case price ÷ units per case), exactly like
        // any other count item. Without this, the 'g' packUOM mis-classifies the
        // line as per_weight and the dimension guard skips it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemBridge = eachMeasureOf(item as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isUomMode = derivePricingMode(scanItem as any) === 'per_weight' && !itemBridge

        // ── Reverse bridge: a MEASURED item receiving a COUNT line ───────────
        // Mirror of the forward bridge. The line is priced/shipped by count
        // (e.g. "1 cs = 70 each") but the item is set up by weight/volume. The
        // each-measure ("1 each = N g") converts the count pack into the item's
        // base, so $/case ÷ (units-per-case × base-per-each) = $/base. Without
        // this the CASE path would divide by the item's OWN (unrelated) chain.
        const reverseBridge =
          !!itemBridge && item.dimension !== 'COUNT' &&
          dimensionOf(scanItem.invoicePackUOM ?? scanItem.rawUnit ?? 'each') === 'COUNT' &&
          dimensionOf(itemBridge.unit) === item.dimension
        const reverseBasePerCase = reverseBridge
          ? ((Number(scanItem.invoicePackQty) || 1) * (Number(scanItem.invoicePackSize) || 1))
            * (itemBridge!.qty * getUnitConv(itemBridge!.unit) / getUnitConv(item.baseUnit ?? itemBridge!.unit))
          : 0

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
        let density = 0
        // The RATE's resolved unit (only meaningful in UOM mode) — captured here
        // so the chain `pricing` below can store { mode:'RATE', rate, rateUnit }.
        // This 'kg' default is ONLY meaningful inside the isUomMode branch (the
        // density-cross check reads it there); do not rely on it outside that branch.
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
          // ── Weight↔volume density bridge ────────────────────────────────────
          // A measured rate ($/kg) on an item whose base is the OTHER measured
          // dimension ($/ml) must cross via density (g/ml), not the silent 1:1.
          // Precedence: density already learned on the item > library default by
          // name > 1.0 fallback. The resolved density is persisted on the item
          // (spine write below) so recipe costing and this write always agree.
          const rateDim = dimensionOf(resolvedRateUnit)
          const baseDim = dimensionOf(item.baseUnit ?? 'each')
          const crossesWV =
            (rateDim === 'MASS' && baseDim === 'VOLUME') ||
            (rateDim === 'VOLUME' && baseDim === 'MASS')
          if (crossesWV) {
            const learned = item.densityGPerMl != null ? Number(item.densityGPerMl) : null
            density = (learned && learned > 0)
              ? learned
              : lookupDensity(item.itemName ?? scanItem.rawDescription ?? '').gPerMl
            newPricePerBase = densityCrossedPpb(newPricePerBase, rateDim, baseDim, density)
          }
        } else if (reverseBridge && reverseBasePerCase > 0) {
          // Reverse bridge: $/case ÷ (units-per-case × base-per-each) = $/base.
          newPricePerBase = newPurchasePrice / reverseBasePerCase
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
          const offerChain = (reverseBridge && reverseBasePerCase > 0)
            // Reverse bridge: the offer is a measured purchase — 1 container =
            // reverseBasePerCase base units. A single PACK link reproduces the
            // spine ppb (offerLastPrice ÷ reverseBasePerCase == newPricePerBase).
            ? {
                packChain: [{ unit: itemTopUnit ?? scanItem.rawUnit ?? 'case', per: reverseBasePerCase }] as PackLink[],
                pricing: { mode: 'PACK' as const, purchasePrice: offerLastPrice },
              }
            : hasLinePack
            ? formToChain({
                purchaseUnit:       itemTopUnit ?? scanItem.rawUnit ?? 'case',
                purchasePrice:      offerLastPrice,
                qtyPerPurchaseUnit: Number(scanItem.invoicePackQty),
                qtyUOM:             'each', // offer pack is expressed via packSize/packUOM
                innerQty:           null,
                // Bridged COUNT item: the line's weight (e.g. 1100 g) is the
                // per-each SIZE (kept in the offerPack provenance triple), NOT a
                // chain divisor. Build the offer chain in COUNT units so the leaf
                // is `each per 1` and basePerPurchase = invoicePackQty — making the
                // offer ppb equal the item spine ($/each). Without this, the leaf
                // would be 1100 g → basePerPurchase 8800 → offer ppb ~1100× too low,
                // which would corrupt the item spine if this offer becomes primary.
                packSize:           (itemBridge && !isUomMode) ? 1 : Number(scanItem.invoicePackSize),
                // UOM mode: pass the RESOLVED rate unit as packUOM so formToChain's
                // RATE branch denominates by it (matches newPricePerBase exactly).
                packUOM:            isUomMode
                  ? resolvedRateUnit
                  : (itemBridge ? 'each' : (scanItem.invoicePackUOM ?? 'each')),
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

        // ── Primary-offer authority ─────────────────────────────────────────
        // Bootstrap: the item's FIRST offer becomes primary. The item's $ spine is
        // the PRIMARY offer's value and the primary is a sticky MANUAL choice — a
        // non-primary supplier's invoice records its offer (above) but never
        // re-prices the item. Re-price only when this line's supplier IS the
        // primary, OR when the invoice had no resolvable supplier (no offer to
        // derive from → legacy direct write so the spine still updates).
        let shouldReprice = true
        if (offerSupplierName) {
          await ensurePrimary(scanItem.matchedItemId)
          const primary = await prisma.inventorySupplierPrice.findFirst({
            where: { inventoryItemId: scanItem.matchedItemId, isPrimary: true },
            select: { supplierName: true },
          })
          shouldReprice = primary?.supplierName === offerSupplierName
        }

        // ── Write the item spine (only when re-pricing) + mark approved ──────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemOps: any[] = [
          prisma.invoiceScanItem.update({ where: { id: scanItem.id }, data: { approved: true } }),
        ]
        if (shouldReprice) {
          itemOps.unshift(
            prisma.inventoryItem.update({
              where: { id: scanItem.matchedItemId },
              data: {
                purchasePrice: newPurchasePrice,
                lastUpdated:   new Date(),
                // Spine write: pricing only. The item's chain/format is preserved.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                pricing: newPricing as any,
                // Persist the resolved weight↔volume density so the next invoice + every
                // recipe cost uses the same factor (no per-path divergence). Only fires
                // here, inside the shouldReprice branch — so density-learning happens on
                // the PRIMARY supplier's invoice (the spine-write path); the resolver UI
                // also lets the user set densityGPerMl directly.
                ...(density > 0 ? { densityGPerMl: density } : {}),
              },
            }),
          )
          // PriceAlert on the SPINE ($/base) basis — old ppb → new ppb — so the
          // stored previousPrice/newPrice/changePct stay consistent and every inbox
          // renderer agrees (see the oldPpb/changePct computation above).
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
              }),
            )
            priceAlertsCreated++
          }
        }

        await prisma.$transaction(itemOps)
        if (shouldReprice) updatedItemIds.push(scanItem.matchedItemId)
        // Keep the PRIMARY offer's chain == the item's chain so their per-base
        // prices never diverge (non-primary offers keep their own invoice chain
        // for accurate cross-supplier comparison).
        if (shouldReprice && offerSupplierName) {
          await mirrorItemToPrimaryOffer(scanItem.matchedItemId)
        }
        registerLineAllocs(scanItem.matchedItemId, scanItem)
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
        // The drawer's AddNewItemModal now writes a chain-shaped newItemData
        // ({ dimension, packChain, pricing, countUnit }). Older sessions may
        // still carry the legacy pack-field shape — reconstruct the chain from
        // those via formToChain so in-flight invoices keep approving.
        const newChain: { dimension: Dimension; baseUnit: string; packChain: PackLink[]; pricing: Pricing; countUnit: string } =
          Array.isArray(newData.packChain)
            ? {
                dimension: (newData.dimension ?? dimensionOf(newData.baseUnit ?? 'each')) as Dimension,
                baseUnit: DIMENSION_BASE[(newData.dimension ?? dimensionOf(newData.baseUnit ?? 'each')) as Dimension],
                packChain: newData.packChain as PackLink[],
                pricing: newData.pricing as Pricing,
                countUnit: newData.countUnit || 'each',
              }
            : formToChain({
                purchaseUnit:       newData.purchaseUnit || scanItem.rawUnit || 'each',
                purchasePrice:      Number(newData.purchasePrice) || Number(scanItem.newPrice) || 0,
                qtyPerPurchaseUnit: Number(newData.qtyPerPurchaseUnit) || 1,
                qtyUOM:             'each',
                innerQty:           null,
                packSize:           Number(newData.packSize) || 1,
                packUOM:            newData.packUOM || 'each',
                priceType:          newData.priceType === 'UOM' ? 'UOM' : 'CASE',
                countUOM:           newData.countUOM || 'each',
                baseUnit:           newData.baseUnit || deriveBaseUnit('each', newData.packUOM || 'each', Number(newData.packSize) || 1),
              })
        // Headline purchasePrice for the column: PACK price, or RATE rate.
        const newPurchasePrice = newChain.pricing.mode === 'RATE'
          ? Number(newChain.pricing.rate) || 0
          : Number(newChain.pricing.purchasePrice) || 0
        const created = await prisma.inventoryItem.create({
          data: {
            itemName:           newData.itemName || scanItem.rawDescription,
            category:           newData.category || 'DRY',
            purchasePrice:      newPurchasePrice,
            // Canonical SI base (g/ml/each) — never the raw packUOM, which would
            // store ppb ($/SI-base) under a kg/lb/L label and under-cost recipes.
            baseUnit:           newChain.baseUnit,
            // Supplier/location chosen in the modal; supplier falls back to the
            // invoice's supplier when left as the pre-selected default. Location
            // is a storage area established in the app (storageAreaId).
            supplierId:         newData.supplierId || session.supplierId || null,
            storageAreaId:      newData.storageAreaId || null,
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
        registerLineAllocs(created.id, scanItem)
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
        // Receiving stock into an RC implies membership (so it's countable there).
        await prisma.itemRevenueCenter.upsert({
          where: { inventoryItemId_revenueCenterId: { inventoryItemId: itemId, revenueCenterId: rcId } },
          create: { inventoryItemId: itemId, revenueCenterId: rcId },
          update: {},
        }).catch((e) => console.error('[approve] membership upsert failed:', e))
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

      // Build per-RC copy specs. A whole non-default line moves entirely into its
      // RC clone (factor 1). A SPLIT line fans out across several RC clones, each
      // copy scaled by its share — receiving qty + cost both follow the split, so
      // per-RC theoretical stock and COGS reconcile to the invoiced totals.
      type Spec = { item: typeof session.scanItems[number]; factor: number; whole: boolean }
      const specsByRc = new Map<string, Spec[]>()
      const splitOriginalIds: string[] = []
      for (const item of session.scanItems) {
        const split = parseValidSplit(item)
        if (split) {
          const sum = split.reduce((s, e) => s + e.qty, 0)
          for (const e of split) {
            const factor = e.qty / sum   // sum ≈ received qty (validated)
            if (factor <= 0) continue
            if (!specsByRc.has(e.rcId)) specsByRc.set(e.rcId, [])
            specsByRc.get(e.rcId)!.push({ item, factor, whole: false })
          }
          splitOriginalIds.push(item.id)
        } else {
          const rc = item.revenueCenterId ?? sessionRcId
          if (rc === sessionRcId) continue   // default share stays in the parent
          if (!specsByRc.has(rc)) specsByRc.set(rc, [])
          specsByRc.get(rc)!.push({ item, factor: 1, whole: true })
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scaledCopy = (item: typeof session.scanItems[number], rcId: string, cloneId: string, factor: number): any => {
        const scale = (v: unknown) => (v != null ? Number(v) * factor : null)
        return {
          sessionId:       cloneId,
          rawDescription:  item.rawDescription,
          rawQty:          item.rawQty != null ? Number(item.rawQty) * factor : (factor < 1 ? factor : null),
          rawUnit:         item.rawUnit,
          rawUnitPrice:    item.rawUnitPrice,       // per-unit price unchanged
          rawLineTotal:    scale(item.rawLineTotal), // money share
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
          // qty-driving fields so per-RC theoretical receiving = this share
          totalQty:        scale(item.totalQty),
          totalQtyUOM:     item.totalQtyUOM,
          rate:            item.rate,               // $/uom unchanged
          rateUOM:         item.rateUOM,
          invoicePackQty:  item.invoicePackQty,     // unscaled — rawQty carries the scale
          invoicePackSize: item.invoicePackSize,
          invoicePackUOM:  item.invoicePackUOM,
        }
      }

      // originalId → cloneId to flag (excludes the parent original from aggregation).
      const flagToClone = new Map<string, string>()
      let firstSplitCloneId: string | null = null

      for (const [rcId, specs] of specsByRc) {
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
        if (!firstSplitCloneId) firstSplitCloneId = clone.id
        await prisma.invoiceScanItem.createMany({
          data: specs.map(s => scaledCopy(s.item, rcId, clone.id, s.factor)),
        })
        // Whole moves: the original belongs to this one clone.
        for (const s of specs) if (s.whole) flagToClone.set(s.item.id, clone.id)
      }

      // Split originals: excluded (represented by their fan-out copies). Any clone
      // id works as the flag — re-approve deletes all clones and un-flags these.
      if (firstSplitCloneId) for (const id of splitOriginalIds) flagToClone.set(id, firstSplitCloneId)

      // Flag the parent originals (grouped by target clone).
      const byClone = new Map<string, string[]>()
      for (const [origId, cloneId] of flagToClone) {
        if (!byClone.has(cloneId)) byClone.set(cloneId, [])
        byClone.get(cloneId)!.push(origId)
      }
      for (const [cloneId, ids] of byClone) {
        await prisma.invoiceScanItem.updateMany({ where: { id: { in: ids } }, data: { splitToSessionId: cloneId } })
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

  // ── RC write-scope guard ────────────────────────────────────────────────
  // Approval fans stock/allocation out across every RC the invoice touches: the
  // session's RC (defaulting to the default RC when null — matching doApprove's
  // effectiveSessionRcId), each line's RC override, and every rcSplit[].rcId.
  // Collect ALL distinct rc ids and assert the user may write each one BEFORE
  // claiming the session, so a forbidden write never leaves it stuck in APPROVING.
  const rcIdsToGuard = new Set<string>()
  if (session.revenueCenterId) {
    rcIdsToGuard.add(session.revenueCenterId)
  } else {
    const defaultRc = await prisma.revenueCenter.findFirst({
      where: { isDefault: true },
      select: { id: true },
    })
    if (defaultRc) rcIdsToGuard.add(defaultRc.id)
  }
  for (const si of session.scanItems) {
    if (si.revenueCenterId) rcIdsToGuard.add(si.revenueCenterId)
    const split = si.rcSplit
    if (Array.isArray(split)) {
      for (const e of split as Array<{ rcId?: unknown }>) {
        if (e && typeof e.rcId === 'string' && e.rcId) rcIdsToGuard.add(e.rcId)
      }
    }
  }
  try {
    for (const rcId of rcIdsToGuard) await assertRcWritable(currentUser, rcId)
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
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
