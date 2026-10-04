import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { prisma } from '@/lib/prisma'
import { recalculateRecipeCosts } from '@/lib/recipe-costs'
import { ensurePrimary } from '@/lib/primary-offer'
import { propagatePrepCostChanges } from '@/lib/recipeCosts'
import { saveAlias } from '@/lib/invoice-matcher'
import { normaliseAliasText } from '@/lib/alias-text'
import { canonicalSupplierName } from '@/lib/supplier-offers'
import { invalidateTheoreticalCache } from '@/lib/theoretical-cache'
import { formToChain } from '@/lib/item-model-form'
import { lastCost, listedPrice } from '@/lib/cost-basis'
import { offerListedPrice } from '@/lib/offer-price'
import { asChainItem, eachMeasureOf, PRICING_SELECT, type PackLink } from '@/lib/item-model'
import { lineReceivedCountQty, lineReceivedBaseUnits, type LineQtyInput } from '@/lib/invoice/line-qty'
import { shouldRepriceItem, primaryBoxWrite } from '@/lib/invoice/reprice'
import { pickOffer, supplierOffers, type OfferFormat } from '@/lib/invoice/line-format'
import { packIsTheQuantity, nonEmptyOfferChain } from '@/lib/invoice/approve-format'
import { canonicalUom } from '@/lib/uom'
import { createNewName } from '@/lib/invoice/create-new-seed'
import { decideLinePrice, approveBlocks, createNewRefusal, createNewChain, implausibleMessage, type ApproveLineInput, type ApproveItemInput, type BlockedLine } from '@/lib/invoice/approve-outcome'
import { buildApproveNote, type NoteLine } from '@/lib/invoice/approve-note'
import { learnAlias } from '@/lib/supplier-matcher'
import { UndoCollector, OFFER_SELECT, offerState, itemState, offerCaptureFor } from '@/lib/invoice/approve-undo'
import { requireSession, AuthError } from '@/lib/auth'
import { assertRcWritable } from '@/lib/rc-scope'
import { resolvePurchaseDate } from '@/lib/purchase-date'

// Give background work up to 60s after the response is sent
export const maxDuration = 60


/** The pack printed/confirmed on a line, as the alias learns it (display and
 *  provenance only — costing always reads the chain). None without a qty and size. */
function packTripleOf(line: { invoicePackQty: unknown; invoicePackSize: unknown; invoicePackUOM: string | null }) {
  if (!line.invoicePackQty || line.invoicePackSize == null) return null
  return { packQty: Number(line.invoicePackQty), packSize: Number(line.invoicePackSize), packUOM: line.invoicePackUOM ?? 'each' }
}

interface ApproveResult {
  itemsUpdated: number
  newItemsCreated: number
  priceAlerts: number
  recipeAlerts: number
  skippedLines: number
  receivedWithoutPrice: number
}

type ApproveSession = { id: string; revenueCenterId: string | null; supplierName: string | null; supplierId: string | null; invoiceDate: string | null; invoiceNumber: string | null; scanItems: Array<{ id: string; action: string; matchedItemId: string | null; matchedItem: { id: string; itemName: string; dimension: string; baseUnit: string | null; packChain: any; pricing: any; countUnit: string | null; eachMeasureQty: any; eachMeasureUnit: string | null; densityGPerMl?: unknown; purchasePrice?: unknown } | null; newPrice: any; previousPrice: any; priceDiffPct: any; rawDescription: string; rawQty: any; rawUnit: string | null; rawUnitPrice: any; pricingMode: string | null; rawLineTotal: any; invoicePackQty: any; invoicePackSize: any; invoicePackUOM: string | null; totalQty: any; totalQtyUOM: string | null; rate: any; rateUOM: string | null; revenueCenterId: string | null; rcSplit: any; sortOrder: number; newItemData: string | null; matchConfidence: any; matchScore: any; supplierItemCode: string | null }> }

/**
 * The supplier offers of every matched item, read ONCE — by the preflight, and
 * handed to the run so it reads exactly what the preflight judged.
 *
 * An item's own chain is only its PRIMARY supplier's pack; every other
 * supplier's pack lives on that supplier's offer row. Read them up front so
 * (1) the split validation, (2) the pack guard, (3) the price basis and (4) the
 * frozen receipt all read a line through the SAME format, and so the guard
 * compares against what we knew about this supplier BEFORE this invoice (the
 * upsert inside the loop must not become its own reference).
 *
 * Offers are keyed by `supplierId`, so OCR name variants ("… Inc." vs
 * "… Inc. - Vancouver") can't split one supplier into two. `offerSupplierName`
 * is the display name an offer row carries (provenance only): a linked supplier
 * always has a name even when OCR read none, an unlinked one keeps the raw OCR
 * text (or null).
 */
