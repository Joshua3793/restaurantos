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
 *                 seed today. The rate NUMBER never moves: $1.99 was always
 *                 $1.99 per lb; only its label was wrong.
 *   2. RECEIPTS → `InvoiceScanItem.receivedQtyBase` recomputed by `lineReceived`
 *                 against the corrected item, with the frozen value deliberately
 *                 NOT passed back in. RC split clones take a share of their
 *                 parent's new value (`cloneShare`), never the rule.
 *   3. COUNTS   → `CountLine.countedQtyBase` recomputed by `lineCountedBase` with
 *                 `countedQtyBase: null`, and the `InventorySnapshot` finalize
 *                 wrote from it refreshed (`qtyOnHand`, `unit = baseUnit`,
 *                 `pricePerBaseUnit`, `totalValue = qty × ppb` — mirroring
 *                 src/lib/count-finalize.ts). A snapshot whose stored qtyOnHand
 *                 is not this line's frozen base was not written from this line
 *                 and is left alone, listed as a mismatch.
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
 * `--apply` writes `create-new-repair-backup-<stamp>.json`
 * `{ items, lines, countLines, snapshots }` with every previous value BEFORE the
 * first write, then, per item, RE-READS every row it is about to touch and skips
 * the WHOLE item if any of them moved since planning — the diff a human approved
 * is never replayed blind. Each item's writes go in one `$transaction`, so an
 * item is never half-repaired. ORM only.
 *
 * NOT rewritten, and printed so nobody assumes otherwise: `InventoryItem.stockOnHand`
 * and `StockAllocation.quantity` are stored in the OLD base unit. They are
 * recomputed from counts + receipts on read (theoretical stock), but if a number
 * looks wrong after this runs, look there first.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, type ChainItem } from '../src/lib/item-model'
import { lineMeasureUnit } from '../src/lib/invoice/create-new-seed'
import {
  isSelfContradictory, planItemRewrite, planReceiptRefreeze, planCountRefreeze, isMaterial,
  type ItemRewrite, type ReceiptLine, type CountLineRow, type ReceiptRefreezeRow, type CountRefreezeRow,
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
    select: { id: true, itemName: true, stockOnHand: true, ...PRICING_SELECT },
  })
}
type ItemRow = Awaited<ReturnType<typeof fetchItems>>[number]

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
      entries: true, countedQtyBase: true, skipped: true,
      session: { select: { label: true, sessionDate: true, status: true } },
    },
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
  receipts: (ReceiptRefreezeRow & { line: ScanLine })[]
  counts: (CountRefreezeRow & { line: CountRow; snapshotPrev?: SnapshotRow })[]
  allocations: { rcId: string; quantity: number }[]
  blocked: string[]
}

function planFor(
  item: ItemRow, lines: ScanLine[], countRows: CountRow[], snaps: SnapshotRow[],
  allocations: { revenueCenterId: string; quantity: unknown }[],
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
      snapshot: snap ? { id: snap.id, qtyOnHand: Number(snap.qtyOnHand) } : null,
      unitOverride: countUnits.get(c.id) ?? null,
    }
  })
  const countsById = new Map(countRows.map((c) => [c.id, c]))
  const snapById = new Map(snaps.map((s) => [s.id, s]))
  const counts = planCountRefreeze(countInputs, corrected, ppb).map((r) => ({
    ...r,
    line: countsById.get(r.id)!,
    snapshotPrev: r.snapshot ? snapById.get(r.snapshot.id) : undefined,
  }))

  const blocked = counts
    .filter((c) => c.needsDecision)
    .map((c) => `count line ${c.id} (${c.via}) — resolve with --count-unit-override ${c.id}=<unit>`)

  return {
    item, measure: m.unit, measureFrom: m.from, rewrite, corrected, ppb,
    ppbBefore: pricePerBaseUnit(asChainItem(item)),
    receipts, counts,
    allocations: allocations.map((a) => ({ rcId: a.revenueCenterId, quantity: Number(a.quantity) })),
    blocked,
  }
}

// ── print ───────────────────────────────────────────────────────────────────

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 3 })

