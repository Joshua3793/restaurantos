// Merge two inventory items that are the same good. PURE: rows in, manifest out.
// The executor (item-merge-exec.ts) applies a manifest; undo applies planUndo().
// Spec: docs/superpowers/specs/2026-09-20-item-consolidation-design.md §1.
//
// v1 SCOPE CUT: only same-base-unit merges are supported (DIFFERENT_BASE_UNIT
// refuses the rest). Every defect found across three review rounds lived in
// cross-base-unit maths (k ≠ 1) or legacy count lines — cutting the former
// removes a whole class of risk; the latter (count lines) still needs care
// even at k = 1, because the two items still have DIFFERENT pack chains.

import type { Dimension, PackLink, Pricing, EachMeasure } from '@/lib/item-model'
import { dimensionOf } from '@/lib/item-model'
import { canonicalUom } from '@/lib/uom'
import { countUomFactor, lineCountedBase, type ItemDims } from '@/lib/count-uom'

export type MergeGuard = 'SAME_ITEM' | 'PREP_OWNED' | 'TOMBSTONE' | 'OPEN_COUNT' | 'DIFFERENT_BASE_UNIT' | 'NEEDS_ON_HAND'
export type RepointTable =
  | 'InvoiceScanItem' | 'InvoiceLineItem' | 'PriceAlert' | 'InvoiceMatchRule' | 'StockTransfer' | 'WastageLog'
  | 'RecipeIngredient' | 'CountLine' | 'InventorySnapshot' | 'InventorySupplierPrice' | 'StockAllocation' | 'ItemRevenueCenter'
export type UpdateTable = RepointTable | 'InventoryItem'
export type DeleteTable = 'InventorySupplierPrice' | 'InventorySnapshot' | 'StockAllocation' | 'ItemRevenueCenter'

export interface MergeItemRow {
  id: string; itemName: string; baseUnit: string; dimension: Dimension; countUnit: string
  packChain: PackLink[]; pricing: Pricing; stockOnHand: number
  /** Still read for the count-line reader's dims (an each↔measured bridge can
   *  matter on a count LINE even when the two ITEMS share a base unit). */
  eachMeasure: EachMeasure | null
  isActive: boolean; mergedIntoId: string | null; ownedByRecipe: boolean; inOpenCount: boolean
  theoreticalOnHand: number
}

/** A stored mixed-unit count entry — see `CountEntry` in src/lib/count-uom.ts
 *  and the `CountLine.entries` schema comment ("When present it is authoritative"). */
export interface MergeCountEntry { unit: string; qty: number }

export interface MergeRelations {          // everything that points at the ABSORBED row…
  scanItems: { id: string; receivedQtyBase: number | null }[]
  invoiceLineItemIds: string[]; priceAlertIds: string[]; matchRuleIds: string[]
  transfers: { id: string; quantity: number }[]
  wastage: { id: string; qtyWasted: number; unit: string }[]
  recipeIngredients: { id: string; qtyBase: number; unit: string }[]
  countLines: {
    id: string; expectedQty: number; countedQtyBase: number | null; priceAtCount: number
    // legacy lines carry countedQtyBase: null and must be re-derived — precedence
    // (src/lib/count-uom.ts `lineCountedBase`) is countedQtyBase → entries →
    // countedQty/selectedUom. Re-deriving through the item's CURRENT chain (the
    // survivor's, after this merge) restates history even at k = 1, because the
    // two items still have DIFFERENT pack chains — so we freeze through the
    // ABSORBED chain here first, before that current chain changes underneath it.
    countedQty: number | null; selectedUom: string; entries: MergeCountEntry[] | null
  }[]
  // loaded by the executor as FULL database rows (extra fields beyond those
  // declared here) so a `delete` op's `row` can re-create the row on undo.
  snapshots: Array<{ id: string; sessionId: string; qtyOnHand: number; unit: string; pricePerBaseUnit: number; totalValue: number; source: string } & Record<string, unknown>>
  offers: Array<{ id: string; supplierName: string; supplierId: string | null; lastUpdated: string; isPrimary: boolean } & Record<string, unknown>>
  allocations: { id: string; revenueCenterId: string; quantity: number; parLevel: number | null; reorderQty: number | null }[]
  itemRcs: { id: string; revenueCenterId: string }[]
  latestPurchaseSupplier: { supplierId: string | null; supplierName: string } | null
  /** rows previously merged INTO the absorbed item (their mergedIntoId === absorbed.id) —
   *  re-pointed onto the survivor so a one-hop resolve never lands on a tombstone. */
  priorAbsorbeeIds: string[]
}
export interface SurvivorRelations {       // …and what the SURVIVOR already has that can collide
  offers: Array<{ id: string; supplierName: string; lastUpdated: string; isPrimary: boolean } & Record<string, unknown>>
  allocations: { id: string; revenueCenterId: string; quantity: number }[]
  itemRcs: { revenueCenterId: string }[]
  snapshots: { id: string; sessionId: string; qtyOnHand: number; totalValue: number; source: string }[]
}
export type MergeOp =
  | { t: 'repoint'; table: RepointTable; ids: string[] }
  | { t: 'update'; table: UpdateTable; id: string; before: Record<string, unknown>; after: Record<string, unknown> }
  | { t: 'delete'; table: DeleteTable; row: Record<string, unknown> }        // full row kept for undo
  | { t: 'create'; table: DeleteTable | 'InventorySupplierPrice'; row: Record<string, unknown> }
