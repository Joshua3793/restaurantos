/**
 * Repair the products created from a by-weight invoice line with the wrong
 * dimension — and re-freeze everything that was frozen through that shape.
 *
 *   npx tsx scripts/repair-create-new-shape.ts --item <id> [--item <id> …]
 *       [--measure <itemId>=<unit>]
 *       [--count-unit-override <countLineId>=<unit>]
 *       [--apply]
 *
 *   # DRY RUN (default, writes nothing to the database):
 *   npx tsx scripts/repair-create-new-shape.ts --item abc --item def
 *   # after a human has read the diff:
 *   npx tsx scripts/repair-create-new-shape.ts --item abc --count-unit-override cl-9=lb --apply
 *
 * ONLY the items named with `--item` are touched — there is no "repair
 * everything that looks wrong" mode. `scripts/audit-create-new-shape.ts`
 * (read-only) finds the ids and prints the exact command.
 *
 * What it plans, per item (all of it in src/lib/invoice/create-new-repair.ts,
 * unit-tested without a database):
 *
 *   1. ITEM     → `{ MASS|VOLUME, g|ml, [{unit: <measure>, per: conv}],
 *                   RATE <unchanged rate>/<measure>, countUnit <measure> }` —
 *                 field for field what `formToChain` produces from the by-weight
 *                 seed today, plus the legacy `purchasePrice` column that
 *                 `syncPrimaryOfferToItem` keeps in step with `pricing`. The rate
 *                 NUMBER never moves: $1.99 was always $1.99 per lb; only its
 *                 label was wrong.
 *   2. OFFERS   → EVERY `InventorySupplierPrice` of the item gets the corrected
 *                 chain, a `$rate/<measure>` pricing and the matching human
 *                 format (`packQty/packSize/packUOM` = 1 / 1 / measure).
 *                 `lastPrice` is never written. This is not tidying: the primary
 *                 offer's chain+pricing is copied STRAIGHT back onto the item by
 *                 `syncPrimaryOfferToItem` on the next invoice from that
 *                 supplier, so an untouched offer re-breaks the repaired item on
 *                 the next delivery.
 *   3. RECEIPTS → `InvoiceScanItem.receivedQtyBase` recomputed by `lineReceived`
 *                 against the corrected item, with the frozen value deliberately
 *                 NOT passed back in. RC split clones take a share of their
 *                 parent's new value (`cloneShare`), never the rule.
 *   4. COUNTS   → `CountLine.countedQtyBase` recomputed by `lineCountedBase` with
 *                 `countedQtyBase: null`, `priceAtCount` refreshed to the
 *                 corrected ppb, and the `InventorySnapshot` finalize wrote from
 *                 it refreshed (`qtyOnHand`, `unit = baseUnit`,
 *                 `pricePerBaseUnit`, `totalValue = qty × ppb` — mirroring
 *                 src/lib/count-finalize.ts). A snapshot whose stored qtyOnHand
 *                 is not this line's frozen base was not written from this line
 *                 and is left alone, listed as a mismatch. A SKIPPED/THEORETICAL
 *                 line's snapshot keeps its (expected) quantity but has its
 *                 `unit` label corrected, so no `each` snapshot survives on a
 *                 MASS item.
 *   5. STOCK    → `InventoryItem.stockOnHand`, `InventoryItem.lastCountQty`, and
 *                 `StockAllocation.quantity` are BASELINES read straight off the
 *                 row (`count-expected.ts`, `inventory-list.ts`; the count page
 *                 shows `lastCountQty` as "Last count: …"), written by finalize
 *                 in the OLD base unit. Each is re-set from the corrected
 *                 quantity of the latest OBSERVED count that wrote it, routed
 *                 exactly as `count-finalize.ts` routes it (unscoped/default RC
 *                 → global stockOnHand; non-default RC → that RC's allocation).
 *                 `lastCountQty` is written by BOTH branches of finalize, so it
 *                 takes the latest observed count across ALL of the item's
 *                 sessions, scoped or not — the one baseline with no RC filter.
 *                 No observed count for a target ⇒ left alone and said so.
 *   6. SESSIONS → `CountSession.totalCountedValue` is a STORED sum of its
 *                 snapshots and goes stale the moment one is rewritten. Each
 *                 touched session is re-summed over its OBSERVED snapshots only
 *                 (COUNTED/CARRIED — src/lib/count-snapshot-source.ts), exactly
 *                 as finalize sums them.
 *
 * NOT rewritten, deliberately: `CountLine.variancePct` / `varianceCost`. The
 * formula is finalize's — `(qtyBase − expectedQty) × ppb` — but `expectedQty` is
 * itself frozen in the OLD base unit and is not part of this repair, so
 * recomputing would subtract a stale expectation from a corrected count and
 * produce a confident, wrong number. The dry run says so per item.
 *
 * The measure unit comes from the item's own most recent by-weight approved line
 * (`lineMeasureUnit`); `--measure <itemId>=lb` overrides it, and an item with no
 * evidence and no override is refused rather than guessed.
 *
 * A count entered in a unit the CORRECTED item gives no meaning (Salami's
 * "3.135 each" — the corrected item has no `each` level) is reported
 * `needsDecision` and BLOCKS `--apply` for that item until a human resolves it
 * with `--count-unit-override <countLineId>=<unit>`.
 *
 * `--apply` writes `create-new-repair-backup-<stamp>.json` with every previous
 * value BEFORE the first write, then, per item, RE-READS every row it is about
 * to touch and skips the WHOLE item if any of them moved since planning — the
 * diff a human approved is never replayed blind. Each item's writes go in one
 * `$transaction`, so an item is never half-repaired. Session totals are the one
 * cross-item write (two repaired items can share a count session), so they are
 * summed once over ALL plans and written in a final transaction, only for
 * sessions whose every contributing item applied. ORM only.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, type ChainItem } from '../src/lib/item-model'
import { lineMeasureUnit } from '../src/lib/invoice/create-new-seed'
import {
  isSelfContradictory, planItemRewrite, planReceiptRefreeze, planCountRefreeze,
  planOfferRewrite, planStockRewrite, planSessionTotals, isMaterial,
  type ItemRewrite, type ReceiptLine, type CountLineRow, type ReceiptRefreezeRow, type CountRefreezeRow,
  type OfferRewriteRow, type StockRewrite, type StockCountRow, type SessionTotalRow,
} from '../src/lib/invoice/create-new-repair'

// ── flags ───────────────────────────────────────────────────────────────────

interface Flags { itemIds: string[]; measures: Map<string, string>; countUnits: Map<string, string>; apply: boolean }

function parseFlags(argv: string[]): Flags | { error: string } {
  const itemIds: string[] = []
  const measures = new Map<string, string>()
  const countUnits = new Map<string, string>()
  let apply = false
  const pair = (v: string | undefined, flag: string): { k: string; v: string } | { error: string } => {
    const i = (v ?? '').indexOf('=')
    if (i <= 0 || i === (v ?? '').length - 1) return { error: `${flag} expects <id>=<unit>, got "${v ?? ''}"` }
    return { k: v!.slice(0, i), v: v!.slice(i + 1) }
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') { apply = true; continue }
    if (a === '--item') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) return { error: '--item expects an inventory item id' }
      itemIds.push(v); continue
    }
    if (a === '--measure' || a === '--count-unit-override') {
      const p = pair(argv[++i], a)
      if ('error' in p) return p
      ;(a === '--measure' ? measures : countUnits).set(p.k, p.v)
      continue
    }
    return { error: `Unknown flag: ${a}` }
  }
  if (itemIds.length === 0) return { error: 'No --item given. This script only ever touches items named explicitly.' }
  // A --measure for an item that is not being repaired silently does nothing —
  // and the likeliest cause is a typo in the id, i.e. the item you meant to force
  // is about to be rebuilt around a unit you did not choose. Refuse.
  const stray = [...measures.keys()].filter((id) => !itemIds.includes(id))
  if (stray.length > 0) {
    return {
      error: `--measure names item id(s) that were not passed with --item: ${stray.join(', ')}. ` +
        `Add --item <id> for each, or fix the id — a --measure for an unrepaired item does nothing.`,
    }
  }
  return { itemIds, measures, countUnits, apply }
}

const USAGE =
  'Usage: repair-create-new-shape.ts --item <id> [--item <id> …] ' +
  '[--measure <itemId>=<unit>] [--count-unit-override <countLineId>=<unit>] [--apply]'

const flags = parseFlags(process.argv.slice(2))
if ('error' in flags) {
  console.error(flags.error)
  console.error(USAGE)
  process.exit(2)
}
const { itemIds, measures, countUnits, apply: APPLY } = flags
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// ── loads ───────────────────────────────────────────────────────────────────

async function fetchItems(ids: string[]) {
  return prisma.inventoryItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, itemName: true, stockOnHand: true, purchasePrice: true, lastCountQty: true, ...PRICING_SELECT },
  })
}
type ItemRow = Awaited<ReturnType<typeof fetchItems>>[number]

async function fetchOffers(ids: string[]) {
  return prisma.inventorySupplierPrice.findMany({
    where: { inventoryItemId: { in: ids } },
    select: {
      id: true, inventoryItemId: true, supplierName: true, isPrimary: true, lastPrice: true,
      packChain: true, pricing: true, packQty: true, packSize: true, packUOM: true,
    },
    orderBy: [{ isPrimary: 'desc' }, { supplierName: 'asc' }],
  })
}
type OfferRowDb = Awaited<ReturnType<typeof fetchOffers>>[number]

async function fetchLines(ids: string[]) {
  return prisma.invoiceScanItem.findMany({
    where: { matchedItemId: { in: ids }, approved: true, session: { status: 'APPROVED' } },
    select: {
      id: true, matchedItemId: true, sessionId: true, sortOrder: true, rawDescription: true,
      rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true, rateUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      rawUnitPrice: true, rate: true, rawLineTotal: true, receivedQtyBase: true,
      pricingMode: true, newPrice: true, action: true,
      session: { select: { parentSessionId: true, invoiceNumber: true, supplierName: true, purchaseDate: true } },
    },
  })
}
type ScanLine = Awaited<ReturnType<typeof fetchLines>>[number]

async function fetchCountLines(ids: string[]) {
  return prisma.countLine.findMany({
    where: { inventoryItemId: { in: ids } },
    select: {
      id: true, inventoryItemId: true, sessionId: true, countedQty: true, selectedUom: true,
      entries: true, countedQtyBase: true, skipped: true, priceAtCount: true,
      variancePct: true, varianceCost: true,
      session: {
        select: {
          label: true, sessionDate: true, status: true, revenueCenterId: true,
          totalCountedValue: true,
          revenueCenter: { select: { isDefault: true, name: true } },
        },
      },
    },
    // CountLine has no createdAt — `latestObserved`'s tie-break is INPUT ORDER
    // (last row wins on a shared sessionDate), so the input must be
    // deterministic rather than left to Postgres row order. `id` (uuid, not
    // chronological) is only a stable secondary key, not a claim about which
    // line was entered later within the same day.
    orderBy: [{ session: { sessionDate: 'asc' } }, { id: 'asc' }],
  })
}
type CountRow = Awaited<ReturnType<typeof fetchCountLines>>[number]

async function fetchSnapshots(ids: string[]) {
  return prisma.inventorySnapshot.findMany({
    where: { inventoryItemId: { in: ids } },
    select: { id: true, sessionId: true, inventoryItemId: true, qtyOnHand: true, unit: true, pricePerBaseUnit: true, totalValue: true, source: true },
  })
}
type SnapshotRow = Awaited<ReturnType<typeof fetchSnapshots>>[number]

/** EVERY snapshot of the given sessions — a session total is the sum of all of
 *  them, not of the repaired item's share. */
