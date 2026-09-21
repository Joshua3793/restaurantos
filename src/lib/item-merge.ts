// Merge two inventory items that are the same good. PURE: rows in, manifest out.
// The executor (item-merge-exec.ts) applies a manifest; undo applies planUndo().
// Spec: docs/superpowers/specs/2026-09-20-item-consolidation-design.md §1.

import type { Dimension, PackLink, Pricing, EachMeasure } from '@/lib/item-model'
import { dimensionOf, basePerUnit } from '@/lib/item-model'
import { UNIT_FACTORS, canonicalUom } from '@/lib/uom'

export type MergeGuard = 'SAME_ITEM' | 'PREP_OWNED' | 'TOMBSTONE' | 'OPEN_COUNT' | 'NO_BRIDGE' | 'NEEDS_ON_HAND'
export type RepointTable =
  | 'InvoiceScanItem' | 'InvoiceLineItem' | 'PriceAlert' | 'InvoiceMatchRule' | 'StockTransfer' | 'WastageLog'
  | 'RecipeIngredient' | 'CountLine' | 'InventorySnapshot' | 'InventorySupplierPrice' | 'StockAllocation' | 'ItemRevenueCenter'
export type UpdateTable = RepointTable | 'InventoryItem'
export type DeleteTable = 'InventorySupplierPrice' | 'InventorySnapshot' | 'StockAllocation' | 'ItemRevenueCenter'

export interface MergeItemRow {
  id: string; itemName: string; baseUnit: string; dimension: Dimension; countUnit: string
  packChain: PackLink[]; pricing: Pricing; stockOnHand: number
  eachMeasure: EachMeasure | null; densityGPerMl: number | null
  isActive: boolean; mergedIntoId: string | null; ownedByRecipe: boolean; inOpenCount: boolean
  theoreticalOnHand: number
}