export interface MergeManifest { survivorId: string; absorbedId: string; ops: MergeOp[] }
export type MergePlan = { ok: true; manifest: MergeManifest; summary: MergeSummary } | { ok: false; guard: MergeGuard; message: string }

export interface MergeSummary {
  invoiceLines: number; recipeLines: number; countLines: number; snapshots: number
  offersMoved: number
  /** dropped because the survivor's own offer for that supplier was same-or-newer,
   *  checked BEFORE the primary test (M-iv) — a drop that is both stale and
   *  primary-protected is counted here, not below, since staleness alone explains it */
  absorbedOffersDroppedStale: number
  /** dropped to protect the survivor's PRIMARY offer even though the absorbed one
   *  was genuinely newer — the only case this counts is a real override */
  absorbedOffersDroppedForSurvivorPrimary: number
  survivorOffersReplaced: number
  offerSynthesized: boolean
  /** the offer (moved or synthesized) promoted to primary because the survivor had none, or null */
  primaryPromoted: { supplierName: string } | null
  /** count lines whose base could not be safely resolved through the absorbed
   *  chain by the count-uom reader (see M-b) — the merge still proceeds; the UI warns */
  countLinesUnfrozen: number
  absorbedOnHand: number; survivorOnHand: number
}

const SOURCE_RANK: Record<string, number> = { COUNTED: 3, CARRIED: 2, THEORETICAL: 1, SKIPPED: 0 }
/** Prisma Decimal fields arrive as strings in JSON despite being typed `number` —
 *  never do arithmetic on a raw input field without this. */
const toNum = (x: unknown): number => Number(x)
/** `lastUpdated` may arrive as a Date or an ISO string; compare by instant, not
 *  string order. An unparsable value is treated as infinitely old (never wins),
 *  and NaN-vs-NaN never occurs downstream because both sides map to the same
 *  -Infinity, so a "tie" between two bad dates still resolves deterministically
 *  (whichever comparison uses it keeps the survivor, per M-a). */
const ts = (x: string): number => {
  const t = new Date(x).getTime()
  return Number.isFinite(t) ? t : -Infinity
}

/** The count-uom reader's STRICT resolver (`countUomFactor`) rejects the two
 *  legacy generic purchase words on principle (a write-path guard against a
 *  unit the count sheet never actually offered) — but freezing a legacy line
 *  is a READ of history, not a write, and the reader's own read-path
 *  resolution (`legacy: true`, not exported) explicitly still honours them
 *  (see the `legacy` parameter docs in count-uom.ts: "case" is the outermost
 *  pack, "pack" the second, whenever the item has a chain at all). Carved out
 *  here rather than re-implementing the reader's resolution. */
function isLegacyPackWord(unit: string, chainLength: number): boolean {
  const u = canonicalUom(unit)
  return chainLength > 0 && (u === 'case' || u === 'pack')
}

