/**
 * The pure planners behind `scripts/repair-invoice-accuracy.ts` — the one-time
 * repair of the invoice history the Stage 5 fixes stop going wrong from now on
 * (plan 2026-10-05 item-backbone-5-invoice-accuracy, Task 5; audit 2026-10-04 §5):
 *
 *   A  `unitless-weight`  — a weight printed with no unit was frozen in grams
 *      (bison "15.775 @ $25" → 15.775 g). Re-freeze it, but only when the old
 *      and new receipts differ by a PURE unit factor (×1000, ×453.592…).
 *   B  `blocked`          — lines approve's guards refused were never received.
 *      Receive them; never re-price anything.
 *   C  `split-create-new` — the RC copy of a create-new line never got the new
 *      product. Link it (through the parent line) and carry the parent's receipt.
 *
 * Everything that needs Prisma or the per-line approve decision is computed by
 * the script and handed in as plain facts, so the rules here — who is a
 * candidate, what is written, what is only listed — are unit-tested.
 * Pure + client-safe: no Prisma, no I/O.
 */

import type { PackLink, Pricing } from '@/lib/item-model'
import { eachMeasureOf } from '@/lib/item-model'
import { formToChain } from '@/lib/item-model-form'
import { packIsTheQuantity, nonEmptyOfferChain } from '@/lib/invoice/approve-format'
import { cloneShare, isMaterialChange } from '@/lib/invoice/refreeze'

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────

export const REPAIR_MODES = ['unitless-weight', 'blocked', 'split-create-new'] as const
export type RepairMode = (typeof REPAIR_MODES)[number]

export type ParsedRepairArgs =
  | { mode: RepairMode; apply: boolean; withBoxRefresh: boolean; skip: string[] }
  | { error: string }

/** `--mode <m>` / `--mode=<m>`, `--apply`, `--with-box-refresh` (blocked only),
 *  `--skip <id,id,…>` / `--skip=<ids>` (InvoiceScanItem ids the owner set aside;
 *  any mode, dry run AND apply; repeatable). Anything else — and any run without
 *  a mode — is refused. `skip` comes back deduplicated and sorted. */
export function parseRepairArgs(argv: string[]): ParsedRepairArgs {
  let mode: string | null = null
  let apply = false
  let withBoxRefresh = false
  const skip = new Set<string>()
  const addSkip = (v: string | undefined): string | null => {
    const ids = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0 || (v ?? '').startsWith('--')) return '--skip needs one or more line ids (comma-separated).'
    ids.forEach((id) => skip.add(id))
    return null
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') apply = true
    else if (a === '--with-box-refresh') withBoxRefresh = true
    else if (a === '--mode') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) return { error: '--mode needs a value.' }
      mode = v
      i++
    } else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length)
    else if (a === '--skip') {
      const err = addSkip(argv[i + 1])
      if (err) return { error: err }
      i++
    } else if (a.startsWith('--skip=')) {
      const err = addSkip(a.slice('--skip='.length))
      if (err) return { error: err }
    } else return { error: `Unknown flag: ${a}` }
  }
  if (!mode) return { error: apply ? 'A bare --apply names no mode and is refused.' : 'No --mode given.' }
  if (!(REPAIR_MODES as readonly string[]).includes(mode)) return { error: `Unknown mode: ${mode}` }
  if (withBoxRefresh && mode !== 'blocked') return { error: '--with-box-refresh only applies to --mode blocked.' }
  return { mode: mode as RepairMode, apply, withBoxRefresh, skip: [...skip].sort() }
}

/** The plan filter: rows the owner skipped (`--skip`) leave the plan whatever
 *  their kind — never written, still listed. `unknown`: skip ids not in this run. */
export function applySkip<T extends { id: string }>(rows: T[], skip: readonly string[]): { kept: T[]; skipped: T[]; unknown: string[] } {
  const set = new Set(skip)
  const kept: T[] = []
  const skipped: T[] = []
  for (const r of rows) (set.has(r.id) ? skipped : kept).push(r)
  const seen = new Set(rows.map((r) => r.id))
  return { kept, skipped, unknown: skip.filter((id) => !seen.has(id)) }
}

// ─────────────────────────────────────────────────────────────────────────────
// A — unit-less weights
// ─────────────────────────────────────────────────────────────────────────────