async function loadApproveSnapshot(session: { supplierId: string | null; supplierName: string | null; scanItems: Array<{ matchedItemId: string | null }> }) {
  const offerSupplierName = session.supplierId
    ? await canonicalSupplierName(session.supplierId, session.supplierName ?? '')
    : (session.supplierName ?? null)
  const matchedItemIds = [...new Set(
    session.scanItems.map(si => si.matchedItemId).filter((v): v is string => !!v),
  )]
  const offerRows = matchedItemIds.length > 0
    ? await prisma.inventorySupplierPrice.findMany({
        where:  { inventoryItemId: { in: matchedItemIds } },
        // packQty/Size/UOM: display only — the blocked-line message quotes a box
        // as its supplier printed it ("a case of 4 × 1 lb"). Costing reads the chain.
        select: { id: true, inventoryItemId: true, supplierId: true, supplierName: true, supplierItemCode: true, isPrimary: true, packChain: true, pricing: true, packQty: true, packSize: true, packUOM: true },
      })
    : []
  const offersByItem = new Map<string, typeof offerRows>()
  for (const o of offerRows) {
    const list = offersByItem.get(o.inventoryItemId)
    if (list) list.push(o)
    else offersByItem.set(o.inventoryItemId, [o])
  }
  return { offerRows, offersByItem, offerSupplierName }
}
type ApproveSnapshot = Awaited<ReturnType<typeof loadApproveSnapshot>>

/** The reviewer's per-line choices, kept only for lines of THIS session (unknown/foreign ids ignored). */
function lineIdSet(raw: unknown, lineIds: Set<string>): Set<string> {
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && lineIds.has(v)) : [])
}