async function fetchSessionSnapshots(sessionIds: string[]) {
  if (sessionIds.length === 0) return []
  return prisma.inventorySnapshot.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true, sessionId: true, source: true, totalValue: true },
  })
}

async function fetchSessions(sessionIds: string[]) {
  if (sessionIds.length === 0) return []
  return prisma.countSession.findMany({
    where: { id: { in: sessionIds } },
    select: { id: true, label: true, sessionDate: true, totalCountedValue: true },
  })
}

const dec = (v: unknown): string | null => (v == null ? null : String(v))
const n = (v: unknown): number => Number(v)

/** The receiving inputs of a scan line, WITHOUT the frozen receipt (the planner
 *  strips it too — belt and braces, and it documents the intent here). */
function receiptLineOf(l: ScanLine, parentId: string | null): ReceiptLine {
  return {
    id: l.id,
    parentLineId: parentId,
    rawQty: dec(l.rawQty), rawUnit: l.rawUnit,
    totalQty: dec(l.totalQty), totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM,
    invoicePackQty: dec(l.invoicePackQty), invoicePackSize: dec(l.invoicePackSize), invoicePackUOM: l.invoicePackUOM,
    rawUnitPrice: dec(l.rawUnitPrice), rate: dec(l.rate), rawLineTotal: dec(l.rawLineTotal),
    receivedQtyBase: dec(l.receivedQtyBase),
  }
}

