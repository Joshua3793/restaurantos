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
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { formToChain } from '@/lib/item-model-form'
import { dimensionOf, pricePerBaseUnit, ratePerBase, rateIsCostable, asChainItem, PRICING_SELECT, DIMENSION_BASE, eachMeasureOf, invoicePackBaseTotal, packFormatsDisagree, type PackLink, type Dimension, type Pricing } from '@/lib/item-model'
import { lineReceivedCountQty, lineReceivedBaseUnits, lineReceived, type LineQtyInput } from '@/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer, type OfferFormat } from '@/lib/invoice/line-format'
import { packReference, casePricePerBase, freezeFormat, pricingBasisFor, packIsTheQuantity, nonEmptyOfferChain, weightBasisRate, isMeasureUnit } from '@/lib/invoice/approve-format'
import { canonicalUom } from '@/lib/uom'
import { lookupDensity } from '@/lib/density'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolvePurchaseDate } from '@/lib/purchase-date'

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

    // Offers are keyed by canonical supplier name so OCR name variants
    // ("… Inc." vs "… Inc. - Vancouver") can't split one supplier into two.
    const offerSupplierName = session.supplierName
      ? await canonicalSupplierName(session.supplierId, session.supplierName)
      : null

    // ── Supplier offers, snapshotted ONCE before anything is written ─────────
    // An item's own chain is only its PRIMARY supplier's pack; every other
    // supplier's pack lives on that supplier's offer row. Read them up front so
    // (1) the split validation below, (2) the pack guard, (3) the price basis and
    // (4) the frozen receipt all read a line through the SAME format, and so the
    // guard compares against what we knew about this supplier BEFORE this invoice
    // (the upsert inside the loop must not become its own reference).
    const matchedItemIds = [...new Set(
      session.scanItems.map(si => si.matchedItemId).filter((v): v is string => !!v),
    )]
    const offerRows = matchedItemIds.length > 0
      ? await prisma.inventorySupplierPrice.findMany({
          where:  { inventoryItemId: { in: matchedItemIds } },
          select: { inventoryItemId: true, supplierId: true, supplierName: true, packChain: true, pricing: true },
        })
      : []
    const offersByItem = new Map<string, typeof offerRows>()
    for (const o of offerRows) {
      const list = offersByItem.get(o.inventoryItemId)
      if (list) list.push(o)
      else offersByItem.set(o.inventoryItemId, [o])
    }
    // pickOffer (supplierId first, then canonical name, then the raw OCR name) is
    // the SAME rule the review UI uses, so the totals it validates against and the
    // ones approve validates against can never disagree. Gated on a resolvable
    // supplier name: with none there is no offer row to write either, and the
    // legacy direct-spine path below must keep pricing over the item's own chain.
    const offerForLine = (matchedItemId: string | null): OfferFormat | null =>
      offerSupplierName && matchedItemId
        ? pickOffer(offersByItem.get(matchedItemId) ?? [], {
            supplierId:    session.supplierId,
            supplierName:  session.supplierName,
            canonicalName: offerSupplierName,
          })
        : null

    // The receiving-rule inputs of a scan line. Deliberately WITHOUT
    // receivedQtyBase: that column is this route's own output, and echoing it back
    // would make a re-approve freeze the stale value instead of recomputing it.
    const lineQtyOf = (scanItem: typeof session.scanItems[number]): LineQtyInput => ({
      rawQty:          scanItem.rawQty?.toString() ?? null,
      rawUnit:         scanItem.rawUnit,
      totalQty:        scanItem.totalQty?.toString() ?? null,
      totalQtyUOM:     scanItem.totalQtyUOM,
      rateUOM:         scanItem.rateUOM,
      invoicePackQty:  scanItem.invoicePackQty?.toString() ?? null,
      invoicePackSize: scanItem.invoicePackSize?.toString() ?? null,
      invoicePackUOM:  scanItem.invoicePackUOM,
      rawUnitPrice:    scanItem.rawUnitPrice?.toString() ?? null,
      rate:            scanItem.rate?.toString() ?? null,
      rawLineTotal:    scanItem.rawLineTotal?.toString() ?? null,
    })

    // The frozen receipt of every line this approval resolved, kept in memory so
    // the RC clones built at the end of the run can inherit it (they are created
    // from the in-memory scan items, and the parent row is excluded from stock by
    // splitToSessionId — so without this the countable copy recomputes forever).
    const frozenByLine = new Map<string, number>()
    // ONE form for "a receipt of nothing is not a receipt": null, never 0, so a
    // reader still knows to compute live rather than trusting a false zero.
    const freezeQty = (baseUnits: number, scanItemId: string): number | null => {
      if (!(baseUnits > 0)) return null
      frozenByLine.set(scanItemId, baseUnits)
      return baseUnits
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
      // Read the line through THIS supplier's pack — the same offer the review UI
      // validated the split against. Without it a non-primary supplier's total was
      // computed over the primary's pack, the two disagreed, and the user's split
      // was silently dropped (the line fell back to one revenue center).
      const { qty: total } = lineReceivedCountQty(
        lineQtyOf(scanItem), scanItem.matchedItem, offerForLine(scanItem.matchedItemId),
      )
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

        // ── Which pack does THIS line speak? ────────────────────────────────
        // `itemOffers` is every supplier offer on the item (pre-invoice snapshot);
        // `lineOffer` is this invoice's supplier's own row, if it has one. `speaks`
        // is the item read through that offer's pack — the item unchanged when the
        // supplier has no offer yet, so an item with a single supplier (or none)
        // behaves exactly as it always has.
        const itemOffers = offersByItem.get(scanItem.matchedItemId) ?? []
        const lineOffer  = offerForLine(scanItem.matchedItemId)
        const itemAsChain = asChainItem({
          dimension:       item.dimension,
          baseUnit:        item.baseUnit ?? 'each',
          packChain:       item.packChain,
          pricing:         item.pricing,
          countUnit:       item.countUnit ?? undefined,
          eachMeasureQty:  item.eachMeasureQty,
          eachMeasureUnit: item.eachMeasureUnit,
          densityGPerMl:   item.densityGPerMl,
        })
        const speaks = resolveLineFormat(itemAsChain, lineOffer)

        // How the line was RECEIVED decides how it is PRICED (pricingBasisFor).
        const received = lineReceived(lineQtyOf(scanItem), speaks)
        const pricedByWeight = received.via === 'billed-weight' || received.via === 'shipped-unit'

        // The line's pricing mode comes straight from the OCR (per_case /
        // per_weight). per_weight → RATE pricing, otherwise PACK. There is no
        // "mode mismatch" to resolve — the offer's mode is authoritative.
        //
        // …except that on an item with an each-measure, "the line prints a weight"
        // does not say which of TWO things the weight is, and the two need opposite
        // prices:
        //   • Brioche, `1 CS` whose pack prints "8 × 1100 g": the weight is the SIZE
        //     of one each. The price is a CASE price, and ppb is $/case ÷ each per
        //     case, off the item's own count chain — like any other count item.
        //   • Eggplant, `12 lb @ $3.49/lb`: the weight is the QUANTITY SOLD. $3.49 is
        //     a rate; dividing it by 24 each per case priced an eggplant at $0.145
        //     instead of $3.49 × 0.4 lb = $1.396 — ~10× low, and it used to hide
        //     behind an equally wrong quantity.
        // Line-first receiving already tells them apart, from the line's own money
        // (`billedWeightIsPriced`): Brioche arrives via `printed-pack`, eggplant via
        // `billed-weight` / `shipped-unit`. So ask it rather than assuming — that is
        // the whole of pricingBasisFor, and it keeps `received quantity × price =
        // line total` true by construction. The old rule ("a bridged COUNT item is
        // ALWAYS a count purchase") lives on inside it as the non-weight branch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemBridge = eachMeasureOf(item as any)
        const isUomMode = pricingBasisFor({
          via: received.via,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ocrPerWeight: derivePricingMode(scanItem as any) === 'per_weight',
          itemHasEachMeasure: !!itemBridge,
        }) === 'WEIGHT'

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
        //
        // On a line RECEIVED by weight the rate is not always printed in its own
        // column: `12 lb @ $3.49` can carry $3.49 only as rawUnitPrice (OCR derives
        // that field as lineTotal ÷ qtyShipped, which on a weight-shipped line IS
        // the $/weight rate). Prefer it over the stored newPrice there, for the
        // same reason the CASE path already does.
        //
        // In WEIGHT mode this is only the STARTING point: `scanItem.rate` is
        // whatever OCR read out of a price column and may be a per-CASE price
        // wearing `rateUOM: 'CS'`. weightBasisRate (below, once the rate's unit
        // is resolved) decides whether to trust it or derive the rate from the
        // line total — a per-case rate must never be denominated in pounds.
        let newPurchasePrice = isUomMode
          ? (scanItem.rate != null ? Number(scanItem.rate)
            : (pricedByWeight && scanItem.rawUnitPrice != null) ? Number(scanItem.rawUnitPrice)
            : Number(scanItem.newPrice))
          : (scanItem.rawUnitPrice != null ? Number(scanItem.rawUnitPrice) : Number(scanItem.newPrice))

        let newPricePerBase: number
        // The ppb the SPINE write will derive — `pricing` over the ITEM's chain.
        // Only set on the CASE path, where newPricePerBase may sit on THIS
        // supplier's offer chain instead (see casePricePerBase). Null elsewhere
        // means "newPricePerBase already is the written value" — the UOM/rate and
        // reverse-bridge paths derive from the rate, not from any chain.
        let spineNewPpb: number | null = null
        let density = 0
        // The RATE's resolved unit (only meaningful in UOM mode) — captured here
        // so the chain `pricing` below can store { mode:'RATE', rate, rateUnit }.
        // This 'kg' default is ONLY meaningful inside the isUomMode branch (the
        // density-cross check reads it there); do not rely on it outside that branch.
        let resolvedRateUnit = 'kg'
        // The item as the RATE must be read against: its own bridges, plus the
        // density this block resolves (below) when the rate crosses weight↔volume.
        // Shared with the dimension guard so the price and the check can never
        // disagree about whether this rate is costable at all.
        let itemForRate = itemAsChain
        if (isUomMode) {
          // newPurchasePrice is a rate ($/kg, $/lb…). Divide by the RATE's OWN
          // unit — the scan line's rateUOM — not the physical pack unit. A
          // catch-weight item packed in pieces has packUOM='each' (conv 1),
          // which left the rate unconverted and inflated cost 1000×.
          // Canonical test ('LBS', 'pounds', '#' are all lb) — the same one
          // `weightBasisRate` and the receiving rule use, so they cannot disagree.
          const wv = (u: string | null | undefined) => isMeasureUnit(u)
          // Fallback when the line carries no usable rateUOM: on a line RECEIVED by
          // weight, the unit the RECEIPT was read in (totalQtyUOM, then the shipped
          // unit) — that is the denominator the money invariant needs, since
          // `received.base` came from exactly that unit. Only then the item's own
          // base unit (a measured base IS the rate denominator for a UOM item).
          const rateUnit = wv(scanItem.rateUOM) ? scanItem.rateUOM!
            : (pricedByWeight && wv(scanItem.totalQtyUOM)) ? scanItem.totalQtyUOM!
            : (pricedByWeight && wv(scanItem.rawUnit)) ? scanItem.rawUnit!
            : wv(item.baseUnit) ? item.baseUnit!
            : 'kg'
          // Store the CANONICAL token ('lb', not the line's 'LB'): every reader
          // canonicalises before converting (getUnitConv / dimensionOf both go
          // through canonicalUom), so no computed number moves — but the stored
          // `pricing.rateUnit` is what the item drawer prints as "$15.98 / lb".
          resolvedRateUnit = canonicalUom(rateUnit) || rateUnit
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
            itemForRate = { ...itemAsChain, densityGPerMl: density }
          }
          // ── Is the "rate" actually a rate PER THIS UNIT? ────────────────────
          // Only on a line RECEIVED by weight, where the line's own money fixes
          // the answer (`received.base` came out of the weight the invoice
          // billed). A `1 CS @ 41.88` line shipped as "12 LB" carries rate 41.88
          // with rateUOM 'CS' — a per-CASE price that would otherwise be written
          // as $41.88 per POUND. Everything else (via 'rate' / 'item-pack' /
          // 'printed-pack' — the bison family) keeps today's value untouched.
          if (pricedByWeight) {
            newPurchasePrice = weightBasisRate({
              rate:         scanItem.rate != null ? Number(scanItem.rate) : null,
              rateUOM:      scanItem.rateUOM,
              rawLineTotal: scanItem.rawLineTotal != null ? Number(scanItem.rawLineTotal) : null,
              receivedBase: received.base,
              rateUnit:     resolvedRateUnit,
              item:         itemForRate,
              fallback:     newPurchasePrice,
            }).rate
          }
          // ONE formula for $/rateUnit → $/base (item-model's `ratePerBase`): the
          // same-dimension divide, the each-measure bridge that prices $3.49/lb as
          // $1.396/each, and the density cross — so the spine, the offer and every
          // reader derive this number identically. 0 means "unpriced" and is caught
          // by the guards below; it is never `rate ÷ conv` wearing the wrong label.
          newPricePerBase = ratePerBase(newPurchasePrice, resolvedRateUnit, itemForRate)
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
          // The invoice updates the item's PRICE over a STORED chain; it never
          // silently rewrites a pack FORMAT (that's a deliberate inventory edit).
          // So the per-case price always divides by the base units in one top
          // container of a chain we already hold — this supplier's offer, else the
          // item's. This matches the DELETE-revert path (also derived from `pricing`).
          //
          // …but only while the invoice's case and the item's case hold the SAME
          // amount. When a supplier changes pack size (a 3 kg tub becomes a 20 kg
          // case) that assumption silently breaks and the raw case price over the
          // stale chain is wrong by exactly the ratio of the two packs — the price
          // moves, the format doesn't. Nothing used to catch it: only a DIMENSION
          // conflict blocks approve, and 3 kg → 20 kg is the same dimension. That
          // is how Baking Powder came to cost $37.61/kg instead of $5.64/kg.
          //
          // We cannot repair it by preferring the invoice's pack either: OCR often
          // reports packQty 1 when the invoice prints only the container size, so
          // the line understates a case the item has right (Tamari's 6 × 1.89 L
          // case prints as "1 × 1.89 l"). Either side can be the stale one and the
          // data does not say which. Refuse to guess — skip the price write and
          // leave the line un-approved for a human, exactly like the dimension
          // conflict above. A wrong spine price silently corrupts every recipe
          // that reads this item; a skipped line is visible and recoverable.
          //
          // …but the reference is THIS SUPPLIER's pack, not the item's. The item's
          // chain is only the PRIMARY supplier's; checking every line against it
          // flagged the ordinary fact that a second supplier sells a different case
          // as a format change, and skipping those lines is what drove users to
          // create a duplicate item per supplier. packReference picks the honest
          // comparator: this supplier's previous pack, the item's when it has no
          // offers at all (unchanged behaviour), and nothing for a supplier we have
          // never seen on this item — whose pack simply becomes their new offer.
          const invoiceBaseTotal = invoicePackBaseTotal(
            {
              packQty:  scanItem.invoicePackQty  != null ? Number(scanItem.invoicePackQty)  : null,
              packSize: scanItem.invoicePackSize != null ? Number(scanItem.invoicePackSize) : null,
              packUOM:  scanItem.invoicePackUOM,
            },
            item.baseUnit ?? 'each',
          )
          // "Item has offers" only silences the guard for a KNOWN supplier never seen on
          // this item. With no resolvable supplier, lineOffer is always null AND this path
          // still re-prices the item (legacy direct write) — so it must keep the old check
          // against the item's own chain, or a changed case is written over a stale pack.
          const ref = packReference((item.packChain as PackLink[]) ?? [], lineOffer, !!offerSupplierName && itemOffers.length > 0)
          const packs = ref ? packFormatsDisagree(invoiceBaseTotal, ref.baseTotal) : { disagree: false, ratio: 1 }
          if (packs.disagree) {
            console.error(
              `[approve] Skipping price write for "${scanItem.rawDescription}" — the invoice's pack ` +
              `(${scanItem.invoicePackQty} × ${scanItem.invoicePackSize} ${scanItem.invoicePackUOM} = ` +
              `${invoiceBaseTotal} ${item.baseUnit}) disagrees with the ` +
              `${ref!.against === 'offer' ? "supplier's previous" : "item's stored"} format ` +
              `(${ref!.baseTotal} ${item.baseUnit}) by ${packs.ratio.toFixed(2)}×. Pricing against either ` +
              `would be wrong by that factor. Update the item's pack format, or correct the line's pack, ` +
              `then re-approve.`,
            )
            skippedLines++
            continue
          }

          // Per-case price ÷ the base units in one container of the pack this line
          // speaks: the supplier's own chain when they have an offer, else the
          // item's (so a single-supplier item is bit-for-bit unchanged). A
          // non-primary supplier's $/base used to come out over the PRIMARY's pack
          // — wrong by exactly the ratio between the two cases.
          //
          // NB the invoice's own printed pack is deliberately NOT the denominator,
          // even though it drives the received QUANTITY. This value is compared
          // against the item's current ppb to raise the PriceAlert, and the spine
          // write below stores `pricing` over the item's chain; dividing by the
          // printed pack would make the alert disagree with the price written
          // whenever OCR's pack differs but stays inside the guard's tolerance.
          newPricePerBase = casePricePerBase(speaks, newPurchasePrice)
          // …and what the spine write itself will derive, over the item's own
          // chain. The two differ only when this line's supplier offer has a
          // different pack AND ensurePrimary is about to promote it (the item's
          // very first offer): the alert must quote the price actually written,
          // not this supplier's offer ppb.
          spineNewPpb = casePricePerBase(itemAsChain, newPurchasePrice)
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
        // checked here. Weight↔volume is tolerated (the density resolved above is
        // on itemForRate, ≈1 at worst); the genuine catastrophe is a $/kg (or $/L)
        // rate landing on a COUNT/each item with NO each-measure to bridge it.
        // `rateIsCostable` is the very predicate `ratePerBase` priced through, so a
        // rate this guard lets past can never price as 0 for a bridge reason — and
        // a COUNT item WITH an each-measure now passes, which is the point.
        if (isUomMode && item.baseUnit &&
            !rateIsCostable(resolvedRateUnit, itemForRate)) {
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
        // and the NEW ppb. The stored previousPrice/newPrice/changePct are
        // therefore internally consistent and agree across every inbox renderer
        // (some re-derive % from the two prices, some show the stored %). The old
        // path stored a per-base previousPrice next to a per-CASE newPrice and a
        // separately-computed scanItem.priceDiffPct, so the three disagreed and
        // the displayed percentages were nonsense.
        //
        // `writtenPpb` — not `newPricePerBase` — is that NEW ppb: the alert only
        // ever fires on the re-pricing path, and the spine write stores `pricing`
        // over the ITEM's chain, while newPricePerBase may sit on this supplier's
        // offer chain (see casePricePerBase / spineNewPpb above). Quoting the
        // offer's ppb next to the item's oldPpb would state a % the item never moved.
        //
        // Read through `itemAsChain`, never a hand-built ChainItem: that one
        // carried no BRIDGES, and an item whose own pricing is a bridged RATE
        // (`$3.49/lb` on an item counted in `each` — what this route can now write)
        // would read 0 there. An oldPpb of 0 silently suppresses the PriceAlert and
        // reports a 0 % change on a price that moved.
        const oldPpb = pricePerBaseUnit(itemAsChain)
        const writtenPpb = spineNewPpb ?? newPricePerBase
        const changePct = oldPpb > 0 ? ((writtenPpb - oldPpb) / oldPpb) * 100 : 0
        if (scanItem.matchedItemId) priorPpbByItem.set(scanItem.matchedItemId, oldPpb)

        // ── Write the item's pricing (the spine) ────────────────────────────
        // `pricing` follows the line's mode: per_weight → RATE{rate,rateUnit};
        // otherwise PACK{purchasePrice}. The item's pack FORMAT (packChain/
        // dimension/countUnit) is its canonical structure and is NEVER rewritten
        // by an invoice — ppb derives from `pricing` over the item's stored
        // chain. Changing an item's format is a deliberate inventory edit.
        const newPricing: Pricing = isUomMode
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
          //
          // …with ONE exception, new with the weight/case split above: a line
          // RECEIVED BY WEIGHT on a bridged COUNT item has no pack to build from —
          // its "pack" (`12 lb`) is the quantity sold. Running it through
          // formToChain's RATE branch would mint a COUNT chain of `1 × 12 lb =
          // 5443 each per case`, which is nonsense for counting and would land on
          // the ITEM if this offer were ever made primary by hand. The rate is what
          // this line proves; the pack is not. So keep the chain we already hold
          // (this supplier's, else the item's) and store only the RATE over it —
          // the printed pack still survives in the offerPack provenance triple.
          //
          // ONLY when the rate crosses the item's dimension, though (the first
          // cut keyed on "the item has an each-measure", which also caught a
          // MASS item that merely carries a count bridge — Sausage at $15.95/kg
          // on a `g` item, whose printed pack IS a pack in the item's own units;
          // its offer chain then stopped refreshing from the line and, with no
          // prior offer chain, stored an empty one that reads $0).
          const lineQtyIsNotAPack = packIsTheQuantity({
            isUomMode, rateUnit: resolvedRateUnit, item: { dimension: item.dimension, baseUnit: item.baseUnit },
          })
          // The chain we already hold for THIS supplier, else the item's.
          const heldChain = (Array.isArray(lineOffer?.packChain) && (lineOffer!.packChain as PackLink[]).length
            ? (lineOffer!.packChain as PackLink[])
            : itemChain)
          const offerChain = (reverseBridge && reverseBasePerCase > 0)
            // Reverse bridge: the offer is a measured purchase — 1 container =
            // reverseBasePerCase base units. A single PACK link reproduces the
            // spine ppb (offerLastPrice ÷ reverseBasePerCase == newPricePerBase).
            ? {
                packChain: [{ unit: itemTopUnit ?? scanItem.rawUnit ?? 'case', per: reverseBasePerCase }] as PackLink[],
                pricing: { mode: 'PACK' as const, purchasePrice: offerLastPrice },
              }
            : (hasLinePack && !lineQtyIsNotAPack)
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
                // No printed pack (or a printed "pack" that is really the quantity
                // sold): keep what we already know about THIS supplier's pack.
                // Falling back to the item's chain here used to erase it —
                // one pack-less invoice from a secondary supplier overwrote their
                // real case with the primary's, and their offer ppb (and every
                // cross-supplier comparison built on it) moved by that ratio. Only
                // a supplier we have no chain for falls back to the item's.
                // Pricing follows the resolved mode over the offer's last price.
                // CASE: PACK over that chain. UOM: RATE over the resolved rate unit.
                //
                // …and in UOM mode never an EMPTY chain: offerPricePerBase reads
                // one as "unpriced" ($0), so a supplier with no chain anywhere (on
                // an item whose own chain is empty too) would store a RATE nobody
                // can read. One nominal container stands in — with RATE pricing the
                // chain is not a divisor. CASE mode is left exactly as it was: there
                // the chain IS the divisor and inventing one would invent a price.
                packChain: isUomMode
                  ? nonEmptyOfferChain(heldChain, itemTopUnit ?? scanItem.rawUnit ?? 'case')
                  : heldChain,
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

        // ── Freeze the receipt ──────────────────────────────────────────────
        // How many base units this line actually delivered, resolved through the
        // pack it speaks AND the pricing mode this approval writes (freezeFormat —
        // `speaks` still carries the PRE-write mode, which reads a per-weight line
        // on a case-priced item as a count of cases). Stored on the row as a
        // point-in-time QUANTITY, exactly like CountLine.countedQtyBase, never a
        // cost. Readers recompute it live only while it is null, so a later format
        // edit (or a supplier changing their case) can no longer retroactively
        // rewrite what a past invoice received. Recomputed on every approve —
        // lineQtyOf deliberately omits the stored value — so a re-approve corrects
        // a bad freeze rather than echoing it.
        const receivedQtyBase = freezeQty(
          lineReceivedBaseUnits(lineQtyOf(scanItem), freezeFormat(speaks, newPricing)),
          scanItem.id,
        )

        // ── Write the item spine (only when re-pricing) + mark approved ──────
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemOps: any[] = [
          prisma.invoiceScanItem.update({
            where: { id: scanItem.id },
            data:  { approved: true, receivedQtyBase },
          }),
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
                  newPrice:        writtenPpb,
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
          data: {
            matchedItemId: created.id,
            approved: true,
            // Freeze the receipt against the item this line just created — its
            // chain is the only format the line has ever been read through, its
            // `pricing` already carries the line's resolved mode, and there is no
            // supplier offer yet to resolve it against.
            receivedQtyBase: freezeQty(
              lineReceivedBaseUnits(lineQtyOf(scanItem), asChainItem(created)),
              scanItem.id,
            ),
          },
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
    const approvedNow = new Date()
    await prisma.invoiceSession.update({
      where: { id: sessionId },
      data: {
        status: 'APPROVED',
        approvedBy,
        approvedAt: approvedNow,
        // Reporting date = the invoice's own date (falls back to approval time).
        // ALL purchase-spend reporting windows on this. See src/lib/purchase-date.ts.
        purchaseDate: resolvePurchaseDate(session.invoiceDate, approvedNow),
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
        // The COPY is the countable row (the parent is excluded by
        // splitToSessionId), so the frozen receipt has to travel with it — scaled
        // by the same factor as the quantities it was derived from, which keeps
        // Σ copies == the parent's receipt. Null when the parent was never frozen
        // (an un-processed or zero-quantity line): readers then compute live.
        const frozen = frozenByLine.get(item.id)
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
          receivedQtyBase: frozen != null ? frozen * factor : null,
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
            approvedAt:      approvedNow,
            // Clone's scan items (splitToSessionId=null) are the ones counted by
            // periodPurchases — it must carry the same reporting date as its parent.
            purchaseDate:    resolvePurchaseDate(session.invoiceDate, approvedNow),
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
  // even after the response has been sent to the client. Approving writes purchases
  // (new stock), so drop the theoretical-stock cache once it lands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitUntil(
    doApprove(params.id, approvedBy, session as any)
      .then(() => invalidateTheoreticalCache())
      .catch(() => {}),
  )

  return NextResponse.json({ ok: true, queued: true })
}