export interface MergeRelations {          // everything that points at the ABSORBED row…
  scanItems: { id: string; receivedQtyBase: number | null }[]
  invoiceLineItemIds: string[]; priceAlertIds: string[]; matchRuleIds: string[]
  transfers: { id: string; quantity: number }[]
  wastage: { id: string; qtyWasted: number; unit: string }[]
  recipeIngredients: { id: string; qtyBase: number; unit: string }[]
  countLines: {
    id: string; expectedQty: number; countedQtyBase: number | null; priceAtCount: number
    // legacy lines carry countedQtyBase: null and must be re-derived from countedQty +
    // selectedUom (through the CURRENT chain, per readers) — frozen here through the
    // ABSORBED chain before that current chain becomes the survivor's.
    countedQty: number | null; selectedUom: string; entries: unknown
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
export interface MergeManifest { survivorId: string; absorbedId: string; factor: number; ops: MergeOp[] }
export type MergePlan = { ok: true; manifest: MergeManifest; summary: MergeSummary } | { ok: false; guard: MergeGuard; message: string }

export interface MergeSummary {
  invoiceLines: number; recipeLines: number; countLines: number; snapshots: number
  offersMoved: number; absorbedOffersDropped: number; survivorOffersReplaced: number; offerSynthesized: boolean; factor: number
  absorbedOnHand: number; survivorOnHand: number
}

const SOURCE_RANK: Record<string, number> = { COUNTED: 3, CARRIED: 2, THEORETICAL: 1, SKIPPED: 0 }
/** value of `qty unit` in its dimension's base unit */
const toBase = (qty: number, unit: string) => qty * (UNIT_FACTORS[canonicalUom(unit)]?.toBase ?? 1)
/** Prisma Decimal fields arrive as strings in JSON despite being typed `number` —
 *  never do arithmetic on a raw input field without this. */
const toNum = (x: unknown): number => Number(x)
/** `lastUpdated` may arrive as a Date or an ISO string; compare by instant, not string order. */
const ts = (x: string): number => new Date(x).getTime()

export function baseFactor(absorbed: MergeItemRow, survivor: MergeItemRow): number | null {
  if (absorbed.dimension === survivor.dimension) return 1
  const each = survivor.eachMeasure
  if (each && each.qty > 0 && (absorbed.dimension === 'COUNT') !== (survivor.dimension === 'COUNT')) {
    const measured = absorbed.dimension === 'COUNT' ? survivor.dimension : absorbed.dimension
    if (dimensionOf(each.unit) !== measured) return null
    const basePerEach = toBase(each.qty, each.unit)
    return absorbed.dimension === 'COUNT' ? basePerEach : 1 / basePerEach
  }
  const d = survivor.densityGPerMl
  if (d && d > 0 && absorbed.dimension !== 'COUNT' && survivor.dimension !== 'COUNT')
    return absorbed.dimension === 'VOLUME' ? d : 1 / d
  return null
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
  const k = baseFactor(absorbed, survivor)
  if (k === null)
    return fail('NO_BRIDGE', `${absorbed.itemName} is tracked in ${absorbed.baseUnit} and ${survivor.itemName} in ${survivor.baseUnit}. Add ${
      absorbed.dimension === 'COUNT' || survivor.dimension === 'COUNT' ? 'an each-measure (weight of one each)' : 'a density'
    } to ${survivor.itemName} first.`)
  if (Math.abs(toNum(absorbed.theoreticalOnHand)) > 1e-9 && !opts.combinedOnHandProvided)
    return fail('NEEDS_ON_HAND', `${absorbed.itemName} still shows stock on hand. Enter the combined on-hand for both.`)

  const ops: MergeOp[] = []
  const repoint = (table: RepointTable, ids: string[]) => { if (ids.length) ops.push({ t: 'repoint', table, ids }) }
  const conv = k !== 1

  // ── plain re-points ──────────────────────────────────────────────────────────
  repoint('InvoiceScanItem', rel.scanItems.map(s => s.id))
  repoint('InvoiceLineItem', rel.invoiceLineItemIds)
  repoint('PriceAlert', rel.priceAlertIds)
  repoint('InvoiceMatchRule', rel.matchRuleIds)
  repoint('StockTransfer', rel.transfers.map(t => t.id))
  repoint('WastageLog', rel.wastage.map(w => w.id))
  repoint('RecipeIngredient', rel.recipeIngredients.map(r => r.id))
  repoint('CountLine', rel.countLines.map(c => c.id))

  // ── base-unit conversion (only when the base unit actually changes) ──────────
  if (conv) {
    for (const s of rel.scanItems) if (s.receivedQtyBase != null)
      ops.push({ t: 'update', table: 'InvoiceScanItem', id: s.id, before: { receivedQtyBase: s.receivedQtyBase }, after: { receivedQtyBase: toNum(s.receivedQtyBase) * k } })
    for (const t of rel.transfers)
      ops.push({ t: 'update', table: 'StockTransfer', id: t.id, before: { quantity: t.quantity }, after: { quantity: toNum(t.quantity) * k } })
    // MINOR 1: convert only when the row's unit matches the ABSORBED item's own
    // dimension — that is the dimension the qty was actually recorded in. A unit
    // in some other (or unknown) dimension is a data anomaly, not ours to guess at.
    for (const w of rel.wastage) if (dimensionOf(w.unit) === absorbed.dimension)
      ops.push({ t: 'update', table: 'WastageLog', id: w.id, before: { qtyWasted: w.qtyWasted, unit: w.unit }, after: { qtyWasted: toBase(toNum(w.qtyWasted), w.unit) * k, unit: survivor.baseUnit } })
    for (const r of rel.recipeIngredients) if (dimensionOf(r.unit) === absorbed.dimension)
      ops.push({ t: 'update', table: 'RecipeIngredient', id: r.id, before: { qtyBase: r.qtyBase, unit: r.unit }, after: { qtyBase: toBase(toNum(r.qtyBase), r.unit) * k, unit: survivor.baseUnit } })
  }

  // ── count lines: freeze legacy null bases through the ABSORBED chain (readers
  // re-derive countedQtyBase from countedQty+selectedUom through the item's
  // CURRENT chain, which becomes the survivor's after this merge — freezing
  // here first is what prevented the $44k drift this codebase already hit
  // once), then normalise the display pair when the unit's meaning could
  // differ on the survivor. One update op per line; a line needing none of
  // this gets none. ─────────────────────────────────────────────────────────
  for (const c of rel.countLines) {
    const isLevelUnit = absorbed.packChain.some(l => l.unit === c.selectedUom)
    const needsNormalize = conv || isLevelUnit
    const needsFreeze = c.countedQtyBase == null && c.countedQty != null

    let newBase: number | null = c.countedQtyBase == null ? null : toNum(c.countedQtyBase)
    let baseChanged = false
    if (needsFreeze) {
      newBase = toNum(c.countedQty) * basePerUnit(absorbed, c.selectedUom) * k
      baseChanged = true
    } else if (newBase != null && conv) {
      newBase = newBase * k
      baseChanged = true
    }

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    if (baseChanged) { before.countedQtyBase = c.countedQtyBase; after.countedQtyBase = newBase }
    if (conv) {
      before.expectedQty = c.expectedQty; after.expectedQty = toNum(c.expectedQty) * k
      before.priceAtCount = c.priceAtCount; after.priceAtCount = toNum(c.priceAtCount) / k
    }
    if (needsNormalize && newBase != null) {
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
    const qty = toNum(n.qtyOnHand) * k
    const hit = sSnap.get(n.sessionId)
    if (hit) {
      const stronger = (SOURCE_RANK[n.source] ?? 0) > (SOURCE_RANK[hit.source] ?? 0) ? n.source : hit.source
      ops.push({ t: 'update', table: 'InventorySnapshot', id: hit.id,
        before: { qtyOnHand: hit.qtyOnHand, totalValue: hit.totalValue, source: hit.source },
        after:  { qtyOnHand: toNum(hit.qtyOnHand) + qty, totalValue: toNum(hit.totalValue) + toNum(n.totalValue), source: stronger } })
      ops.push({ t: 'delete', table: 'InventorySnapshot', row: { ...n, inventoryItemId: absorbed.id } })
    } else {
      moveSnaps.push(n.id)
      if (conv) ops.push({ t: 'update', table: 'InventorySnapshot', id: n.id,
        before: { qtyOnHand: n.qtyOnHand, unit: n.unit, pricePerBaseUnit: n.pricePerBaseUnit },
        after:  { qtyOnHand: qty, unit: survivor.baseUnit, pricePerBaseUnit: toNum(n.pricePerBaseUnit) / k } })
    }
  }
  repoint('InventorySnapshot', moveSnaps)

  // ── offers: unique (item, supplierName) ───────────────────────────────────────
  // INVARIANT: a merge NEVER deletes the survivor's primary offer, and never
  // changes which offer is primary on the survivor — food cost must not move
  // just because two supplier rows were combined. If the survivor's colliding
  // offer is primary it always wins, regardless of dates; otherwise the newer
  // `lastUpdated` wins (a tie keeps the survivor's). Moved offers are never
  // primary. The executor does NOT run a primary-election pass after this —
  // this manifest is the complete record of every write.
  const sOffer = new Map(sRel.offers.map(o => [o.supplierName, o]))
  const moveOffers: string[] = []
  let absorbedOffersDropped = 0
  let survivorOffersReplaced = 0
  for (const o of rel.offers) {
    const hit = sOffer.get(o.supplierName)
    if (hit) {
      if (hit.isPrimary || ts(hit.lastUpdated) >= ts(o.lastUpdated)) {
        ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...o, inventoryItemId: absorbed.id } })
        absorbedOffersDropped++
        continue
      }
      ops.push({ t: 'delete', table: 'InventorySupplierPrice', row: { ...hit, inventoryItemId: survivor.id } })
      survivorOffersReplaced++
    }
    if (o.isPrimary) ops.push({ t: 'update', table: 'InventorySupplierPrice', id: o.id, before: { isPrimary: true }, after: { isPrimary: false } })
    moveOffers.push(o.id)
  }
  repoint('InventorySupplierPrice', moveOffers)