const seedLineOf = (l: ScanLine) => ({
  pricingMode: l.pricingMode, rateUOM: l.rateUOM, totalQtyUOM: l.totalQtyUOM, rawUnit: l.rawUnit,
  rate: l.rate, rawUnitPrice: l.rawUnitPrice, newPrice: l.newPrice,
  invoicePackQty: l.invoicePackQty, invoicePackSize: l.invoicePackSize, invoicePackUOM: l.invoicePackUOM,
})

/** The measure unit to rebuild the item around: the human's `--measure` first,
 *  else the most recent approved line that names one (CREATE_NEW lines first —
 *  that is the line the item was born from). Null ⇒ refuse the item. */
function measureFor(item: ItemRow, lines: ScanLine[]): { unit: string; from: string } | null {
  const forced = measures.get(item.id)
  if (forced) return { unit: forced, from: '--measure' }
  const dated = [...lines].sort((a, b) => {
    if ((a.action === 'CREATE_NEW') !== (b.action === 'CREATE_NEW')) return a.action === 'CREATE_NEW' ? -1 : 1
    return (b.session.purchaseDate?.getTime() ?? 0) - (a.session.purchaseDate?.getTime() ?? 0)
  })
  for (const l of dated) {
    const u = lineMeasureUnit(seedLineOf(l))
    if (u) return { unit: u, from: `${l.action} line ${l.session.invoiceNumber ?? '?'} · ${l.rawDescription}` }
  }
  return null
}

// ── plan ────────────────────────────────────────────────────────────────────

interface ItemPlan {
  item: ItemRow
  measure: string
  measureFrom: string
  rewrite: ItemRewrite
  corrected: ChainItem
  ppb: number
  ppbBefore: number
  offers: (OfferRewriteRow & { offer: OfferRowDb })[]
  receipts: (ReceiptRefreezeRow & { line: ScanLine })[]
  counts: (CountRefreezeRow & { line: CountRow; snapshotPrev?: SnapshotRow; snapshotUnitPrev?: SnapshotRow })[]
  stock: StockRewrite
  blocked: string[]
}