/** kg↔g, lb↔g, oz↔g, kg↔lb — the only honest reasons a receipt moves by a constant. */
const PURE_FACTORS = [1000, 453.592, 28.3495, 2.20462].flatMap((f) => [f, 1 / f])

/** The pure unit factor `next / prev` is (within 0.5 %), or null. */
export function unitFactorBetween(prev: number, next: number): number | null {
  if (!(prev > 0) || !(next > 0)) return null
  const ratio = next / prev
  for (const f of PURE_FACTORS) if (Math.abs(ratio / f - 1) <= 0.005) return f
  return null
}

export interface UnitlessInput {
  id: string
  /** The stored `receivedQtyBase` (null = never frozen). */
  prev: number | null
  /** The receipt approve would freeze TODAY: `pricedByWeight ? received.base
   *  : lineReceivedBaseUnits(line, freezeFormat(speaks, newPricing))`. */
  next: number
  /** The decision is ok and took the weight path (`weightUnit` set). */
  weightPath: boolean
  /** `weightUnit.assumed` — the line itself states no unit. */
  assumed: boolean
  /** RC copies of this line: they carry `parent × share`, never the rule. */
  clones: Array<{ id: string; prev: number | null; parentTotal: unknown; cloneTotal: unknown }>
}

export type UnitlessPlan =
  | { id: string; kind: 'write'; prev: number; next: number; factor: number; clones: Array<{ id: string; prev: number | null; next: number }> }
  | { id: string; kind: 'look'; prev: number | null; next: number; reason: string }
  | { id: string; kind: 'unchanged'; prev: number | null; next: number }