function printPlan(p: ItemPlan) {
  const i = p.item
  console.log(`\n────────────────────────────────────────────────────────────`)
  console.log(`${i.itemName}   (${i.id})`)
  console.log(`  measure: ${p.measure}   [from ${p.measureFrom}]`)
  console.log(`  shape flags: ${isSelfContradictory(i).join(' · ') || '(none — evidence-only finding)'}`)
  console.log(`  before: ${i.dimension}/${i.baseUnit}  chain ${JSON.stringify(i.packChain)}  pricing ${JSON.stringify(i.pricing)}  count ${i.countUnit}  →  $${p.ppbBefore.toFixed(6)}/${i.baseUnit}`)
  console.log(`  after : ${p.rewrite.dimension}/${p.rewrite.baseUnit}  chain ${JSON.stringify(p.rewrite.packChain)}  pricing ${JSON.stringify(p.rewrite.pricing)}  count ${p.rewrite.countUnit}  →  $${p.ppb.toFixed(6)}/${p.rewrite.baseUnit}`)

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
    date: c.line.session.sessionDate.toISOString().slice(0, 10),
    entered: `${c.line.countedQty?.toString() ?? '(blank)'} ${c.line.selectedUom}`,
    old: c.old == null ? '(null)' : fmt(c.old),
    next: fmt(c.next),
    via: c.via,
    decide: c.needsDecision ? 'NEEDS DECISION' : '',
    snapshot: c.snapshot
      ? `${c.snapshot.id.slice(0, 8)}… ${fmt(n(c.snapshotPrev?.qtyOnHand))} ${c.snapshotPrev?.unit} $${n(c.snapshotPrev?.totalValue).toFixed(2)} → ${fmt(c.snapshot.qtyOnHand)} ${c.snapshot.unit} $${c.snapshot.totalValue.toFixed(2)}`
      : c.snapshotMismatch ? 'MISMATCH — left alone' : '(none)',
    change: isMaterial(c.old, c.next) || c.snapshot ? 'WRITE' : '—',
    id: c.id,
  })))

  console.log(`\n  NOT rewritten (stored in the OLD base unit — review by hand):`)
  console.log(`    stockOnHand ${fmt(Number(i.stockOnHand))} ${i.baseUnit}` +
    (p.allocations.length ? `; allocations ${p.allocations.map((a) => `${a.rcId.slice(0, 8)}…=${fmt(a.quantity)}`).join(', ')}` : '; no RC allocations'))

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
    select: { dimension: true, baseUnit: true, packChain: true, pricing: true, countUnit: true },
  })
  if (
    !fresh || fresh.dimension !== p.item.dimension || fresh.baseUnit !== p.item.baseUnit ||
    fresh.countUnit !== p.item.countUnit || !same(fresh.packChain, p.item.packChain) || !same(fresh.pricing, p.item.pricing)
  ) {
    return { applied: false, reason: 'item shape changed since planning' }
  }

  const receiptWrites = p.receipts.filter((r) => isMaterial(r.old, r.next))
  for (const r of receiptWrites) {
    const row = await prisma.invoiceScanItem.findUnique({ where: { id: r.id }, select: { receivedQtyBase: true } })
    const now = row?.receivedQtyBase != null ? Number(row.receivedQtyBase) : null
    if (!row || !closeEnough(now, r.old)) return { applied: false, reason: `receipt ${r.id} changed since planning` }
  }

  const countWrites = p.counts.filter((c) => isMaterial(c.old, c.next) || c.snapshot != null)
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
  }

  await prisma.$transaction([
    ...receiptWrites.map((r) => prisma.invoiceScanItem.update({ where: { id: r.id }, data: { receivedQtyBase: r.next } })),
    ...countWrites.filter((c) => isMaterial(c.old, c.next)).map((c) =>
      prisma.countLine.update({ where: { id: c.id }, data: { countedQtyBase: c.next } })),
    ...countWrites.filter((c) => c.snapshot != null).map((c) =>
      prisma.inventorySnapshot.update({
        where: { id: c.snapshot!.id },
        data: {
          qtyOnHand: c.snapshot!.qtyOnHand, unit: c.snapshot!.unit,
          pricePerBaseUnit: c.snapshot!.pricePerBaseUnit, totalValue: c.snapshot!.totalValue,
        },
      })),
    prisma.inventoryItem.update({
      where: { id: p.item.id },
      data: {
        dimension: p.rewrite.dimension,
        baseUnit: p.rewrite.baseUnit,
        packChain: p.rewrite.packChain as unknown as object,
        pricing: p.rewrite.pricing as unknown as object,
        countUnit: p.rewrite.countUnit,
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

  const [lines, countRows, snaps, allocs] = await Promise.all([
    fetchLines(itemIds),
    fetchCountLines(itemIds),
    fetchSnapshots(itemIds),
    prisma.stockAllocation.findMany({
      where: { inventoryItemId: { in: itemIds } },
      select: { inventoryItemId: true, revenueCenterId: true, quantity: true },
    }),
  ])

  const plans: ItemPlan[] = []
  const refused: { item: ItemRow; error: string }[] = []
  for (const item of items) {
    const p = planFor(
      item,
      lines.filter((l) => l.matchedItemId === item.id),
      countRows.filter((c) => c.inventoryItemId === item.id),
      snaps.filter((s) => s.inventoryItemId === item.id),
      allocs.filter((a) => a.inventoryItemId === item.id),
    )
    if ('error' in p) refused.push(p)
    else plans.push(p)
  }

  console.log(`${items.length} item(s) named · ${lines.length} approved line(s) · ${countRows.length} count line(s) · ${snaps.length} snapshot(s)`)
  for (const p of plans) printPlan(p)
  for (const r of refused) console.log(`\n${r.item.itemName} (${r.item.id}) — REFUSED: ${r.error}`)

  const diff = {
    stamp,
    items: plans.map((p) => ({
      itemId: p.item.id, itemName: p.item.itemName, measure: p.measure, measureFrom: p.measureFrom,
      before: { dimension: p.item.dimension, baseUnit: p.item.baseUnit, packChain: p.item.packChain, pricing: p.item.pricing, countUnit: p.item.countUnit, pricePerBaseUnit: p.ppbBefore },
      after: { ...p.rewrite, pricePerBaseUnit: p.ppb },
      stockOnHandNotRewritten: Number(p.item.stockOnHand),
      allocationsNotRewritten: p.allocations,
      blocked: p.blocked,
      receipts: p.receipts.map((r) => ({ id: r.id, invoice: r.line.session.invoiceNumber, description: r.line.rawDescription, old: r.old, next: r.next, via: r.via, write: isMaterial(r.old, r.next) })),
      counts: p.counts.map((c) => ({
        id: c.id, session: c.line.session.label, entered: `${c.line.countedQty?.toString() ?? '(blank)'} ${c.line.selectedUom}`,
        old: c.old, next: c.next, via: c.via, needsDecision: c.needsDecision,
        snapshot: c.snapshot ?? null, snapshotMismatch: c.snapshotMismatch ?? false,
        write: isMaterial(c.old, c.next) || c.snapshot != null,
      })),
    })),
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
      prev: { dimension: p.item.dimension, baseUnit: p.item.baseUnit, packChain: p.item.packChain, pricing: p.item.pricing, countUnit: p.item.countUnit },
    })),
    lines: runnable.flatMap((p) => p.receipts.filter((r) => isMaterial(r.old, r.next))
      .map((r) => ({ id: r.id, itemId: p.item.id, prev: { receivedQtyBase: r.old } }))),
    countLines: runnable.flatMap((p) => p.counts.filter((c) => isMaterial(c.old, c.next))
      .map((c) => ({ id: c.id, itemId: p.item.id, prev: { countedQtyBase: c.old } }))),
    snapshots: runnable.flatMap((p) => p.counts.filter((c) => c.snapshot && c.snapshotPrev).map((c) => ({
      id: c.snapshot!.id, itemId: p.item.id,
      prev: {
        qtyOnHand: Number(c.snapshotPrev!.qtyOnHand), unit: c.snapshotPrev!.unit,
        pricePerBaseUnit: Number(c.snapshotPrev!.pricePerBaseUnit), totalValue: Number(c.snapshotPrev!.totalValue),
      },
    }))),
  }, null, 2))
  console.log(`backup → ${backupFile}`)

  let applied = 0, skipped = 0
  for (const p of runnable) {
    const res = await applyItem(p)
    if (res.applied) { applied++; console.log(`applied — ${p.item.itemName}`) }
    else { skipped++; console.warn(`REFUSED — ${p.item.itemName}: ${res.reason} (nothing written for this item)`) }
  }
  console.log(`\napplied ${applied} item(s) · refused ${skipped}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