function planFor(
  item: ItemRow, lines: ScanLine[], countRows: CountRow[], snaps: SnapshotRow[],
  allocations: { revenueCenterId: string; quantity: unknown }[], offers: OfferRowDb[],
): ItemPlan | { item: ItemRow; error: string } {
  const m = measureFor(item, lines)
  if (!m) {
    return { item, error: 'no approved line names a weight/volume unit — pass --measure <itemId>=<unit> if you know it' }
  }
  const rewrite = planItemRewrite({ item, measure: m.unit })
  const corrected = asChainItem({ ...item, ...rewrite })
  const ppb = pricePerBaseUnit(corrected)

  // Clone→parent key, identical to scripts/backfill-received-qty-base.ts:
  // parentSessionId|rawDescription|sortOrder. Two parents at one key make every
  // clone there ambiguous — the planner then leaves those clones alone.
  const byKey = new Map<string, ScanLine>()
  const ambiguous = new Set<string>()
  for (const l of lines) {
    if (l.session.parentSessionId) continue
    const key = `${l.sessionId}|${l.rawDescription}|${l.sortOrder}`
    if (byKey.has(key)) ambiguous.add(key)
    else byKey.set(key, l)
  }
  for (const k of ambiguous) byKey.delete(k)

  const receiptInputs = lines.map((l) => {
    const parent = l.session.parentSessionId
      ? byKey.get(`${l.session.parentSessionId}|${l.rawDescription}|${l.sortOrder}`) ?? null
      : null
    return receiptLineOf(l, parent?.id ?? null)
  })
  const linesById = new Map(lines.map((l) => [l.id, l]))
  const receipts = planReceiptRefreeze(receiptInputs, corrected).map((r) => ({ ...r, line: linesById.get(r.id)! }))

  const snapByKey = new Map(snaps.map((s) => [`${s.sessionId}|${s.inventoryItemId}`, s]))
  const countInputs: CountLineRow[] = countRows.map((c) => {
    const snap = snapByKey.get(`${c.sessionId}|${c.inventoryItemId}`)
    return {
      id: c.id,
      countedQty: c.countedQty != null ? Number(c.countedQty) : null,
      selectedUom: c.selectedUom,
      entries: c.entries,
      countedQtyBase: c.countedQtyBase != null ? Number(c.countedQtyBase) : null,
      skipped: c.skipped,
      snapshot: snap ? { id: snap.id, qtyOnHand: Number(snap.qtyOnHand), unit: snap.unit } : null,
      unitOverride: countUnits.get(c.id) ?? null,
    }
  })
  const countsById = new Map(countRows.map((c) => [c.id, c]))
  const snapById = new Map(snaps.map((s) => [s.id, s]))
  const counts = planCountRefreeze(countInputs, corrected, ppb).map((r) => ({
    ...r,
    line: countsById.get(r.id)!,
    snapshotPrev: r.snapshot ? snapById.get(r.snapshot.id) : undefined,
    snapshotUnitPrev: r.snapshotUnitOnly ? snapById.get(r.snapshotUnitOnly.id) : undefined,
  }))

  // The stock baselines read the SAME corrected quantities, routed the way
  // count-finalize routed the originals.
  const stockCountRows: StockCountRow[] = counts.map((c) => ({
    id: c.id,
    next: c.next,
    skipped: c.line.skipped,
    countedQty: c.line.countedQty != null ? Number(c.line.countedQty) : null,
    sessionDate: c.line.session.sessionDate,
    revenueCenterId: c.line.session.revenueCenterId,
    rcIsDefault: c.line.session.revenueCenter?.isDefault ?? false,
  }))
  const stock = planStockRewrite({ item, allocations, countLines: stockCountRows, rewrite })

  const blocked = counts
    .filter((c) => c.needsDecision)
    .map((c) => `count line ${c.id} (${c.via}) — resolve with --count-unit-override ${c.id}=<unit>`)

  return {
    item, measure: m.unit, measureFrom: m.from, rewrite, corrected, ppb,
    ppbBefore: pricePerBaseUnit(asChainItem(item)),
    offers: offers.map((o) => ({ ...planOfferRewrite(o, rewrite), offer: o })),
    receipts, counts, stock, blocked,
  }
}

// ── print ───────────────────────────────────────────────────────────────────

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 })
const offerMoved = (o: OfferRewriteRow): boolean =>
  JSON.stringify(o.before.packChain ?? null) !== JSON.stringify(o.packChain) ||
  JSON.stringify(o.before.pricing ?? null) !== JSON.stringify(o.pricing) ||
  o.before.packQty !== o.packQty || o.before.packSize !== o.packSize || o.before.packUOM !== o.packUOM