/** Candidates are weight-path lines whose unit was assumed; everything else is omitted. */
export function planUnitless(rows: UnitlessInput[]): UnitlessPlan[] {
  const out: UnitlessPlan[] = []
  for (const r of rows) {
    if (!r.weightPath || !r.assumed) continue
    const { id, prev, next } = r
    if (!(next > 0)) { out.push({ id, kind: 'look', prev, next, reason: 'works out to nothing received' }); continue }
    if (prev == null) { out.push({ id, kind: 'look', prev, next, reason: 'was never frozen' }); continue }
    if (!isMaterialChange(prev, next)) { out.push({ id, kind: 'unchanged', prev, next }); continue }
    const factor = unitFactorBetween(prev, next)
    if (factor == null) {
      out.push({ id, kind: 'look', prev, next, reason: `changes ×${(next / prev).toPrecision(3)}, not a unit change` })
      continue
    }
    const clones: Array<{ id: string; prev: number | null; next: number }> = []
    let badClone: string | null = null
    for (const c of r.clones) {
      const share = cloneShare(c.parentTotal, c.cloneTotal)
      if (share == null) { badClone = c.id; break }
      clones.push({ id: c.id, prev: c.prev, next: next * share })
    }
    if (badClone) { out.push({ id, kind: 'look', prev, next, reason: `its RC copy ${badClone} has no money to share by` }); continue }
    out.push({ id, kind: 'write', prev, next, factor, clones })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// B — guard-blocked lines
// ─────────────────────────────────────────────────────────────────────────────

/** What the box refresh rule needs to know about this supplier's box. */
export interface BoxFacts {
  id: string
  isPrimary: boolean
  lastUpdated: Date
  /** Purchase date of the box's own source invoice (`lastInvoiceSessionId`); null when unknown. */
  sourcePurchaseDate: Date | null
  /** An approved line from the same supplier for the same item has a later purchase date. */
  newerSameSupplierLine: boolean
  linePurchaseDate: Date
  /** The line's session `approvedAt`. */
  sessionApprovedAt: Date | null
}

/** The offer fields approve writes to a box. */
export interface BoxWrite {
  packChain: PackLink[]
  pricing: Pricing
  packQty: number | null
  packSize: number | null
  packUOM: string | null
}

export interface BlockedInput {
  id: string
  action: string
  approved: boolean
  matchedItemId: string | null
  sessionStatus: string
  /** The line's session is an RC copy (`parentSessionId` set). */
  isClone: boolean
  splitToSessionId: string | null
  item: { isActive: boolean; mergedIntoId: string | null } | null
  /** `lineReceived(lineQtyOf(line), resolveLineFormat(item, thisSupplier'sBox)).base`. */
  receiveBase: number
  /** That same reading's `needsBridge`: the line's quantity is a weight the item
   *  can't convert, so `receiveBase` is a guess (12 lb read as 12 cases). Never received. */
  needsBridge?: boolean
  /** Today's decision: 'ok', or the reason approve would refuse it. */
  verdict: string
  /** The line's RC, else the session's (else the default). */
  rcId: string | null
  defaultRcId: string | null
  hasMembership: boolean
  hasAllocation: boolean
  /** This supplier's box (pickOffer), null when the supplier has none. */
  box: BoxFacts | null
  /** What approve would write to that box today, when computable. */
  boxWrite: BoxWrite | null
}

export type BlockedPlan =
  | {
      id: string; kind: 'write'; receivedQtyBase: number
      membership: { itemId: string; rcId: string } | null
      allocation: { itemId: string; rcId: string } | null
      boxRefresh: { boxId: string; write: BoxWrite } | null
      /** Why the box was NOT refreshed (empty when it is, or nothing was asked). */
      boxRefreshBlocked: string[]
    }
  | { id: string; kind: 'skip-split-parent' }
  | { id: string; kind: 'listed'; reason: 'switched-off' | 'merged' | 'cannot-receive' | 'needs-weight' }

const PRICED = new Set(['UPDATE_PRICE', 'ADD_SUPPLIER'])

/** Every reason the box may NOT be refreshed from this line; [] = it may. */
export function boxRefreshBlockers(box: BoxFacts | null, verdict: string): string[] {
  if (!box) return ['the supplier has no box (a repair never creates one)']
  if (box.isPrimary) return ['the box is the main box (a repair never touches it)']
  const out: string[] = []
  if (verdict !== 'ok') out.push(`the line would still be refused today (${verdict})`)
  if (box.newerSameSupplierLine) out.push('a newer invoice from this supplier exists')
  if (!box.sourcePurchaseDate || !(box.sourcePurchaseDate.getTime() < box.linePurchaseDate.getTime())) {
    out.push("the box's own invoice is not older than this line")
  }
  if (!box.sessionApprovedAt || box.lastUpdated.getTime() > box.sessionApprovedAt.getTime()) {
    out.push('the box was changed after this invoice was approved')
  }
  return out
}

export function planBlocked(rows: BlockedInput[], opts: { withBoxRefresh: boolean }): BlockedPlan[] {
  const out: BlockedPlan[] = []
  for (const r of rows) {
    if (r.approved || !PRICED.has(r.action) || !r.matchedItemId || r.sessionStatus !== 'APPROVED' || r.isClone) continue
    if (r.splitToSessionId) { out.push({ id: r.id, kind: 'skip-split-parent' }); continue }
    if (r.item?.mergedIntoId) { out.push({ id: r.id, kind: 'listed', reason: 'merged' }); continue }
    if (r.item && !r.item.isActive) { out.push({ id: r.id, kind: 'listed', reason: 'switched-off' }); continue }
    if (!(r.receiveBase > 0)) { out.push({ id: r.id, kind: 'listed', reason: 'cannot-receive' }); continue }
    // Approve's receive-only rule: a weight the item can't convert is never received.
    if (r.needsBridge) { out.push({ id: r.id, kind: 'listed', reason: 'needs-weight' }); continue }

    const itemId = r.matchedItemId
    const membership = r.rcId && !r.hasMembership ? { itemId, rcId: r.rcId } : null
    const allocation = r.rcId && r.rcId !== r.defaultRcId && !r.hasAllocation ? { itemId, rcId: r.rcId } : null

    let boxRefresh: { boxId: string; write: BoxWrite } | null = null
    let boxRefreshBlocked: string[] = []
    if (opts.withBoxRefresh) {
      boxRefreshBlocked = boxRefreshBlockers(r.box, r.verdict)
      if (boxRefreshBlocked.length === 0 && !r.boxWrite) boxRefreshBlocked = ['the box write could not be worked out']
      if (boxRefreshBlocked.length === 0) boxRefresh = { boxId: r.box!.id, write: r.boxWrite! }
    }
    out.push({ id: r.id, kind: 'write', receivedQtyBase: r.receiveBase, membership, allocation, boxRefresh, boxRefreshBlocked })
  }
  return out
}

/** The decision facts the approve route's offer write reads. */
export interface OfferWriteDecision {
  isUomMode: boolean
  resolvedRateUnit: string
  reverseBridge: boolean
  reverseBasePerCase: number
  newPurchasePrice: number
}

/**
 * The box fields approve writes for this line — the route's offer-chain rule
 * (approve/route.ts, "Per-offer pack chain + pricing"), reproduced so the
 * refresh writes exactly what an approval of this line would have.
 * `heldChain` is this supplier's current box chain (null/empty → the item's).
 */
export function boxRefreshWrite(a: {
  line: { invoicePackQty: unknown; invoicePackSize: unknown; invoicePackUOM: string | null; rawUnitPrice: unknown; rawUnit: string | null }
  item: { dimension: string; baseUnit: string | null; countUnit: string | null; packChain: unknown; eachMeasureQty: unknown; eachMeasureUnit: string | null }
  heldChain: unknown
  d: OfferWriteDecision
}): BoxWrite {
  const { line, item, d } = a
  const itemChain = (Array.isArray(item.packChain) ? item.packChain : []) as PackLink[]
  const itemTopUnit = itemChain[0]?.unit
  const itemBridge = eachMeasureOf(item)
  const hasLinePack = line.invoicePackQty != null && line.invoicePackSize != null
  const offerLastPrice = d.isUomMode
    ? d.newPurchasePrice
    : (hasLinePack && line.rawUnitPrice != null ? Number(line.rawUnitPrice) : d.newPurchasePrice)
  const offerPack = hasLinePack
    ? { packQty: Number(line.invoicePackQty), packSize: Number(line.invoicePackSize), packUOM: line.invoicePackUOM ?? 'each' }
    : { packQty: null, packSize: null, packUOM: null }
  const lineQtyIsNotAPack = packIsTheQuantity({
    isUomMode: d.isUomMode, rateUnit: d.resolvedRateUnit, item: { dimension: item.dimension, baseUnit: item.baseUnit },
  })
  const held = Array.isArray(a.heldChain) && (a.heldChain as PackLink[]).length ? (a.heldChain as PackLink[]) : itemChain
  const top = itemTopUnit ?? line.rawUnit ?? 'case'

  let chain: { packChain: PackLink[]; pricing: Pricing }
  if (d.reverseBridge && d.reverseBasePerCase > 0) {
    chain = { packChain: [{ unit: top, per: d.reverseBasePerCase }], pricing: { mode: 'PACK', purchasePrice: offerLastPrice } }
  } else if (hasLinePack && !lineQtyIsNotAPack) {
    const c = formToChain({
      purchaseUnit:       top,
      purchasePrice:      offerLastPrice,
      qtyPerPurchaseUnit: Number(line.invoicePackQty),
      qtyUOM:             'each',
      innerQty:           null,
      packSize:           (itemBridge && !d.isUomMode) ? 1 : Number(line.invoicePackSize),
      packUOM:            d.isUomMode ? d.resolvedRateUnit : (itemBridge ? 'each' : (line.invoicePackUOM ?? 'each')),
      priceType:          d.isUomMode ? 'UOM' : 'CASE',
      countUOM:           item.countUnit ?? 'each',
      baseUnit:           item.baseUnit ?? undefined,
    })
    chain = { packChain: c.packChain, pricing: c.pricing }
  } else {
    chain = {
      packChain: d.isUomMode ? nonEmptyOfferChain(held, top) : held,
      pricing: d.isUomMode
        ? { mode: 'RATE', rate: offerLastPrice, rateUnit: d.resolvedRateUnit }
        : { mode: 'PACK', purchasePrice: offerLastPrice },
    }
  }
  return { ...chain, ...offerPack }
}

const NOTE_MARK = 'by the invoice-accuracy repair'

/** The session's note, with one plain sentence appended — once. */
export function appendRepairNote(prev: string | null, n: number, date: string): string {
  if (prev?.includes(NOTE_MARK)) return prev
  const sentence = `Stock for ${n} line${n === 1 ? '' : 's'} was received on ${date} ${NOTE_MARK}; prices were left as they were.`
  const head = (prev ?? '').trim()
  return head ? `${head} ${sentence}` : sentence
}

// ─────────────────────────────────────────────────────────────────────────────
// C — create-new lines on RC-split invoices
// ─────────────────────────────────────────────────────────────────────────────

export interface SplitCloneInput {
  id: string
  parentSessionId: string
  rawDescription: string
  sortOrder: number
  rawLineTotal: unknown
  receivedQtyBase: number | null
  /** The copy's RC (its own, else its session's). */
  rcId: string | null
}

export interface ParentLineInput {
  id: string
  sessionId: string
  rawDescription: string
  sortOrder: number
  matchedItemId: string | null
  receivedQtyBase: number | null
  rawLineTotal: unknown
}

export type SplitPlan =
  | {
      id: string; kind: 'write'; itemId: string; itemName: string; share: number
      /** null = keep the receipt the copy already has. */
      receivedQtyBase: number | null
      kept: { value: number; fromParent: number | null; differs: boolean } | null
      membership: { itemId: string; rcId: string } | null
      flags: string[]
    }
  | { id: string; kind: 'look'; reason: string }

/** The clone → parent key: both fields are copied onto the copy unchanged (approve's scaledCopy). */
const parentKey = (sessionId: string, rawDescription: string, sortOrder: number) => `${sessionId}|${rawDescription}|${sortOrder}`

export function planSplitCreateNew(a: {
  clones: SplitCloneInput[]
  /** Lines of the parent sessions (any state). */
  parents: ParentLineInput[]
  /** Parent session id → targetIds of its ITEM_CREATED undo records. */
  itemCreatedBySession: Map<string, string[]>
  items: Map<string, { name: string; isActive: boolean; mergedIntoId: string | null }>
  /** `${itemId}|${rcId}` of existing ItemRevenueCenter rows. */
  memberships: Set<string>
}): SplitPlan[] {
  const byKey = new Map<string, ParentLineInput[]>()
  for (const p of a.parents) {
    const k = parentKey(p.sessionId, p.rawDescription, p.sortOrder)
    const list = byKey.get(k)
    if (list) list.push(p)
    else byKey.set(k, [p])
  }
  return a.clones.map((c): SplitPlan => {
    const found = byKey.get(parentKey(c.parentSessionId, c.rawDescription, c.sortOrder)) ?? []
    if (found.length !== 1) {
      return { id: c.id, kind: 'look', reason: found.length === 0 ? 'its original line was not found' : `${found.length} original lines match it` }
    }
    const parent = found[0]
    const itemId = parent.matchedItemId
    if (!itemId) return { id: c.id, kind: 'look', reason: 'its original line has no product' }
    const created = a.itemCreatedBySession.get(c.parentSessionId) ?? []
    if (created.length > 0 && !created.includes(itemId)) {
      return { id: c.id, kind: 'look', reason: "the invoice's record of the product it created names a different product" }
    }
    const item = a.items.get(itemId)
    if (!item) return { id: c.id, kind: 'look', reason: 'the product no longer exists' }
    if (item.mergedIntoId) return { id: c.id, kind: 'look', reason: 'the product was merged into another one' }
    const share = cloneShare(parent.rawLineTotal, c.rawLineTotal)
    if (share == null) return { id: c.id, kind: 'look', reason: 'no money on the line to share the receipt by' }

    const fromParent = parent.receivedQtyBase != null && parent.receivedQtyBase > 0 ? parent.receivedQtyBase * share : null
    let receivedQtyBase: number | null = null
    let kept: { value: number; fromParent: number | null; differs: boolean } | null = null
    if (c.receivedQtyBase != null && c.receivedQtyBase > 0) {
      kept = { value: c.receivedQtyBase, fromParent, differs: fromParent != null && isMaterialChange(c.receivedQtyBase, fromParent) }
    } else if (fromParent != null) {
      receivedQtyBase = fromParent
    } else {
      return { id: c.id, kind: 'look', reason: 'its original line has no frozen receipt to share' }
    }
    const membership = c.rcId && !a.memberships.has(`${itemId}|${c.rcId}`) ? { itemId, rcId: c.rcId } : null
    return {
      id: c.id, kind: 'write', itemId, itemName: item.name, share, receivedQtyBase, kept, membership,
      flags: item.isActive ? [] : ['switched-off'],
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// --apply safety
// ─────────────────────────────────────────────────────────────────────────────

/** A number as the plan records it: 10 significant figures, so float noise
 *  between two runs of the same computation never reads as a change. */
const roundNum = (n: number) => (Number.isFinite(n) ? Number(n.toPrecision(10)) : n)
function canonical(v: unknown): unknown {
  if (typeof v === 'number') return roundNum(v)
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonical((v as Record<string, unknown>)[k])
    return out
  }
  return v instanceof Date ? v.toISOString() : v
}

/** What a plan key will write, as one stable string (sorted keys, rounded numbers). */
export function planValue(v: unknown): string {
  return JSON.stringify(canonical(v))
}

/**
 * `--apply` recomputes; it may only differ from the reviewed dry run by rows
 * already applied — and every row it would still write must write the SAME
 * value the owner reviewed (`changed` otherwise).
 */
export function compareToReviewed(a: { reviewed: Record<string, string>; fresh: Record<string, string>; applied: string[] }): {
  ok: boolean; added: string[]; missing: string[]; changed: string[]
} {
  const applied = new Set(a.applied)
  const added = Object.keys(a.fresh).filter((k) => !(k in a.reviewed))
  const missing = Object.keys(a.reviewed).filter((k) => !(k in a.fresh) && !applied.has(k))
  const changed = Object.keys(a.fresh).filter((k) => k in a.reviewed && a.reviewed[k] !== a.fresh[k])
  return { ok: added.length === 0 && missing.length === 0 && changed.length === 0, added, missing, changed }
}

/** The reviewed dry run, as written to `invoice-accuracy-<mode>-plan.json`. */
export interface RepairPlanFile {
  mode: RepairMode
  withBoxRefresh: boolean
  /** The `--skip` ids of that dry run (sorted). */
  skip: string[]
  createdAt: string
  /** plan key → the value it writes (`planValue`). */
  entries: Record<string, string>
}

const sameIds = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** The whole `--apply` guard: same mode and flags, same `--skip`, same rows, same values. */
export function checkAgainstReviewed(a: {
  file: unknown
  mode: RepairMode
  withBoxRefresh: boolean
  skip: readonly string[]
  fresh: Record<string, string>
  applied: string[]
}): { ok: boolean; problems: string[] } {
  const f = a.file as Partial<RepairPlanFile> | null
  if (!f) return { ok: false, problems: ['No dry run on record. Run the dry run first and review it.'] }
  if (!f.entries || typeof f.entries !== 'object' || !Array.isArray(f.skip)) {
    return { ok: false, problems: ['The dry run on record is from an older version of this script (it did not record values or --skip). Run the dry run again.'] }
  }
  if (f.mode !== a.mode || !!f.withBoxRefresh !== a.withBoxRefresh) {
    return { ok: false, problems: [`The reviewed dry run was for --mode ${f.mode}${f.withBoxRefresh ? ' --with-box-refresh' : ''}. Re-run the dry run with the same flags.`] }
  }
  if (!sameIds(f.skip, a.skip)) {
    const words = (ids: readonly string[]) => (ids.length ? ids.join(',') : 'nothing')
    return { ok: false, problems: [`The dry run skipped ${words(f.skip)}; this run skips ${words(a.skip)}. Run the dry run again with the same --skip.`] }
  }
  const cmp = compareToReviewed({ reviewed: f.entries, fresh: a.fresh, applied: a.applied })
  if (cmp.ok) return { ok: true, problems: [] }
  const problems: string[] = []
  if (cmp.changed.length) problems.push('Rows changed since the dry run — run it again.', `  changed: ${cmp.changed.join(', ')}`)
  if (cmp.added.length) problems.push('The lines to repair are not the ones the reviewed dry run listed.', `  new since the dry run: ${cmp.added.join(', ')}`)
  if (cmp.missing.length) problems.push(...(cmp.added.length ? [] : ['The lines to repair are not the ones the reviewed dry run listed.']), `  gone since the dry run (not by this repair): ${cmp.missing.join(', ')}`)
  return { ok: false, problems }
}