  const derivedPrice = toNum(absorbed.pricing.mode === 'RATE' ? absorbed.pricing.rate : absorbed.pricing.purchasePrice)
  const synth = rel.offers.length === 0 && rel.scanItems.length > 0 && !!rel.latestPurchaseSupplier
    && !sOffer.has(rel.latestPurchaseSupplier!.supplierName) && k === 1
    && Number.isFinite(derivedPrice) && derivedPrice > 0
  if (synth) ops.push({ t: 'create', table: 'InventorySupplierPrice', row: {
    id: opts.newId(),
    inventoryItemId: survivor.id, supplierName: rel.latestPurchaseSupplier!.supplierName,
    supplierId: rel.latestPurchaseSupplier!.supplierId, isPrimary: false,
    lastPrice: derivedPrice,
    packChain: absorbed.packChain, pricing: absorbed.pricing,
  } })
  // k !== 1: the absorbed chain is denominated in another base unit, so it cannot
  // be an offer on the survivor. Frozen receivedQtyBase already preserves history.

  // ── per-RC rows: unique (rc, item) ──────────────────────────────────────────
  const sAlloc = new Map(sRel.allocations.map(a => [a.revenueCenterId, a]))
  const moveAllocs: string[] = []
  for (const a of rel.allocations) {
    const hit = sAlloc.get(a.revenueCenterId)
    if (hit) {
      ops.push({ t: 'update', table: 'StockAllocation', id: hit.id, before: { quantity: hit.quantity }, after: { quantity: toNum(hit.quantity) + toNum(a.quantity) * k } })
      ops.push({ t: 'delete', table: 'StockAllocation', row: { ...a, inventoryItemId: absorbed.id } })
    } else {
      moveAllocs.push(a.id)
      // par/reorder are in the absorbed row's COUNT unit — only meaningless on
      // the survivor when the base unit actually changed, or the two items
      // don't even share a count unit; otherwise leave them as they are.
      const clearParReorder = conv || absorbed.countUnit !== survivor.countUnit
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      if (conv) { before.quantity = a.quantity; after.quantity = toNum(a.quantity) * k }
      if (clearParReorder && (a.parLevel != null || a.reorderQty != null)) {
        before.parLevel = a.parLevel; before.reorderQty = a.reorderQty
        after.parLevel = null; after.reorderQty = null
      }
      if (Object.keys(after).length > 0)
        ops.push({ t: 'update', table: 'StockAllocation', id: a.id, before, after })
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
    ops.push({ t: 'update', table: 'InventoryItem', id: survivor.id, before: { stockOnHand: survivor.stockOnHand }, after: { stockOnHand: toNum(survivor.stockOnHand) + toNum(absorbed.stockOnHand) * k } })
  ops.push({ t: 'update', table: 'InventoryItem', id: absorbed.id,
    before: { isActive: true, mergedIntoId: null, stockOnHand: absorbed.stockOnHand },
    after:  { isActive: false, mergedIntoId: survivor.id, stockOnHand: 0 } })

  return {
    ok: true,
    manifest: { survivorId: survivor.id, absorbedId: absorbed.id, factor: k, ops },
    summary: {
      invoiceLines: rel.scanItems.length, recipeLines: rel.recipeIngredients.length, countLines: rel.countLines.length,
      snapshots: rel.snapshots.length, offersMoved: moveOffers.length, absorbedOffersDropped, survivorOffersReplaced, offerSynthesized: synth,
      factor: k, absorbedOnHand: absorbed.theoreticalOnHand, survivorOnHand: survivor.theoreticalOnHand,
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