function printPlan(p: ItemPlan) {
  const i = p.item
  console.log(`\n────────────────────────────────────────────────────────────`)
  console.log(`${i.itemName}   (${i.id})`)
  console.log(`  measure: ${p.measure}   [from ${p.measureFrom}]`)
  console.log(`  shape flags: ${isSelfContradictory(i).join(' · ') || '(none — evidence-only finding)'}`)
  console.log(`  before: ${i.dimension}/${i.baseUnit}  chain ${JSON.stringify(i.packChain)}  pricing ${JSON.stringify(i.pricing)}  count ${i.countUnit}  →  $${p.ppbBefore.toFixed(6)}/${i.baseUnit}`)
  console.log(`  after : ${p.rewrite.dimension}/${p.rewrite.baseUnit}  chain ${JSON.stringify(p.rewrite.packChain)}  pricing ${JSON.stringify(p.rewrite.pricing)}  count ${p.rewrite.countUnit}  →  $${p.ppb.toFixed(6)}/${p.rewrite.baseUnit}`)
  console.log(`  purchasePrice (legacy column): ${fmt(p.stock.purchasePrice.old)} → ${fmt(p.stock.purchasePrice.next)}`)

  console.log(`\n  SUPPLIER OFFERS (${p.offers.length})` +
    `   — the primary offer's chain+pricing is copied back onto the item by syncPrimaryOfferToItem on the next invoice`)
  if (p.offers.length === 0) console.log('    (none — this item authors its own pricing)')
  else console.table(p.offers.map((o) => ({
    supplier: o.offer.supplierName,
    primary: o.offer.isPrimary ? 'PRIMARY' : '',
    'chain before': JSON.stringify(o.before.packChain),
    'chain after': JSON.stringify(o.packChain),
    'pricing before': JSON.stringify(o.before.pricing),
    'pricing after': JSON.stringify(o.pricing),
    'format before': `${o.before.packQty ?? '—'} × ${o.before.packSize ?? '—'} ${o.before.packUOM ?? '—'}`,
    'format after': `${o.packQty} × ${o.packSize} ${o.packUOM}`,
    rate: `${fmt(o.rate)} [${o.rateFrom}]`,
    'lastPrice (untouched)': fmt(n(o.offer.lastPrice)),
    change: offerMoved(o) ? 'WRITE' : '—',
    id: o.id,
  })))

  console.log(`\n  RECEIPTS (${p.receipts.length})`)
  if (p.receipts.length === 0) console.log('    (none)')
  else console.table(p.receipts.map((r) => ({
    invoice: r.line.session.invoiceNumber ?? '?',
    supplier: r.line.session.supplierName ?? '?',
    description: r.line.rawDescription,
    qty: `${r.line.rawQty?.toString() ?? '?'} ${r.line.rawUnit ?? ''}`.trim(),
    old: r.old == null ? '(null)' : fmt(r.old),
    next: fmt(r.next),
    via: r.via,
    change: isMaterial(r.old, r.next) ? 'WRITE' : '—',
    id: r.id,
  })))

  console.log(`\n  COUNT LINES (${p.counts.length})`)
  if (p.counts.length === 0) console.log('    (none)')
  else console.table(p.counts.map((c) => ({
    session: c.line.session.label,
    rc: c.line.session.revenueCenter?.name ?? '(unscoped)',
    date: c.line.session.sessionDate.toISOString().slice(0, 10),
    entered: `${c.line.countedQty?.toString() ?? '(blank)'} ${c.line.selectedUom}`,
    old: c.old == null ? '(null)' : fmt(c.old),
    next: fmt(c.next),
    via: c.via,
    priceAtCount: c.priceAtCount == null
      ? '—'
      : `${n(c.line.priceAtCount).toFixed(6)} → ${c.priceAtCount.toFixed(6)}`,
    decide: c.needsDecision ? 'NEEDS DECISION' : '',
    snapshot: c.snapshot
      ? `${c.snapshot.id.slice(0, 8)}… ${fmt(n(c.snapshotPrev?.qtyOnHand))} ${c.snapshotPrev?.unit} $${n(c.snapshotPrev?.totalValue).toFixed(2)} → ${fmt(c.snapshot.qtyOnHand)} ${c.snapshot.unit} $${c.snapshot.totalValue.toFixed(2)}`
      : c.snapshotUnitOnly
        ? `${c.snapshotUnitOnly.id.slice(0, 8)}… ${c.snapshotUnitOnly.from} → ${c.snapshotUnitOnly.unit} (${c.snapshotUnitPrev?.source ?? '?'}, unit label only — qty ${fmt(n(c.snapshotUnitPrev?.qtyOnHand))} is an EXPECTED qty, not a count)`
        : c.snapshotMismatch ? 'MISMATCH — left alone' : '(none)',
    change: isMaterial(c.old, c.next) || c.snapshot || c.snapshotUnitOnly ? 'WRITE' : '—',
    id: c.id,
  })))

  console.log(`\n  STOCK BASELINES (read straight off the row by count-expected.ts / inventory-list.ts)`)
  const leaveNote = (t: { next: number | null; old: number; via: string }) =>
    t.next == null ? `LEFT at ${fmt(t.old)} — ${t.via}` : `${fmt(t.old)} → ${fmt(t.next)}  [${t.via}]`
  console.log(`    stockOnHand: ${leaveNote(p.stock.stockOnHand)}`)
  console.log(`    lastCountQty: ${leaveNote(p.stock.lastCountQty)}`)
  if (p.stock.allocations.length === 0) console.log('    allocations: (none)')
  else for (const a of p.stock.allocations) {
    console.log(`    allocation ${a.revenueCenterId}: ${leaveNote(a)}`)
  }

  console.log(`\n  NOT rewritten, on purpose: CountLine.variancePct / varianceCost.`)
  console.log(`    count-finalize computes them as (countedQtyBase − expectedQty) × ppb, but expectedQty is ITSELF`)
  console.log(`    frozen in the old base unit and is not part of this repair. Recomputing would subtract a stale`)
  console.log(`    expectation from a corrected count. Left as they are — re-open and re-finalize the session if`)
  console.log(`    the variance numbers matter.`)

  if (p.blocked.length > 0) {
    console.log(`\n  BLOCKED — ${p.blocked.length} unresolved decision(s):`)
    for (const b of p.blocked) console.log(`    ${b}`)
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const closeEnough = (a: number | null, b: number | null) => {
  if (a == null || b == null) return a == null && b == null
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9)
}

async function applyItem(p: ItemPlan): Promise<{ applied: boolean; reason?: string }> {
  const fresh = await prisma.inventoryItem.findUnique({
    where: { id: p.item.id },
    select: { dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true, stockOnHand: true, purchasePrice: true, lastCountQty: true },
  })
  if (
    !fresh || fresh.dimension !== p.item.dimension || fresh.baseUnit !== p.item.baseUnit ||
    fresh.countUnit !== p.item.countUnit || !same(fresh.packChain, p.item.packChain) || !same(fresh.pricing, p.item.pricing) ||
    !closeEnough(Number(fresh.stockOnHand), p.stock.stockOnHand.old) ||
    !closeEnough(Number(fresh.purchasePrice), p.stock.purchasePrice.old) ||
    !closeEnough(Number(fresh.lastCountQty), p.stock.lastCountQty.old)
  ) {
    return { applied: false, reason: 'item shape changed since planning' }
  }

  const offerWrites = p.offers.filter(offerMoved)
  for (const o of offerWrites) {
    const row = await prisma.inventorySupplierPrice.findUnique({
      where: { id: o.id },
      select: { packChain: true, pricing: true, packQty: true, packSize: true, packUOM: true },
    })
    const unchanged = row != null &&
      same(row.packChain, o.before.packChain) && same(row.pricing, o.before.pricing) &&
      closeEnough(row.packQty != null ? Number(row.packQty) : null, o.before.packQty) &&
      closeEnough(row.packSize != null ? Number(row.packSize) : null, o.before.packSize) &&
      (row.packUOM ?? null) === o.before.packUOM
    if (!unchanged) return { applied: false, reason: `supplier offer ${o.id} changed since planning` }
  }

  const receiptWrites = p.receipts.filter((r) => isMaterial(r.old, r.next))
  for (const r of receiptWrites) {
    const row = await prisma.invoiceScanItem.findUnique({ where: { id: r.id }, select: { receivedQtyBase: true } })
    const now = row?.receivedQtyBase != null ? Number(row.receivedQtyBase) : null
    if (!row || !closeEnough(now, r.old)) return { applied: false, reason: `receipt ${r.id} changed since planning` }
  }

  const countWrites = p.counts.filter((c) => isMaterial(c.old, c.next) || c.snapshot != null || c.snapshotUnitOnly != null)
  for (const c of countWrites) {
    const row = await prisma.countLine.findUnique({ where: { id: c.id }, select: { countedQtyBase: true } })
    const now = row?.countedQtyBase != null ? Number(row.countedQtyBase) : null
    if (!row || !closeEnough(now, c.old)) return { applied: false, reason: `count line ${c.id} changed since planning` }
    if (c.snapshot && c.snapshotPrev) {
      const s = await prisma.inventorySnapshot.findUnique({
        where: { id: c.snapshot.id },
        select: { qtyOnHand: true, unit: true, pricePerBaseUnit: true, totalValue: true },
      })
      const unchanged = s != null && s.unit === c.snapshotPrev.unit &&
        closeEnough(Number(s.qtyOnHand), Number(c.snapshotPrev.qtyOnHand)) &&
        closeEnough(Number(s.totalValue), Number(c.snapshotPrev.totalValue)) &&
        closeEnough(Number(s.pricePerBaseUnit), Number(c.snapshotPrev.pricePerBaseUnit))
      if (!unchanged) return { applied: false, reason: `snapshot ${c.snapshot.id} changed since planning` }
    }
    if (c.snapshotUnitOnly) {
      const s = await prisma.inventorySnapshot.findUnique({ where: { id: c.snapshotUnitOnly.id }, select: { unit: true } })
      if (!s || s.unit !== c.snapshotUnitOnly.from) {
        return { applied: false, reason: `snapshot ${c.snapshotUnitOnly.id} changed since planning` }
      }
    }
  }

  const allocWrites = p.stock.allocations.filter((a) => a.next != null && isMaterial(a.old, a.next))
  for (const a of allocWrites) {
    const row = await prisma.stockAllocation.findUnique({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: a.revenueCenterId, inventoryItemId: p.item.id } },
      select: { quantity: true },
    })
    if (!row || !closeEnough(Number(row.quantity), a.old)) {
      return { applied: false, reason: `stock allocation for RC ${a.revenueCenterId} changed since planning` }
    }
  }

  const stockOnHandWrite = p.stock.stockOnHand.next != null && isMaterial(p.stock.stockOnHand.old, p.stock.stockOnHand.next)
    ? p.stock.stockOnHand.next
    : null
  const lastCountQtyWrite = p.stock.lastCountQty.next != null && isMaterial(p.stock.lastCountQty.old, p.stock.lastCountQty.next)
    ? p.stock.lastCountQty.next
    : null

  await prisma.$transaction([
    ...offerWrites.map((o) => prisma.inventorySupplierPrice.update({
      where: { id: o.id },
      data: {
        packChain: o.packChain as unknown as object,
        pricing: o.pricing as unknown as object,
        packQty: o.packQty, packSize: o.packSize, packUOM: o.packUOM,
      },
    })),
    ...receiptWrites.map((r) => prisma.invoiceScanItem.update({ where: { id: r.id }, data: { receivedQtyBase: r.next } })),
    ...countWrites.filter((c) => isMaterial(c.old, c.next) || c.priceAtCount != null).map((c) =>
      prisma.countLine.update({
        where: { id: c.id },
        data: {
          ...(isMaterial(c.old, c.next) ? { countedQtyBase: c.next } : {}),
          ...(c.priceAtCount != null ? { priceAtCount: c.priceAtCount } : {}),
        },
      })),
    ...countWrites.filter((c) => c.snapshot != null).map((c) =>
      prisma.inventorySnapshot.update({
        where: { id: c.snapshot!.id },
        data: {
          qtyOnHand: c.snapshot!.qtyOnHand, unit: c.snapshot!.unit,
          pricePerBaseUnit: c.snapshot!.pricePerBaseUnit, totalValue: c.snapshot!.totalValue,
        },
      })),
    ...countWrites.filter((c) => c.snapshotUnitOnly != null).map((c) =>
      prisma.inventorySnapshot.update({ where: { id: c.snapshotUnitOnly!.id }, data: { unit: c.snapshotUnitOnly!.unit } })),
    ...allocWrites.map((a) => prisma.stockAllocation.update({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: a.revenueCenterId, inventoryItemId: p.item.id } },
      data: { quantity: a.next! },
    })),
    prisma.inventoryItem.update({
      where: { id: p.item.id },
      data: {
        dimension: p.rewrite.dimension,
        baseUnit: p.rewrite.baseUnit,
        packChain: p.rewrite.packChain as unknown as object,
        pricing: p.rewrite.pricing as unknown as object,
        countUnit: p.rewrite.countUnit,
        purchasePrice: p.rewrite.purchasePrice,
        ...(stockOnHandWrite != null ? { stockOnHand: stockOnHandWrite } : {}),
        ...(lastCountQtyWrite != null ? { lastCountQty: lastCountQtyWrite } : {}),
      },
    }),
  ])
  return { applied: true }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const items = await fetchItems(itemIds)
  const missing = itemIds.filter((id) => !items.some((i) => i.id === id))
  if (missing.length > 0) {
    console.error(`No such inventory item(s): ${missing.join(', ')}`)
    process.exit(2)
  }

  const [lines, countRows, snaps, allocs, offers] = await Promise.all([
    fetchLines(itemIds),
    fetchCountLines(itemIds),
    fetchSnapshots(itemIds),
    prisma.stockAllocation.findMany({
      where: { inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, revenueCenterId: true, quantity: true },
    }),
    fetchOffers(itemIds),
  ])

  // A --count-unit-override for a line id that isn't among the named items'
  // count lines silently did nothing before (the line was never planned, so it
  // could never be resolved — the item just stayed BLOCKED as if the override
  // were never given). Same failure mode as a stray --measure: refuse loudly,
  // the likeliest cause is a typo in the id.
  const knownCountLineIds = new Set(countRows.map((c) => c.id))
  const strayCountUnits = [...countUnits.keys()].filter((id) => !knownCountLineIds.has(id))
  if (strayCountUnits.length > 0) {
    console.error(
      `--count-unit-override names count line id(s) that don't belong to any of the named items: ${strayCountUnits.join(', ')}. ` +
        `Check the id — an override for a line that isn't planned can never resolve anything.`,
    )
    console.error(USAGE)
    process.exit(2)
  }

  const plans: ItemPlan[] = []
  const refused: { item: ItemRow; error: string }[] = []
  for (const item of items) {
    const p = planFor(
      item,
      lines.filter((l) => l.matchedItemId === item.id),
      countRows.filter((c) => c.inventoryItemId === item.id),
      snaps.filter((s) => s.inventoryItemId === item.id),
      allocs.filter((a) => a.inventoryItemId === item.id),
      offers.filter((o) => o.inventoryItemId === item.id),
    )
    if ('error' in p) refused.push(p)
    else plans.push(p)
  }

  // Session totals are the ONE cross-item number: two repaired items can share a
  // count session, so they are summed once over every plan's rewritten
  // snapshots — never per item, which would rebuild the total from a fragment.
  const rewrittenValues = new Map<string, number>()
  const sessionContributors = new Map<string, Set<string>>()
  for (const p of plans) {
    for (const c of p.counts) {
      if (!c.snapshot) continue
      rewrittenValues.set(c.snapshot.id, c.snapshot.totalValue)
      const sid = c.line.sessionId
      if (!sessionContributors.has(sid)) sessionContributors.set(sid, new Set())
      sessionContributors.get(sid)!.add(p.item.id)
    }
  }
  const touchedSessionIds = [...sessionContributors.keys()]
  const [sessionRows, sessionSnaps] = await Promise.all([
    fetchSessions(touchedSessionIds),
    fetchSessionSnapshots(touchedSessionIds),
  ])
  const sessionById = new Map(sessionRows.map((s) => [s.id, s]))
  const sessionTotals: SessionTotalRow[] = planSessionTotals(
    sessionRows.map((s) => ({
      id: s.id,
      totalCountedValue: s.totalCountedValue != null ? Number(s.totalCountedValue) : 0,
      snapshots: sessionSnaps.filter((sn) => sn.sessionId === s.id)
        .map((sn) => ({ id: sn.id, source: sn.source, totalValue: Number(sn.totalValue) })),
    })),
    rewrittenValues,
  )

  console.log(`${items.length} item(s) named · ${offers.length} supplier offer(s) · ${lines.length} approved line(s) · ${countRows.length} count line(s) · ${snaps.length} snapshot(s)`)
  for (const p of plans) printPlan(p)
  for (const r of refused) console.log(`\n${r.item.itemName} (${r.item.id}) — REFUSED: ${r.error}`)

  console.log(`\n────────────────────────────────────────────────────────────`)
  console.log(`COUNT SESSION TOTALS (totalCountedValue = Σ OBSERVED snapshots, exactly as count-finalize sums them)`)
  if (sessionTotals.length === 0) console.log('  (no session snapshots are being rewritten)')
  else console.table(sessionTotals.map((s) => ({
    session: sessionById.get(s.sessionId)?.label ?? s.sessionId,
    date: sessionById.get(s.sessionId)?.sessionDate.toISOString().slice(0, 10) ?? '?',
    old: `$${s.old.toFixed(2)}`,
    next: `$${s.next.toFixed(2)}`,
    change: isMaterial(s.old, s.next) ? 'WRITE' : '—',
    id: s.sessionId,
  })))

  const diff = {
    stamp,
    items: plans.map((p) => ({
      itemId: p.item.id, itemName: p.item.itemName, measure: p.measure, measureFrom: p.measureFrom,
      before: { dimension: p.item.dimension, baseUnit: p.item.baseUnit, packChain: p.item.packChain, pricing: p.item.pricing, countUnit: p.item.countUnit, purchasePrice: p.stock.purchasePrice.old, pricePerBaseUnit: p.ppbBefore },
      after: { ...p.rewrite, pricePerBaseUnit: p.ppb },
      stock: p.stock,
      varianceNotRewritten: 'variancePct / varianceCost left as-is: expectedQty is frozen in the old base unit',
      blocked: p.blocked,
      offers: p.offers.map((o) => ({
        id: o.id, supplier: o.offer.supplierName, isPrimary: o.offer.isPrimary,
        before: o.before,
        after: { packChain: o.packChain, pricing: o.pricing, packQty: o.packQty, packSize: o.packSize, packUOM: o.packUOM },
        rate: o.rate, rateFrom: o.rateFrom, lastPrice: Number(o.offer.lastPrice),
        write: offerMoved(o),
      })),
      receipts: p.receipts.map((r) => ({ id: r.id, invoice: r.line.session.invoiceNumber, description: r.line.rawDescription, old: r.old, next: r.next, via: r.via, write: isMaterial(r.old, r.next) })),
      counts: p.counts.map((c) => ({
        id: c.id, session: c.line.session.label, entered: `${c.line.countedQty?.toString() ?? '(blank)'} ${c.line.selectedUom}`,
        old: c.old, next: c.next, via: c.via, needsDecision: c.needsDecision,
        priceAtCount: c.priceAtCount != null ? { old: Number(c.line.priceAtCount), next: c.priceAtCount } : null,
        snapshot: c.snapshot ?? null, snapshotUnitOnly: c.snapshotUnitOnly ?? null,
        snapshotMismatch: c.snapshotMismatch ?? false,
        write: isMaterial(c.old, c.next) || c.snapshot != null || c.snapshotUnitOnly != null,
      })),
    })),
    sessionTotals: sessionTotals.map((s) => ({ ...s, label: sessionById.get(s.sessionId)?.label ?? null, write: isMaterial(s.old, s.next) })),
    refused: refused.map((r) => ({ itemId: r.item.id, itemName: r.item.itemName, error: r.error })),
  }
  const diffFile = `create-new-repair-diff-${stamp}.json`
  writeFileSync(diffFile, JSON.stringify(diff, null, 2))
  console.log(`\ndiff → ${diffFile}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once a human has reviewed the diff.')
    return
  }

  const blocked = plans.filter((p) => p.blocked.length > 0)
  if (blocked.length > 0) {
    console.error(`\nREFUSING --apply: ${blocked.length} item(s) have unresolved count-unit decisions.`)
    for (const p of blocked) for (const b of p.blocked) console.error(`  ${p.item.itemName}: ${b}`)
    process.exit(3)
  }
  const runnable = plans
  if (runnable.length === 0) {
    console.log('\nNothing to apply.')
    return
  }

  const backupFile = `create-new-repair-backup-${stamp}.json`
  writeFileSync(backupFile, JSON.stringify({
    stamp,
    items: runnable.map((p) => ({
      id: p.item.id, itemName: p.item.itemName,
      prev: {
        dimension: p.item.dimension, baseUnit: p.item.baseUnit, packChain: p.item.packChain,
        pricing: p.item.pricing, countUnit: p.item.countUnit,
        purchasePrice: p.stock.purchasePrice.old, stockOnHand: p.stock.stockOnHand.old,
        lastCountQty: p.stock.lastCountQty.old,
      },
    })),
    offers: runnable.flatMap((p) => p.offers.filter(offerMoved).map((o) => ({
      id: o.id, itemId: p.item.id, supplier: o.offer.supplierName, prev: o.before,
    }))),
    lines: runnable.flatMap((p) => p.receipts.filter((r) => isMaterial(r.old, r.next))
      .map((r) => ({ id: r.id, itemId: p.item.id, prev: { receivedQtyBase: r.old } }))),
    // The same predicate `applyItem` writes on, so the backup is exactly the set
    // of rows that move — never a superset that implies a write that never ran.
    countLines: runnable.flatMap((p) => p.counts
      .filter((c) => isMaterial(c.old, c.next) || c.snapshot != null || c.snapshotUnitOnly != null)
      .map((c) => ({ id: c.id, itemId: p.item.id, prev: { countedQtyBase: c.old, priceAtCount: c.line.priceAtCount != null ? Number(c.line.priceAtCount) : null } }))),
    snapshots: runnable.flatMap((p) => p.counts.filter((c) => c.snapshot && c.snapshotPrev).map((c) => ({
      id: c.snapshot!.id, itemId: p.item.id,
      prev: {
        qtyOnHand: Number(c.snapshotPrev!.qtyOnHand), unit: c.snapshotPrev!.unit,
        pricePerBaseUnit: Number(c.snapshotPrev!.pricePerBaseUnit), totalValue: Number(c.snapshotPrev!.totalValue),
      },
    }))),
    snapshotUnits: runnable.flatMap((p) => p.counts.filter((c) => c.snapshotUnitOnly).map((c) => ({
      id: c.snapshotUnitOnly!.id, itemId: p.item.id, prev: { unit: c.snapshotUnitOnly!.from },
    }))),
    allocations: runnable.flatMap((p) => p.stock.allocations.filter((a) => a.next != null && isMaterial(a.old, a.next))
      .map((a) => ({ itemId: p.item.id, revenueCenterId: a.revenueCenterId, prev: { quantity: a.old } }))),
    sessions: sessionTotals.filter((s) => isMaterial(s.old, s.next))
      .map((s) => ({ id: s.sessionId, prev: { totalCountedValue: s.old } })),
  }, null, 2))
  console.log(`backup → ${backupFile}`)

  let applied = 0, skipped = 0
  const appliedItemIds = new Set<string>()
  for (const p of runnable) {
    const res = await applyItem(p)
    if (res.applied) { applied++; appliedItemIds.add(p.item.id); console.log(`applied — ${p.item.itemName}`) }
    else { skipped++; console.warn(`REFUSED — ${p.item.itemName}: ${res.reason} (nothing written for this item)`) }
  }

  // Session totals last, and only where every contributing item actually landed
  // — a total summed over a rewrite that was refused would be a number describing
  // a database that does not exist.
  const totalWrites = sessionTotals.filter((s) => {
    if (!isMaterial(s.old, s.next)) return false
    const contributors = sessionContributors.get(s.sessionId) ?? new Set<string>()
    return [...contributors].every((id) => appliedItemIds.has(id))
  })
  const totalsSkipped = sessionTotals.filter((s) => isMaterial(s.old, s.next) && !totalWrites.includes(s))
  for (const s of totalsSkipped) {
    console.warn(`REFUSED — session total ${sessionById.get(s.sessionId)?.label ?? s.sessionId}: an item contributing to it was not applied`)
  }
  if (totalWrites.length > 0) {
    const stale: string[] = []
    for (const s of totalWrites) {
      const row = await prisma.countSession.findUnique({ where: { id: s.sessionId }, select: { totalCountedValue: true } })
      if (!row || !closeEnough(Number(row.totalCountedValue), s.old)) stale.push(s.sessionId)
    }
    if (stale.length > 0) {
      console.warn(`REFUSED — ${stale.length} session total(s) changed since planning: ${stale.join(', ')}`)
    }
    const safe = totalWrites.filter((s) => !stale.includes(s.sessionId))
    if (safe.length > 0) {
      await prisma.$transaction(safe.map((s) =>
        prisma.countSession.update({ where: { id: s.sessionId }, data: { totalCountedValue: s.next } })))
      console.log(`applied — ${safe.length} count session total(s)`)
    }
  }

  console.log(`\napplied ${applied} item(s) · refused ${skipped}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