export function planMerge(
  survivor: MergeItemRow, absorbed: MergeItemRow, rel: MergeRelations, sRel: SurvivorRelations,
  opts: { combinedOnHandProvided: boolean; newId: () => string },
): MergePlan {
  const fail = (guard: MergeGuard, message: string): MergePlan => ({ ok: false, guard, message })
  if (survivor.id === absorbed.id) return fail('SAME_ITEM', 'Pick a different item to merge in.')
  for (const r of [survivor, absorbed]) {
    if (r.ownedByRecipe) return fail('PREP_OWNED', `${r.itemName} is made by a prep recipe — prep items can’t be merged.`)
    if (r.mergedIntoId || !r.isActive) return fail('TOMBSTONE', `${r.itemName} is inactive or was already merged.`)
    if (r.inOpenCount) return fail('OPEN_COUNT', `${r.itemName} is on a count that is still open. Finalize or discard it first.`)
  }
  if (canonicalUom(absorbed.baseUnit) !== canonicalUom(survivor.baseUnit))
    return fail('DIFFERENT_BASE_UNIT',
      `${absorbed.itemName} is tracked in ${absorbed.baseUnit} and ${survivor.itemName} in ${survivor.baseUnit}. Change ${absorbed.itemName} to ${survivor.baseUnit} first (edit the item), then merge.`)
  if (Math.abs(toNum(absorbed.theoreticalOnHand)) > 1e-9 && !opts.combinedOnHandProvided)
    return fail('NEEDS_ON_HAND', `${absorbed.itemName} still shows stock on hand. Enter the combined on-hand for both.`)

  const ops: MergeOp[] = []
  const repoint = (table: RepointTable, ids: string[]) => { if (ids.length) ops.push({ t: 'repoint', table, ids }) }

  // ── plain re-points (no quantity ever needs conversion — same base unit) ─────
  repoint('InvoiceScanItem', rel.scanItems.map(s => s.id))
  repoint('InvoiceLineItem', rel.invoiceLineItemIds)
  repoint('PriceAlert', rel.priceAlertIds)
  repoint('InvoiceMatchRule', rel.matchRuleIds)
  repoint('StockTransfer', rel.transfers.map(t => t.id))
  repoint('WastageLog', rel.wastage.map(w => w.id))
  repoint('RecipeIngredient', rel.recipeIngredients.map(r => r.id))
  repoint('CountLine', rel.countLines.map(c => c.id))

  // ── count lines: same base unit does NOT make this go away — the two items
  // still have DIFFERENT pack chains, and a legacy line (countedQtyBase null)
  // re-derives through the item's CURRENT chain, which becomes the survivor's
  // after this merge. Crit-1: freeze using the READERS' OWN resolver
  // (src/lib/count-uom.ts), never a hand-rolled one — `lineCountedBase` is the
  // precedence + value oracle (countedQtyBase → entries → countedQty/
  // selectedUom), `countUomFactor` (plus the legacy case/pack carve-out above)
  // decides resolvability. M-b: a unit the reader can't resolve is left
  // unfrozen and un-normalised, counted in countLinesUnfrozen rather than
  // guessed at. Normalise the display pair whenever the line's unit (or any
  // entries[].unit) is not a plain measured unit or the item's own base unit —
  // i.e. it means something only through the absorbed item's chain, which the
  // survivor does not share. One update op per line; a line needing none of
  // this gets none. ────────────────────────────────────────────────────────
  let countLinesUnfrozen = 0
  const absorbedDims: ItemDims = {
    dimension: absorbed.dimension, baseUnit: absorbed.baseUnit, packChain: absorbed.packChain,
    countUnit: absorbed.countUnit, eachMeasureQty: absorbed.eachMeasure?.qty ?? null, eachMeasureUnit: absorbed.eachMeasure?.unit ?? null,
  }
  const chainLen = absorbed.packChain.length
  const resolvable = (unit: string) => countUomFactor(unit, absorbedDims) !== null || isLegacyPackWord(unit, chainLen)
  const isPlainMeasured = (unit: string) => dimensionOf(unit) !== 'COUNT' || canonicalUom(unit) === canonicalUom(absorbed.baseUnit)

  for (const c of rel.countLines) {
    const entries = Array.isArray(c.entries) && c.entries.length > 0 ? c.entries : null
    const needsFreeze = c.countedQtyBase == null && (entries != null || c.countedQty != null)
    const checkUnits = entries ? entries.map(e => e.unit) : [c.selectedUom]

    let newBase: number | null = c.countedQtyBase == null ? null : toNum(c.countedQtyBase)
    let baseChanged = false
    let skippedUnresolvable = false

    if (needsFreeze) {
      if (checkUnits.every(u => resolvable(u))) {
        newBase = lineCountedBase({ countedQtyBase: null, countedQty: c.countedQty, selectedUom: c.selectedUom, entries: c.entries }, absorbedDims)
        baseChanged = true
      } else {
        skippedUnresolvable = true
        countLinesUnfrozen++
      }
    }
    // No `else` branch to scale an existing base by a factor — same base unit
    // means a frozen countedQtyBase never needs a numeric change.

    const needsNormalize = !skippedUnresolvable && newBase != null && checkUnits.some(u => !isPlainMeasured(u))

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    if (baseChanged) { before.countedQtyBase = c.countedQtyBase; after.countedQtyBase = newBase }
    if (needsNormalize) {
      // Nulling `entries` here is deliberate: its unit names are meaningless on
      // the survivor's chain once repointed, and countedQtyBase now carries the
      // frozen truth; `before` restores the original array (or null) exactly.
      before.countedQty = c.countedQty; before.selectedUom = c.selectedUom; before.entries = c.entries
      after.countedQty = newBase; after.selectedUom = survivor.baseUnit; after.entries = null
    }
    if (Object.keys(after).length > 0)
      ops.push({ t: 'update', table: 'CountLine', id: c.id, before, after })
  }

  // ── snapshots: same count session on both sides → one summed row ─────────────
  const sSnap = new Map(sRel.snapshots.map(s => [s.sessionId, s]))
  const moveSnaps: string[] = []
  for (const n of rel.snapshots) {
    const hit = sSnap.get(n.sessionId)
    if (hit) {
      const stronger = (SOURCE_RANK[n.source] ?? 0) > (SOURCE_RANK[hit.source] ?? 0) ? n.source : hit.source
      ops.push({ t: 'update', table: 'InventorySnapshot', id: hit.id,
        before: { qtyOnHand: hit.qtyOnHand, totalValue: hit.totalValue, source: hit.source },
        after:  { qtyOnHand: toNum(hit.qtyOnHand) + toNum(n.qtyOnHand), totalValue: toNum(hit.totalValue) + toNum(n.totalValue), source: stronger } })
      ops.push({ t: 'delete', table: 'InventorySnapshot', row: { ...n, inventoryItemId: absorbed.id } })
    } else {
      moveSnaps.push(n.id)
    }
  }
  repoint('InventorySnapshot', moveSnaps)

  // ── offers: unique (item, supplierName) ───────────────────────────────────────
  // INVARIANT 1: a merge never deletes or reprimaries the survivor's own PRIMARY
  // offer. M-iv: the date check runs FIRST, so a drop that would have happened
  // anyway on staleness grounds is labelled `…DroppedStale` even when the
  // survivor's offer also happens to be primary — `…DroppedForSurvivorPrimary`
  // is reserved for a genuine override (the absorbed offer was actually newer).
  // The DECISION is unchanged either way: the survivor's primary is never moved
  // or deleted. Otherwise the newer `lastUpdated` wins (a tie keeps the
  // survivor's — `…DroppedStale`).
  // INVARIANT 2 (src/lib/primary-offer.ts header): an item with ≥1 offer has
  // EXACTLY ONE primary. If the survivor has no primary of its own and gains ≥1
  // offer from this merge, exactly one of the NEW offers (never one of the
  // survivor's own existing rows) is promoted — the most recently updated among
  // the moved offers, tie → the one that was primary on the absorbed item, tie →
  // id ascending; or the synthesized offer when it is the only offer gained. The
  // planner never syncs the survivor's packChain/pricing off this — that spine
  // write belongs to primary-offer.ts, not a merge. The executor runs no
  // primary-election pass of its own; this manifest is the complete record of
  // every write.
  const sOffer = new Map(sRel.offers.map(o => [o.supplierName, o]))
  const moveOffers: string[] = []
  const movedOffers: MergeRelations['offers'] = []
  let absorbedOffersDroppedStale = 0
  let absorbedOffersDroppedForSurvivorPrimary = 0
  let survivorOffersReplaced = 0
  for (const o of rel.offers) {
    const hit = sOffer.get(o.supplierName)
    if (hit) {
      const isStale = ts(hit.lastUpdated) >= ts(o.lastUpdated)
      if (isStale || hit.isPrimary) {
        ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...o, inventoryItemId: absorbed.id } })
        if (isStale) absorbedOffersDroppedStale++
        else absorbedOffersDroppedForSurvivorPrimary++
        continue
      }
      ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...hit, inventoryItemId: survivor.id } })
      survivorOffersReplaced++
    }
    moveOffers.push(o.id)
    movedOffers.push(o)
  }

  const derivedPrice = toNum(absorbed.pricing.mode === 'RATE' ? absorbed.pricing.rate : absorbed.pricing.purchasePrice)
  const canSynth = rel.offers.length === 0 && rel.scanItems.length > 0 && !!rel.latestPurchaseSupplier
    && !sOffer.has(rel.latestPurchaseSupplier!.supplierName)
    && Number.isFinite(derivedPrice) && derivedPrice > 0

  // I-1: decide the promotion winner BEFORE emitting any isPrimary op, since it
  // depends on the full set of offers actually being moved in.
  const survivorHasPrimary = sRel.offers.some(o => o.isPrimary)
  let primaryPromoted: { supplierName: string } | null = null
  let winnerId: string | null = null
  if (!survivorHasPrimary) {
    if (movedOffers.length > 0) {
      const winner = [...movedOffers].sort((a, b) => {
        const ta = ts(a.lastUpdated), tb = ts(b.lastUpdated)
        if (ta !== tb) return tb - ta
        if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })[0]
      winnerId = winner.id
      primaryPromoted = { supplierName: winner.supplierName }
    } else if (canSynth) {
      // rel.offers.length === 0 is required for canSynth, so movedOffers is
      // always empty here — the synthesized offer is the only candidate.
      primaryPromoted = { supplierName: rel.latestPurchaseSupplier!.supplierName }
    }
  }

  for (const o of movedOffers) {
    // Demote every moved offer that was primary on the absorbed item, EXCEPT
    // the winner — if the winner was already primary, its flag is simply left
    // alone (no op at all).
    if (o.isPrimary && o.id !== winnerId)
      ops.push({ t: 'update', table: 'InventorySupplierPrice', id: o.id, before: { isPrimary: true }, after: { isPrimary: false } })
  }
  repoint('InventorySupplierPrice', moveOffers)
  // The winner's promotion (when it wasn't already primary) must land AFTER the
  // repoint above: setting isPrimary:true while it is still under the absorbed
  // item's id could collide with that item's own (different) primary offer
  // under the partial unique index (inventoryItemId) WHERE isPrimary.
  if (winnerId != null) {
    const winner = movedOffers.find(o => o.id === winnerId)!
    if (!winner.isPrimary)
      ops.push({ t: 'update', table: 'InventorySupplierPrice', id: winnerId, before: { isPrimary: false }, after: { isPrimary: true } })
  }

  // Crit-3: same base unit ⇒ the absorbed item's packChain AND pricing (PACK or
  // RATE — a RATE's rateUnit is still valid, since the base unit hasn't changed)
  // are valid on the survivor exactly as they are. Carry both verbatim.
  if (canSynth) {
    ops.push({ t: 'create', table: 'InventorySupplierPrice', row: {
      id: opts.newId(),
      inventoryItemId: survivor.id, supplierName: rel.latestPurchaseSupplier!.supplierName,
      supplierId: rel.latestPurchaseSupplier!.supplierId,
      isPrimary: !survivorHasPrimary, // movedOffers is always empty when canSynth
      lastPrice: derivedPrice,
      packChain: absorbed.packChain,
      pricing: absorbed.pricing,
    } })
  }

  // ── per-RC rows: unique (rc, item) ──────────────────────────────────────────
  const sAlloc = new Map(sRel.allocations.map(a => [a.revenueCenterId, a]))
  const moveAllocs: string[] = []
  for (const a of rel.allocations) {
    const hit = sAlloc.get(a.revenueCenterId)
    if (hit) {
      ops.push({ t: 'update', table: 'StockAllocation', id: hit.id, before: { quantity: hit.quantity }, after: { quantity: toNum(hit.quantity) + toNum(a.quantity) } })
      ops.push({ t: 'delete', table: 'StockAllocation', row: { ...a, inventoryItemId: absorbed.id } })
    } else {
      moveAllocs.push(a.id)
      // par/reorder are in the absorbed row's COUNT unit — only meaningless on
      // the survivor when the two items don't even share a count unit.
      if (absorbed.countUnit !== survivor.countUnit && (a.parLevel != null || a.reorderQty != null))
        ops.push({ t: 'update', table: 'StockAllocation', id: a.id,
          before: { parLevel: a.parLevel, reorderQty: a.reorderQty }, after: { parLevel: null, reorderQty: null } })
    }
  }
  repoint('StockAllocation', moveAllocs)
  const sRc = new Set(sRel.itemRcs.map(r => r.revenueCenterId))
  const moveRcs: string[] = []
  for (const r of rel.itemRcs) {
    if (sRc.has(r.revenueCenterId)) ops.push({ t: 'delete', table: 'ItemRevenueCenter', row: { ...r, inventoryItemId: absorbed.id } })
    else moveRcs.push(r.id)
  }
  repoint('ItemRevenueCenter', moveRcs)

  // ── tombstone chains: a row previously merged INTO the absorbed item must
  // resolve onto the new survivor in one hop, never onto a tombstone ──────────
  for (const id of rel.priorAbsorbeeIds)
    ops.push({ t: 'update', table: 'InventoryItem', id, before: { mergedIntoId: absorbed.id }, after: { mergedIntoId: survivor.id } })

  // ── stock + tombstone (always last) ─────────────────────────────────────────
  if (toNum(absorbed.stockOnHand) !== 0)
    ops.push({ t: 'update', table: 'InventoryItem', id: survivor.id, before: { stockOnHand: survivor.stockOnHand }, after: { stockOnHand: toNum(survivor.stockOnHand) + toNum(absorbed.stockOnHand) } })
  ops.push({ t: 'update', table: 'InventoryItem', id: absorbed.id,
    before: { isActive: true, mergedIntoId: null, stockOnHand: absorbed.stockOnHand },
    after:  { isActive: false, mergedIntoId: survivor.id, stockOnHand: 0 } })

  return {
    ok: true,
    manifest: { survivorId: survivor.id, absorbedId: absorbed.id, ops },
    summary: {
      invoiceLines: rel.scanItems.length, recipeLines: rel.recipeIngredients.length, countLines: rel.countLines.length,
      snapshots: rel.snapshots.length, offersMoved: moveOffers.length,
      absorbedOffersDroppedStale, absorbedOffersDroppedForSurvivorPrimary, survivorOffersReplaced,
      offerSynthesized: canSynth, primaryPromoted, countLinesUnfrozen,
      absorbedOnHand: absorbed.theoreticalOnHand, survivorOnHand: survivor.theoreticalOnHand,
    },
  }
}

/** Inverse ops, reverse order. `repoint` is its own inverse — the executor
 *  targets absorbedId when undoing. create ↔ delete swap; updates swap before/after. */
export function planUndo(manifest: MergeManifest): MergeOp[] {
  return [...manifest.ops].reverse().map((op): MergeOp => {
    if (op.t === 'update') return { ...op, before: op.after, after: op.before }
    if (op.t === 'delete') return { t: 'create', table: op.table, row: op.row }
    if (op.t === 'create') return { t: 'delete', table: op.table, row: op.row }
    return op
  })
}