async function doApprove(
  sessionId: string,
  approvedBy: string,
  session: ApproveSession,
  snapshot: ApproveSnapshot,
  choices: { receiveWithoutPrice: Set<string>; priceConfirmed: Set<string> },
): Promise<ApproveResult> {
  let priceAlertsCreated = 0
  let newItemsCreated = 0
  let skippedLines = 0
  // A skipped CREATE_NEW is a DIFFERENT failure from a skipped price write: no
  // product was created at all, so "price not updated" would describe a row that
  // does not exist. Collected separately so the session message can say which.
  const skippedCreateNew: string[] = []
  // A create-new refused for its name (an invoice wording, or blank) — the
  // session's note then says to scan it again with a plain name.
  let createNewNameRefused = false
  // Lines received with the price left as it was — the reviewer's choice, or the
  // write side's fallback when a line's data moved after the preflight passed:
  // no approval path may leave a delivery unreceived. And priced lines that
  // could not be received at all (nothing to receive; race-only).
  const receivedWithoutPrice: NoteLine[] = []
  const skippedPrice: NoteLine[] = []
  // CREATE_NEW line → the product it created, so its RC copy carries it.
  const createdByLine = new Map<string, string>()
  // Every line this run marked approved (priced, received without its price,
  // created, or a plain approve). Only these are copied into an RC clone: a
  // SKIP/PENDING line, or a priced line that was neither received nor priced,
  // must never land in a clone as an approved row.
  const approvedLines = new Set<string>()
  // Lines received without their price because their printed case disagreed with
  // the box: the supplier's wording is still learned, but never with that case.
  const disputedPack = new Set<string>()
  try {
    // ── Undo records ────────────────────────────────────────────────────────
    // What this approval overwrites, captured per row BEFORE its first write and
    // re-read after its last, so DELETE can put it back. Pure bookkeeping: it
    // only ever READS around the writes below — no existing payload or order
    // changes. Idempotency (same rule as the prior-clone cleanup further down):
    // a reset → re-approve must REPLACE the previous run's records, and the
    // cleanup has to precede the first flush, so it runs here rather than beside
    // the clone block (which executes after the per-line loop and would delete
    // the records this run just wrote).
    const undo = new UndoCollector(sessionId)
    await prisma.invoiceApproveUndo
      .deleteMany({ where: { sessionId } })
      .catch((e) => console.error(`[approve-undo] session ${sessionId}: cleanup failed:`, e))
    // Never let bookkeeping fail an approval (the table may not exist yet on an
    // un-migrated deploy): a lost record degrades DELETE to its legacy path.
    const flushUndo = () => undo.flush().catch((e) => console.error(`[approve-undo] session ${sessionId}: flush failed:`, e))

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
    // Every RC gets a membership; only non-default RCs get an allocation row
    // (default RC reads global stockOnHand) — see the upsert loop below.
    const registerAlloc = (itemId: string | null, lineRcId: string | null) => {
      const rcId = lineRcId ?? effectiveSessionRcId
      if (itemId && rcId) allocPairs.push({ itemId, rcId })
    }

    const { offersByItem, offerSupplierName } = snapshot

    // pickOffer (keyed on supplierId — an unlinked session has no offer) is
    // the SAME rule the review UI uses, so the totals it validates against and the
    // ones approve validates against can never disagree. Gated on a linked
    // supplier (supplierId): with none there is no offer row to write either, and
    // the legacy direct-spine path below must keep pricing over the item's own chain.
    // The line's SKU picks among one supplier's several products on a merged item.
    const offerForLine = (matchedItemId: string | null, itemCode: string | null): OfferFormat | null =>
      session.supplierId && matchedItemId
        ? pickOffer(offersByItem.get(matchedItemId) ?? [], {
            supplierId:    session.supplierId,
            supplierName:  session.supplierName,
            canonicalName: offerSupplierName,
            itemCode,
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
        lineQtyOf(scanItem), scanItem.matchedItem, offerForLine(scanItem.matchedItemId, scanItem.supplierItemCode),
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
      // Gated on the match alone (not on a stored newPrice): a priced line with
      // no price at all used to fall through every branch — never approved,
      // never counted (Limes). decideLinePrice now refuses it like any other.
      if (
        (scanItem.action === 'UPDATE_PRICE' || scanItem.action === 'ADD_SUPPLIER') &&
        scanItem.matchedItemId && scanItem.matchedItem
      ) {
        const item = scanItem.matchedItem

        // ── ONE per-line decision (src/lib/invoice/approve-outcome.ts) ──────
        // The review screen, the preflight in POST and this write all read the
        // line through decideLinePrice, so they can never disagree about whether
        // it is priced, refused, or can only be received. It owns: which pack
        // the line speaks (this supplier's box, else the item), how it was
        // received (line-first) and so how it is priced (pricingBasisFor), the
        // unit an unlabelled weight is read in (weightUnitFor), the density
        // cross, weightBasisRate, the reverse bridge, the CASE-path pack guard
        // (packReference — THIS supplier's previous pack), the uncostable-rate
        // and no-price guards, and the quantity to freeze (freezeFormat).
        // `itemOffers` is every supplier offer on the item (pre-invoice
        // snapshot); `lineOffer` is this invoice's supplier's own row, if any.
        const itemOffers = offersByItem.get(scanItem.matchedItemId) ?? []
        const lineOffer  = offerForLine(scanItem.matchedItemId, scanItem.supplierItemCode)
        const d = decideLinePrice({
          line:               scanItem as ApproveLineInput,
          item:               item as ApproveItemInput,
          lineOffer,
          itemHasOffers:      itemOffers.length > 0,
          sessionHasSupplier: !!session.supplierId,
          supplierName:       offerSupplierName,
        })
        const noteLine = (message: string): NoteLine => ({ description: scanItem.rawDescription, itemName: item.itemName, message })

        // ── Receive the stock, keep the old price ───────────────────────────
        // A refused line with stock to receive (the reviewer chose it, or the
        // data moved after the preflight passed), or a price 20× off that the
        // reviewer did not confirm. The delivery lands; nothing about the price
        // moves: no offer upsert, no ensurePrimary, no spine write, no
        // PriceAlert — and so no undo record (the scan rows themselves go with
        // the session on DELETE). Read through the PRE-write format: no price is
        // written, so the line's own box is still the one it speaks.
        const unconfirmed = d.ok && !!d.implausible && !choices.priceConfirmed.has(scanItem.id)
        if (!d.ok || unconfirmed) {
          const receiveBase = d.ok ? d.received.base : d.receiveBase
          // `d.receivable` (not just "receiveBase > 0"): a weight the item has
          // no bridge to falls back to counting cases — Eggplant "12 lb" would
          // go in as 12 cases = 288 each. That is never received.
          const canReceive = d.ok ? receiveBase > 0 && !d.received.needsBridge : d.receivable
          const message = d.ok
            ? implausibleMessage({
                newPricePerBase: d.newPricePerBase, currentPpb: d.implausible!.currentPpb, ratio: d.implausible!.ratio,
                baseUnit: item.baseUnit ?? 'each', itemName: item.itemName, supplierName: offerSupplierName,
                boxIsSuppliers: !!lineOffer && d.speaks.pricing === lineOffer.pricing, assumed: d.implausible!.assumed,
              })
            : d.message
          if (!canReceive) {
            // Nothing (honest) to receive either: the line stays un-approved,
            // visible. The preflight refuses this first; only reachable on a race.
            console.error(`[approve] Not approving "${scanItem.rawDescription}" — ${message}`)
            skippedLines++
            skippedPrice.push(noteLine(message))
            continue
          }
          if (!choices.receiveWithoutPrice.has(scanItem.id)) {
            console.error(`[approve] Receiving "${scanItem.rawDescription}" without a price change (it changed after the check) — ${message}`)
          }
          await prisma.invoiceScanItem.update({
            where: { id: scanItem.id },
            data:  { approved: true, receivedQtyBase: freezeQty(receiveBase, scanItem.id) },
          })
          approvedLines.add(scanItem.id)
          if (!d.ok && d.reason === 'PACK_DISAGREES') disputedPack.add(scanItem.id)
          receivedWithoutPrice.push(noteLine(message))
          registerLineAllocs(scanItem.matchedItemId, scanItem)
          continue
        }

        const {
          isUomMode, reverseBridge, reverseBasePerCase, newPurchasePrice,
          newPricePerBase, spineNewPpb, density, resolvedRateUnit, newPricing,
        } = d
        // The each-measure bridge decides how the offer chain below is built.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const itemBridge = eachMeasureOf(item as any)

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
        // Read through the item ROW (via `lastCost`, same normalisation as
        // `itemChainOf` in approve-outcome), never a hand-built ChainItem: that one
        // carried no BRIDGES, and an item whose own pricing is a bridged RATE
        // (`$3.49/lb` on an item counted in `each` — what this route can now write)
        // would read 0 there. An oldPpb of 0 silently suppresses the PriceAlert and
        // reports a 0 % change on a price that moved.
        const oldPpb = lastCost({ ...item, baseUnit: item.baseUnit ?? 'each', countUnit: item.countUnit ?? undefined })
        const writtenPpb = spineNewPpb ?? newPricePerBase
        const changePct = oldPpb > 0 ? ((writtenPpb - oldPpb) / oldPpb) * 100 : 0
        if (scanItem.matchedItemId) priorPpbByItem.set(scanItem.matchedItemId, oldPpb)

        // ── Write the item's pricing (the spine) ────────────────────────────
        // `pricing` (d.newPricing) follows the line's mode: per_weight →
        // RATE{rate,rateUnit}; otherwise PACK{purchasePrice}. The item's pack
        // FORMAT (packChain/dimension/countUnit) is its canonical structure and is
        // NEVER rewritten by an invoice — ppb derives from `pricing` over the
        // item's stored chain. Changing an item's format is a deliberate inventory edit.
        // The top container name comes from the item's own stored chain — used by
        // the per-supplier offer chain below (no legacy-column reads).
        const itemTopUnit = (item.packChain as PackLink[] | null)?.[0]?.unit

        // Upsert this supplier's offer: their last price, their pack format
        // (post-review resolved values), their SKU. Non-critical, outside the
        // transaction. Unique (inventoryItemId, supplierId, supplierItemCode)
        // replaced the old findFirst/create dance.
        //
        // PRICE DENOMINATION: the offer's price (its pricing) must be the
        // supplier's own price over the pack format stored on this same row —
        // the matcher divides one by the other next invoice. UOM mode: the rate
        // ($/uom). CASE mode: the case price as printed (rawUnitPrice), NOT
        // newPrice (which may have been normalized into the ITEM's purchase format).
        let writtenOfferId: string | null = null
        // An offer row needs a linked supplier (supplierId is NOT NULL). An invoice whose supplier is not linked re-prices the item only when it has no boxes (legacy direct spine write below) — link the supplier on the review screen to record its box.
        if (session.supplierId) {
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

          // Undo: the offer row as it stands BEFORE this upsert (absent → the
          // upsert creates it, recorded below once its id is known). The read
          // is wrapped in `.catch` so a transient failure never fails the
          // approval — but a failed read must NOT be treated as "no existing
          // row": the upsert below still runs and may UPDATE a pre-existing
          // offer, and recording that as a `created()` (prev: null) would let
          // a later rollback DELETE an offer this invoice never created.
          // `offerReadOk` tracks the read outcome separately so a failure
          // records nothing at all for this offer this run.
          //
          // Which row: this supplier's offer for THIS product. Offers are unique
          // per (item, supplier, SKU) — a merged item keeps one per SKU — and
          // pickOffer is the same rule the guard and the receipt read through.
          // Read live, not from the snapshot, so a second line of a new SKU on
          // this same invoice updates the row the first one created.
          let offerReadOk = true
          const existingOffer = await prisma.inventorySupplierPrice.findMany({
            where:  { inventoryItemId: scanItem.matchedItemId, supplierId: session.supplierId },
            select: { id: true, supplierName: true, ...OFFER_SELECT },
          }).then(rows => pickOffer(rows, { supplierId: session.supplierId, itemCode: scanItem.supplierItemCode }))
            .catch(() => { offerReadOk = false; return null })

          const offerData = {
              inventoryItemId:      scanItem.matchedItemId,
              supplierName:         offerSupplierName!, // non-null: set whenever session.supplierId is (this block)
              supplierId:           session.supplierId,
              // NOT NULL until Stage 1e drops it: a NEW box fills it with its own
              // listed price. Never updated — readers derive offerListedPrice.
              lastPrice:            offerListedPrice({ pricing: offerChain.pricing }),
              isPrimary:            false,
              supplierItemCode:     scanItem.supplierItemCode ?? null,
              lastInvoiceSessionId: sessionId,
              ...offerPack,
              // Per-offer chain (ItemOffer): offer ppb derives from this on read.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              packChain:            offerChain.packChain as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing:              offerChain.pricing as any,
            }
          const upsertedOffer = await (!offerReadOk
            ? Promise.resolve(null)
            : existingOffer
            ? prisma.inventorySupplierPrice.update({
            where: { id: existingOffer.id },
            data: {
              lastUpdated:          new Date(),
              lastInvoiceSessionId: sessionId,
              supplierId:           session.supplierId,
              ...(scanItem.supplierItemCode ? { supplierItemCode: scanItem.supplierItemCode } : {}),
              ...offerPack,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              packChain:            offerChain.packChain as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing:              offerChain.pricing as any,
            },
            select: { id: true },
          })
            // Return only the id so a freshly created offer can be recorded for undo.
            : prisma.inventorySupplierPrice.create({ data: offerData, select: { id: true } })
          ).catch((e) => { console.error('[approve] offer upsert failed:', e); return null })
          writtenOfferId = upsertedOffer?.id ?? null
          const offerCapture = offerCaptureFor(offerReadOk, existingOffer, upsertedOffer)
          if (offerCapture.kind === 'before') undo.before('OFFER', offerCapture.id, offerCapture.prev)
          else if (offerCapture.kind === 'created') undo.created('OFFER', offerCapture.id)
        }

        // ── Primary-offer authority ─────────────────────────────────────────
        // The item's $ spine is the PRIMARY offer's value and the primary is a
        // sticky MANUAL choice, so only the primary's own box may re-price the
        // item (the offer, not merely its supplier: a merged item's other SKUs
        // from the primary supplier are other boxes). An UNLINKED supplier has no
        // box to write, so it re-prices only an item with no boxes at all (legacy
        // single-supplier item); with any box present it writes nothing — it must
        // never overwrite another supplier's price. An unlinked session also
        // never promotes or touches a primary. Rule: shouldRepriceItem.
        const findPrimary = (itemId: string) => prisma.inventorySupplierPrice.findFirst({
          where: { inventoryItemId: itemId, isPrimary: true },
          select: { id: true, ...OFFER_SELECT },
        })
        let primary: Awaited<ReturnType<typeof findPrimary>> = null
        let supplierRowCount = 0
        if (session.supplierId) {
          await ensurePrimary(scanItem.matchedItemId, prisma, undo)
          primary = await findPrimary(scanItem.matchedItemId)
          // A failed offer write leaves only the supplier to go on — trusted
          // only while that supplier sells this item as a single product.
          supplierRowCount = supplierOffers(offersByItem.get(scanItem.matchedItemId) ?? [], {
            supplierId: session.supplierId, supplierName: session.supplierName, canonicalName: offerSupplierName ?? '',
          }).length
        }
        const shouldReprice = shouldRepriceItem({
          sessionSupplierId: session.supplierId ?? null,
          writtenOfferId,
          primary,
          supplierRowCount,
          itemOfferCount: (offersByItem.get(scanItem.matchedItemId) ?? []).length,
        })

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
        // On the WEIGHT path the price above was derived over `received.base`, so
        // that is the quantity frozen — re-reading the line through the post-write
        // RATE mode could pick a stray billed column the money never proved
        // (Butter's "2.86 kg") and break received × price = line total.
        // decideLinePrice computes exactly this as `receiveBase`:
        // pricedByWeight ? received.base : lineReceivedBaseUnits(line, freezeFormat(speaks, newPricing)).
        const receivedQtyBase = freezeQty(d.receiveBase, scanItem.id)

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
          // The PRIMARY box must equal the item: same chain (the item's own,
          // preserved by the spine write above), same pricing. Without this the
          // box keeps the chain built from the invoice's printed pack — which may
          // be OCR noise inside packFormatsDisagree's tolerance — and a later
          // setPrimaryOffer would copy that drift onto the item. Undo for this box
          // was already captured at the upsert (offerCaptureFor → undo.before /
          // undo.created); flushUndo reads its `next` after this transaction.
          // If the box upsert failed but the item is still being re-priced from its
          // primary supplier, the primary box must still end equal to the item.
          // (Undo for that box is captured here — the upsert never touched it.)
          const { boxId } = primaryBoxWrite({ shouldReprice, writtenOfferId, primaryId: primary?.id ?? null })
          if (!writtenOfferId && primary && boxId === primary.id) {
            undo.before('OFFER', primary.id, offerState(primary))
          }
          if (boxId) {
            itemOps.push(
              prisma.inventorySupplierPrice.update({
                where: { id: boxId },
                data: {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  packChain:   (item.packChain ?? []) as any,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  pricing:     newPricing as any,
                  lastUpdated: new Date(),
                },
              }),
            )
          }
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

        // Undo: the item's spine BEFORE this approval's write. `item` is the row
        // read at the top of the run, so it is the pre-run state even when an
        // earlier line already repriced the same item (first touch wins anyway).
        if (shouldReprice) undo.before('ITEM', item.id, itemState(item))

        await prisma.$transaction(itemOps)
        approvedLines.add(scanItem.id)
        if (shouldReprice) updatedItemIds.push(scanItem.matchedItemId)
        // The item re-priced from this line; its PRIMARY box must equal the item (same chain, same pricing) — written in itemOps above. A non-primary supplier's box keeps its own invoice pack.
        // Every write this line makes has landed — read each touched row's `next`.
        await flushUndo()
        registerLineAllocs(scanItem.matchedItemId, scanItem)
      }

      // ── CREATE_NEW ──────────────────────────────────────────────────────
      if (scanItem.action === 'CREATE_NEW') {
        // The SAME three refusals the preflight ran (createNewRefusal): never set
        // up in the Add new product form (or its data won't read); a name that is
        // an invoice wording or blank (W1 — unless the reviewer chose "Use this
        // wording anyway"); a counted product bought by weight with no weight per
        // each. The preflight refuses these with a 409, so reaching one here means
        // the line changed after the check (race-only): skip it, un-approved, and
        // say so in the session note. Nothing is created, so nothing is copied
        // into an RC clone either (see createdByLine).
        const refusal = createNewRefusal(scanItem as ApproveLineInput)
        if (refusal) {
          console.error(`[approve] Not creating a product for "${scanItem.rawDescription}" — ${refusal.message}`)
          skippedLines++
          skippedCreateNew.push(refusal.reason === 'CREATE_NEW_NOT_SET_UP'
            ? `"${scanItem.rawDescription}" was never set up in the Add new product form`
            : refusal.message)
          if (refusal.reason === 'CREATE_NEW_NAME') createNewNameRefused = true
          continue
        }
        const newData = JSON.parse(scanItem.newItemData!)
        // createNewRefusal passed, so the name is a plain one.
        const name = createNewName({ itemName: newData.itemName, rawDescription: scanItem.rawDescription, allowShouty: newData.allowShouty })
        if (!name.ok) { skippedLines++; continue }   // unreachable: the refusal above ran the same check
        // The drawer's AddNewItemModal writes a chain-shaped newItemData
        // ({ dimension, packChain, pricing, countUnit }); older sessions may still
        // carry the legacy pack-field shape, rebuilt over the line's own seed via
        // formToChain (createNewChain — the exact chain the preflight validated).
        const newChain = createNewChain(scanItem as ApproveLineInput, newData)
        const created = await prisma.inventoryItem.create({
          data: {
            itemName:           name.itemName,
            category:           newData.category || 'DRY',
            // Canonical SI base (g/ml/each) — never the raw packUOM, which would
            // store ppb ($/SI-base) under a kg/lb/L label and under-cost recipes.
            baseUnit:           newChain.baseUnit,
            // Location chosen in the modal: a storage area established in the
            // app. The supplier is not an item column — it becomes the item's
            // first (primary) supplier box, created just below.
            storageAreaId:      newData.storageAreaId || null,
            // Chain columns (authoritative).
            dimension:          newChain.dimension,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            packChain:          newChain.packChain as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pricing:            newChain.pricing as any,
            countUnit:          newChain.countUnit,
            // How much one count-unit weighs, for a counted item bought by
            // weight (e.g. "one head" = 250 g) — lets receipts/counts convert
            // between the supplier's weight and the item's count unit.
            eachMeasureQty:     Number(newData.eachMeasureQty) > 0 ? Number(newData.eachMeasureQty) : null,
            eachMeasureUnit:    Number(newData.eachMeasureQty) > 0 && newData.eachMeasureUnit ? canonicalUom(newData.eachMeasureUnit) : null,
          },
        })
        // Its RC copy (a line moved to Catering) must carry the product it created.
        createdByLine.set(scanItem.id, created.id)
        // Undo: an item this approval brought into existence (DELETE removes it,
        // but only when nothing else has come to reference it).
        undo.created('ITEM_CREATED', created.id)
        // The supplier chosen in the modal (falls back to the invoice's supplier
        // when left as the pre-selected default) → the new item's first box,
        // primary, carrying the item's own chain + pricing so item == primary box
        // from the start. The item's supplier derives from this box. Non-critical
        // like the offer upsert above: a failure is logged, never fails the approval.
        const boxSupplierId: string | null = newData.supplierId || session.supplierId || null
        if (boxSupplierId) {
          // The invoice's item code and session belong on the box only when the box
          // is the invoice's own supplier; a different supplier never issued them.
          const sameSupplier = boxSupplierId === session.supplierId
          const box = await (async () => prisma.inventorySupplierPrice.create({
            data: {
              inventoryItemId:      created.id,
              supplierId:           boxSupplierId,
              supplierName:         await canonicalSupplierName(boxSupplierId, ''),
              isPrimary:            true,
              // NOT NULL until Stage 1e drops it; nothing reads it (offerListedPrice derives).
              lastPrice:            listedPrice(newChain),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              packChain:            newChain.packChain as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pricing:              newChain.pricing as any,
              supplierItemCode:     sameSupplier ? (scanItem.supplierItemCode ?? null) : null,
              lastInvoiceSessionId: sameSupplier ? sessionId : null,
            },
            select: { id: true },
          }))().catch((e) => { console.error('[approve] CREATE_NEW supplier box failed:', e); return null })
          if (box) undo.created('OFFER', box.id)
        }
        // The invoice's own wording (and code, and pack) for the product it just
        // created, under the INVOICE's supplier — whoever the box went to, this
        // wording came off this supplier's paper. Non-critical, like the box.
        await saveAlias({
          rawDescription:   scanItem.rawDescription,
          inventoryItemId:  created.id,
          supplierId:       session.supplierId,
          supplierItemCode: scanItem.supplierItemCode,
          format:           packTripleOf(scanItem),
          source:           'CREATE_NEW',
          undo,
        }).catch((e) => console.error('[approve] CREATE_NEW supplier wording failed:', e))
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
        approvedLines.add(scanItem.id)
        await flushUndo()
      }

      // ── All other actions: just mark approved ───────────────────────────
      if (scanItem.action !== 'CREATE_NEW' &&
          scanItem.action !== 'UPDATE_PRICE' &&
          scanItem.action !== 'ADD_SUPPLIER') {
        await prisma.invoiceScanItem.update({
          where: { id: scanItem.id },
          data: { approved: true },
        })
        approvedLines.add(scanItem.id)
      }
    }

    // ── Register RC stock allocations + membership ──────────────────────
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
        if (rcId !== defaultRcId) {
          await prisma.stockAllocation.upsert({
            where: { revenueCenterId_inventoryItemId: { revenueCenterId: rcId, inventoryItemId: itemId } },
            create: { revenueCenterId: rcId, inventoryItemId: itemId, quantity: 0 },
            update: {}, // already allocated — leave quantity/par/reorder untouched
          }).catch((e) => console.error('[approve] stock allocation upsert failed:', e))
        }
        // Receiving stock into an RC implies membership (so it's countable there) —
        // the default RC included: its counts select by membership too, and skipping
        // it left every item first bought for the Kitchen off the Kitchen count.
        await prisma.itemRevenueCenter.upsert({
          where: { inventoryItemId_revenueCenterId: { inventoryItemId: itemId, revenueCenterId: rcId } },
          create: { inventoryItemId: itemId, revenueCenterId: rcId },
          update: {},
        }).catch((e) => console.error('[approve] membership upsert failed:', e))
      }
    }

    // Mark session as APPROVED. Anything that did not go through the normal way
    // is surfaced on the session (src/lib/invoice/approve-note.ts) so it isn't
    // silently lost — and says WHICH it was: a line received with its price left
    // as it was, a priced line that could not be received at all, or a
    // CREATE_NEW that was refused (no product exists, so it must not be reported
    // as a price that was not updated).
    const note = buildApproveNote({ receivedWithoutPrice, skippedPrice, skippedCreateNew, createNewNameRefused })
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
        ...(note ? { errorMessage: note } : {}),
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
        // Only a line this run approved is copied (every copy is written
        // `approved: true`): never a SKIP / PENDING line, a priced line that was
        // neither received nor priced, or a create-new line that created nothing
        // (refused — no product, nothing received). A create-new that did create
        // its product is always a WHOLE move (factor 1): the review screen blocks
        // a quantity split on an unlinked line (hasInvalidRcSplit) and
        // parseValidSplit needs a matched item, which the in-memory row lacks.
        if (item.action === 'SKIP' || item.action === 'PENDING' || !approvedLines.has(item.id)) continue
        if (item.action === 'CREATE_NEW' && !createdByLine.has(item.id)) continue
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
          // A create-new line's product exists only since this run (the in-memory
          // row still says unmatched); its copy carries it, with its receipt.
          matchedItemId:   createdByLine.get(item.id) ?? item.matchedItemId,
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

    // ── Learn this supplier's wordings (non-critical) ───────────────────
    // Every matched, non-SKIP line upserts (session supplier, normalised wording)
    // → item, with its code and pack. CREATE_NEW lines learned theirs in the
    // loop above against the item they created. Lines that normalise to the same
    // wording write the same alias row, so they run one after another (last line
    // wins, exactly as sequential approval would); different wordings run in
    // parallel.
    const aliasGroups = new Map<string, typeof itemsToProcess>()
    for (const item of itemsToProcess) {
      if (!item.matchedItemId || item.action === 'SKIP' || item.action === 'CREATE_NEW') continue
      const key = normaliseAliasText(item.rawDescription)
      aliasGroups.set(key, [...(aliasGroups.get(key) ?? []), item])
    }
    await Promise.all(
      Array.from(aliasGroups.values()).map(async (group) => {
        for (const item of group) {
          await saveAlias({
            rawDescription:   item.rawDescription,
            inventoryItemId:  item.matchedItemId!,
            supplierId:       session.supplierId,
            supplierItemCode: item.supplierItemCode,
            // A line received without its price because its case disagreed with
            // the box: learn the wording, never the disputed case.
            format:           disputedPack.has(item.id) ? null : packTripleOf(item),
            source:           'APPROVE',
            undo,
          }).catch((e) => console.error('[approve] supplier wording failed:', e))
        }
      })
    )
    // Learned wordings are the last thing this approval writes.
    await flushUndo()

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
          priorPpbByItem.set(p.inventoryItem.id, lastCost(p.inventoryItem))
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
      receivedWithoutPrice: receivedWithoutPrice.length,
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
          code: 'DUPLICATE',
          error: `Invoice ${session.invoiceNumber} from ${session.supplierName} was already approved${dup.approvedAt ? ` on ${new Date(dup.approvedAt).toLocaleDateString('en-CA')}` : ''}. Approving again will apply its price changes a second time.`,
          duplicate: true,
        },
        { status: 409 }
      )
    }
  }

  // ── Preflight: every line approve would refuse ──────────────────────────
  // Run BEFORE the claim, so a blocked invoice stays in REVIEW with nothing
  // written. The reviewer has the invoice open and is the only one who can tell
  // a real case-size change from a misread; each blocked line can be fixed, or
  // (when it has stock to receive) received with its old price kept
  // (`receiveWithoutPrice`) — never a weight the item can't convert. A price
  // that looks off (20×, or 3× when the unit was assumed) clears ONLY by
  // `priceConfirmed`; receive-only does not clear it, because a wrong unit makes
  // the quantity wrong too. The SAME snapshot is handed to the run, so it reads
  // exactly what was judged here. Lines the run will not touch (SKIP/PENDING)
  // are not checked.
  const lineIds = new Set(session.scanItems.map(si => si.id))
  const choices = {
    receiveWithoutPrice: lineIdSet(body?.receiveWithoutPrice, lineIds),
    priceConfirmed:      lineIdSet(body?.priceConfirmed, lineIds),
  }
  const snapshot = await loadApproveSnapshot(session)
  const blocked: BlockedLine[] = approveBlocks({
    lines: session.scanItems
      .filter(si => si.action !== 'SKIP' && si.action !== 'PENDING') as unknown as Parameters<typeof approveBlocks>[0]['lines'],
    offersByItem: snapshot.offersByItem,
    supplier: {
      id:            session.supplierId,
      supplierId:    session.supplierId,
      supplierName:  session.supplierName,
      canonicalName: snapshot.offerSupplierName,
    },
    receiveWithoutPrice: choices.receiveWithoutPrice,
    priceConfirmed:      choices.priceConfirmed,
  })
  if (blocked.length > 0) {
    const n = blocked.length
    const canReceive = blocked.some(b => b.canReceiveWithoutPrice)
    return NextResponse.json(
      {
        code: 'LINES_BLOCKED',
        error: `${n} line${n === 1 ? '' : 's'} can't be approved yet. ${n === 1 ? 'Fix it' : 'Fix each one'}` +
          (canReceive ? ', or choose “Receive the stock, keep the old price”.' : '.'),
        blocked,
      },
      { status: 409 },
    )
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

  // W6: approving with a supplier linked is the reviewer confirming it, so the
  // invoice's spelling of that supplier is learned now — a fuzzy match at scan
  // time only suggested the link (src/lib/supplier-matcher.ts). Never fails the
  // approval.
  if (session.supplierId && session.supplierName) {
    await learnAlias(session.supplierId, session.supplierName).catch(() => {})
  }

  // waitUntil keeps the Vercel function alive until doApprove finishes,
  // even after the response has been sent to the client. Approving writes purchases
  // (new stock), so drop the theoretical-stock cache once it lands.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  waitUntil(
    doApprove(params.id, approvedBy, session as any, snapshot, choices)
      .then(() => invalidateTheoreticalCache())
      .catch(() => {}),
  )

  return NextResponse.json({ ok: true, queued: true })
}
