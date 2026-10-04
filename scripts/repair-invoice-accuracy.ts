/**
 * One-time repair of the invoice history behind the Stage 5 invoice-accuracy
 * fixes (plan docs/superpowers/plans/2026-10-05-item-backbone-5-invoice-accuracy.md,
 * Task 5; audit docs/audits/2026-10-04-backbone-audit §5). Three explicit modes:
 *
 *   npx tsx scripts/repair-invoice-accuracy.ts --mode unitless-weight [--apply]
 *   npx tsx scripts/repair-invoice-accuracy.ts --mode blocked [--with-box-refresh] [--apply]
 *   npx tsx scripts/repair-invoice-accuracy.ts --mode split-create-new [--apply]
 *
 * DRY RUN is the default: it reads, prints one row per line plus totals, and
 * records the rows it would write in `invoice-accuracy-<mode>-plan.json` (the
 * reviewed set). Nothing else is written.
 *
 * `--apply` RECOMPUTES everything from the database (it never replays the plan
 * file) and refuses to run unless the fresh candidate set equals the reviewed
 * one minus rows already applied. It then writes
 * `invoice-accuracy-<mode>-backup-<stamp>.json` (every touched row's previous
 * values) BEFORE the first write, applies each line in its own transaction, and
 * prints the `cp` command that copies the backup to the main checkout.
 *
 * The rules (who is a candidate, what is written, what is only listed) live in
 * the pure, tested planners of src/lib/invoice/accuracy-repair.ts. The per-line
 * approve decision is the approve route's own (`decideLinePrice`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Prisma } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, basePerPurchase, type PackLink, type Pricing } from '../src/lib/item-model'
import { lineReceived, lineReceivedBaseUnits, type LineQtyInput } from '../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../src/lib/invoice/line-format'
import { freezeFormat } from '../src/lib/invoice/approve-format'
import { decideLinePrice, type LineDecision } from '../src/lib/invoice/approve-outcome'
import {
  parseRepairArgs, planUnitless, planBlocked, planSplitCreateNew, compareToReviewed,
  appendRepairNote, boxRefreshWrite,
  type RepairMode, type UnitlessInput, type BlockedInput, type BlockedPlan, type BoxFacts,
} from '../src/lib/invoice/accuracy-repair'

const USAGE = [
  'Usage:',
  '  npx tsx scripts/repair-invoice-accuracy.ts --mode unitless-weight [--apply]',
  '  npx tsx scripts/repair-invoice-accuracy.ts --mode blocked [--with-box-refresh] [--apply]',
  '  npx tsx scripts/repair-invoice-accuracy.ts --mode split-create-new [--apply]',
].join('\n')

const parsed = parseRepairArgs(process.argv.slice(2))
if ('error' in parsed) {
  console.error(parsed.error)
  console.error(USAGE)
  process.exit(1)
}
const { mode: MODE, apply: APPLY, withBoxRefresh: WITH_BOX_REFRESH } = parsed
const NOW = new Date()
const STAMP = NOW.toISOString().replace(/[:.]/g, '-')
const RECENT_SINCE = new Date(NOW.getTime() - 30 * 24 * 3600 * 1000)
const TODAY_LABEL = NOW.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Vancouver' })
const MAIN_CHECKOUT = '/Users/joshua/dev/fergies-os/'
const PRICED = ['UPDATE_PRICE', 'ADD_SUPPLIER']

// ─────────────────────────────────────────────────────────────────────────────
// Shared reading
// ─────────────────────────────────────────────────────────────────────────────

const ITEM_SELECT = { id: true, itemName: true, isActive: true, mergedIntoId: true, ...PRICING_SELECT } as const
const SESSION_SELECT = {
  id: true, status: true, invoiceNumber: true, supplierId: true, supplierName: true, purchaseDate: true,
  approvedAt: true, parentSessionId: true, revenueCenterId: true, errorMessage: true,
  supplier: { select: { name: true } },
} as const
const LINE_SELECT = {
  id: true, sessionId: true, rawDescription: true, rawQty: true, rawUnit: true, rawUnitPrice: true, rawLineTotal: true,
  newPrice: true, totalQty: true, totalQtyUOM: true, rate: true, rateUOM: true, pricingMode: true, qtyOrdered: true,
  invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, supplierItemCode: true, action: true,
  matchedItemId: true, newItemData: true, receivedQtyBase: true, approved: true, sortOrder: true,
  revenueCenterId: true, splitToSessionId: true,
  matchedItem: { select: ITEM_SELECT },
  session: { select: SESSION_SELECT },
} as const

async function loadLines(where: Prisma.InvoiceScanItemWhereInput) {
  return prisma.invoiceScanItem.findMany({ where, select: LINE_SELECT, orderBy: [{ session: { purchaseDate: 'asc' } }, { sortOrder: 'asc' }] })
}
type Line = Awaited<ReturnType<typeof loadLines>>[number]
type Item = NonNullable<Line['matchedItem']>

const OFFER_ROW_SELECT = {
  id: true, inventoryItemId: true, supplierId: true, supplierName: true, supplierItemCode: true, isPrimary: true,
  packChain: true, pricing: true, packQty: true, packSize: true, packUOM: true, lastInvoiceSessionId: true, lastUpdated: true,
} as const
async function loadOffers(itemIds: string[]) {
  const rows = itemIds.length
    ? await prisma.inventorySupplierPrice.findMany({ where: { inventoryItemId: { in: itemIds } }, select: OFFER_ROW_SELECT })
    : []
  const byItem = new Map<string, typeof rows>()
  for (const o of rows) {
    const list = byItem.get(o.inventoryItemId)
    if (list) list.push(o)
    else byItem.set(o.inventoryItemId, [o])
  }
  return byItem
}
type Offer = Awaited<ReturnType<typeof loadOffers>> extends Map<string, infer V> ? V extends Array<infer O> ? O : never : never

const num = (v: unknown): number | null => (v == null ? null : Number(v))
/** The receiving-rule inputs, WITHOUT the frozen receipt (approve's lineQtyOf). */
const qtyOf = (l: Line): LineQtyInput => ({
  rawQty: l.rawQty?.toString() ?? null, rawUnit: l.rawUnit,
  totalQty: l.totalQty?.toString() ?? null, totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM,
  invoicePackQty: l.invoicePackQty?.toString() ?? null, invoicePackSize: l.invoicePackSize?.toString() ?? null,
  invoicePackUOM: l.invoicePackUOM, rawUnitPrice: l.rawUnitPrice?.toString() ?? null,
  rate: l.rate?.toString() ?? null, rawLineTotal: l.rawLineTotal?.toString() ?? null,
})
const chainOf = (item: Item) => asChainItem({
  dimension: item.dimension, baseUnit: item.baseUnit ?? 'each', packChain: item.packChain, pricing: item.pricing,
  countUnit: item.countUnit ?? undefined, eachMeasureQty: item.eachMeasureQty, eachMeasureUnit: item.eachMeasureUnit,
  densityGPerMl: item.densityGPerMl,
})
const supplierOf = (l: Line) => l.session.supplier?.name ?? l.session.supplierName ?? '(no supplier)'
/** This supplier's box for the line — the same rule approve, review and stock read through. */
const lineOfferOf = (l: Line, offers: Offer[]): Offer | null =>
  l.session.supplierId
    ? pickOffer(offers, {
        supplierId: l.session.supplierId, supplierName: l.session.supplierName,
        canonicalName: l.session.supplier?.name ?? null, itemCode: l.supplierItemCode,
      })
    : null
function decide(l: Line, offers: Offer[]): { d: LineDecision; lineOffer: Offer | null } {
  const lineOffer = lineOfferOf(l, offers)
  const d = decideLinePrice({
    line: l, item: l.matchedItem!, lineOffer, itemHasOffers: offers.length > 0,
    sessionHasSupplier: !!l.session.supplierId, supplierName: l.session.supplier?.name ?? l.session.supplierName,
  })
  return { d, lineOffer }
}

const lineDate = (s: { purchaseDate: Date | null; approvedAt: Date | null }) => s.purchaseDate ?? s.approvedAt
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '????-??-??')
const money = (n: number) => `$${n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const qty = (n: number | null | undefined, unit: string | null | undefined) =>
  n == null ? 'nothing' : `${n.toLocaleString('en-CA', { maximumFractionDigits: 3 })} ${unit ?? ''}`.trim()
/** "$9.00 a case (4,535.92 g)" / "$25.00 per kg" — the box write in words. */
const boxWords = (w: { packChain: PackLink[]; pricing: Pricing }, baseUnit: string | null) =>
  w.pricing.mode === 'RATE'
    ? `${money(w.pricing.rate)} per ${w.pricing.rateUnit}`
    : `${money(w.pricing.purchasePrice)} a ${w.packChain[0]?.unit ?? 'case'} (${qty(basePerPurchase(w.packChain), baseUnit)})`
const isRecent = (s: { approvedAt: Date | null }) => !!s.approvedAt && s.approvedAt >= RECENT_SINCE

/** The latest finalized FULL count per revenue center — a repaired line dated after
 *  it moves TODAY's theoretical stock, so it is flagged. */
async function loadLastCounts() {
  const rows = await prisma.countSession.findMany({
    where: { status: 'FINALIZED', type: 'FULL' }, select: { revenueCenterId: true, sessionDate: true },
  })
  const byRc = new Map<string | null, Date>()
  let latest: Date | null = null
  for (const r of rows) {
    const prev = byRc.get(r.revenueCenterId)
    if (!prev || r.sessionDate > prev) byRc.set(r.revenueCenterId, r.sessionDate)
    if (!latest || r.sessionDate > latest) latest = r.sessionDate
  }
  return (rcId: string | null, date: Date | null): boolean => {
    const bound = (rcId ? byRc.get(rcId) : undefined) ?? latest
    return !!bound && !!date && date > bound
  }
}

async function rcNames() {
  const rows = await prisma.revenueCenter.findMany({ select: { id: true, name: true } })
  const byId = new Map(rows.map((r) => [r.id, r.name]))
  return (id: string | null | undefined) => (id ? byId.get(id) ?? id : '(none)')
}

async function defaultRcId() {
  return (await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true } }))?.id ?? null
}

function totalsLine(label: string, rows: Array<{ total: number; recent: boolean }>) {
  const recent = rows.filter((r) => r.recent)
  const older = rows.filter((r) => !r.recent)
  const sum = (xs: typeof rows) => xs.reduce((s, r) => s + r.total, 0)
  console.log(
    `${label}: ${rows.length} line(s), ${money(sum(rows))}  ` +
    `(last 30 days: ${recent.length} / ${money(sum(recent))}; older: ${older.length} / ${money(sum(older))})`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewed-set bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

const planPath = (m: RepairMode) => resolve(process.cwd(), `invoice-accuracy-${m}-plan.json`)
interface PlanFile { mode: RepairMode; withBoxRefresh: boolean; createdAt: string; keys: string[] }

function recordReviewed(keys: string[]) {
  const file: PlanFile = { mode: MODE, withBoxRefresh: WITH_BOX_REFRESH, createdAt: NOW.toISOString(), keys }
  writeFileSync(planPath(MODE), JSON.stringify(file, null, 2))
  console.log(`\nDRY RUN — nothing written to the database. Reviewed set (${keys.length} key(s)) → ${planPath(MODE)}`)
  console.log(`Apply with: npx tsx scripts/repair-invoice-accuracy.ts --mode ${MODE}${WITH_BOX_REFRESH ? ' --with-box-refresh' : ''} --apply`)
}

/** Refuse unless the fresh set is the reviewed set minus rows already applied. */
function guardAgainstReviewed(fresh: string[], applied: string[]): boolean {
  if (!existsSync(planPath(MODE))) {
    console.error(`\nREFUSED — no dry run on record (${planPath(MODE)}). Run the dry run first and review it.`)
    return false
  }
  const file = JSON.parse(readFileSync(planPath(MODE), 'utf8')) as PlanFile
  if (file.mode !== MODE || file.withBoxRefresh !== WITH_BOX_REFRESH) {
    console.error(`\nREFUSED — the reviewed dry run was for --mode ${file.mode}${file.withBoxRefresh ? ' --with-box-refresh' : ''}. Re-run the dry run with the same flags.`)
    return false
  }
  const cmp = compareToReviewed({ reviewed: file.keys, fresh, applied })
  if (!cmp.ok) {
    console.error('\nREFUSED — the lines to repair are not the ones the reviewed dry run listed.')
    if (cmp.added.length) console.error(`  new since the dry run: ${cmp.added.join(', ')}`)
    if (cmp.missing.length) console.error(`  gone since the dry run (not by this repair): ${cmp.missing.join(', ')}`)
    console.error('Re-run the dry run, review it, then apply.')
    return false
  }
  return true
}

function writeBackup(rows: unknown[]) {
  const name = `invoice-accuracy-${MODE}-backup-${STAMP}.json`
  const path = resolve(process.cwd(), name)
  writeFileSync(path, JSON.stringify({ mode: MODE, withBoxRefresh: WITH_BOX_REFRESH, createdAt: NOW.toISOString(), rows }, null, 2))
  console.log(`backup written BEFORE any change: ${path}`)
  return path
}
function printCp(path: string) {
  console.log(`\nCopy the backup to the main checkout:\n  cp "${path}" ${MAIN_CHECKOUT}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// A — unit-less weights
// ─────────────────────────────────────────────────────────────────────────────

async function runUnitless() {
  const lines = await loadLines({
    approved: true, matchedItemId: { not: null }, action: { in: PRICED },
    session: { status: 'APPROVED', parentSessionId: null },
  })
  const offersByItem = await loadOffers([...new Set(lines.map((l) => l.matchedItemId!))])
  const afterCount = await loadLastCounts()

  // RC copies of every candidate parent: same parent session, description, position.
  const decided = new Map<string, { l: Line; d: LineDecision }>()
  const inputs: UnitlessInput[] = []
  const merged: Line[] = []
  for (const l of lines) {
    if (l.matchedItem!.mergedIntoId) { merged.push(l); continue }
    const { d } = decide(l, offersByItem.get(l.matchedItemId!) ?? [])
    if (!d.ok || !d.weightUnit) continue
    decided.set(l.id, { l, d })
  }
  const parentIds = [...new Set([...decided.values()].map(({ l }) => l.sessionId))]
  const cloneLines = parentIds.length
    ? await loadLines({ session: { parentSessionId: { in: parentIds } } })
    : []
  const clonesByKey = new Map<string, Line[]>()
  for (const c of cloneLines) {
    const k = `${c.session.parentSessionId}|${c.rawDescription}|${c.sortOrder}`
    const list = clonesByKey.get(k)
    if (list) list.push(c)
    else clonesByKey.set(k, [c])
  }

  for (const { l, d } of decided.values()) {
    if (!d.ok) continue
    const next = d.pricedByWeight ? d.received.base : lineReceivedBaseUnits(qtyOf(l), freezeFormat(d.speaks, d.newPricing))
    const clones = (clonesByKey.get(`${l.sessionId}|${l.rawDescription}|${l.sortOrder}`) ?? [])
      .map((c) => ({ id: c.id, prev: num(c.receivedQtyBase), parentTotal: l.rawLineTotal?.toString(), cloneTotal: c.rawLineTotal?.toString() }))
    inputs.push({ id: l.id, prev: num(l.receivedQtyBase), next, weightPath: true, assumed: !!d.weightUnit?.assumed, clones })
  }

  const plan = planUnitless(inputs)
  const writes = plan.filter((p) => p.kind === 'write')
  console.log(`=== Mode unitless-weight — a weight printed with no unit, re-read in the unit its supplier's box is priced in ===`)
  console.log(`${lines.length} approved priced lines read; ${plan.length} are weight lines whose unit was assumed.\n`)
  for (const p of plan) {
    const { l, d } = decided.get(p.id)!
    const unit = l.matchedItem!.baseUnit
    const wu = d.ok && d.weightUnit ? `${d.weightUnit.unit} (from ${d.weightUnit.source})` : '?'
    const extra: string[] = []
    if (p.kind === 'write') {
      extra.push(`×${p.factor >= 1 ? p.factor : `1/${(1 / p.factor).toPrecision(6)}`}`)
      for (const c of p.clones) extra.push(`RC copy ${c.id}: ${qty(c.prev, unit)} → ${qty(c.next, unit)}`)
    }
    if (p.kind === 'look') extra.push(`NEEDS A LOOK — ${p.reason}`)
    if (d.ok && d.implausible) extra.push(`price still looks ${d.implausible.ratio.toPrecision(2)}× off`)
    if (afterCount(l.revenueCenterId ?? l.session.revenueCenterId, lineDate(l.session))) extra.push('DATED AFTER THE LAST COUNT — moves today\'s stock')
    console.log([
      p.kind === 'write' ? 'WRITE ' : p.kind === 'look' ? 'LOOK  ' : 'same  ',
      l.session.invoiceNumber ?? '(no #)', ymd(lineDate(l.session)), supplierOf(l), l.matchedItem!.itemName,
      `"${l.rawDescription}"`, money(Number(l.rawLineTotal ?? 0)),
      `${qty(p.prev, unit)} → ${qty(p.next, unit)}`, `unit ${wu}`, ...extra,
    ].join(' | '))
  }
  if (merged.length) console.log(`\n${merged.length} line(s) on merged products skipped (listed only): ${merged.map((l) => l.id).join(', ')}`)
  const row = (id: string) => { const { l } = decided.get(id)!; return { total: Number(l.rawLineTotal ?? 0), recent: isRecent(l.session) } }
  console.log('')
  totalsLine('Would change', writes.map((p) => row(p.id)))
  totalsLine('Needs a look (never written)', plan.filter((p) => p.kind === 'look').map((p) => row(p.id)))
  totalsLine('Already right', plan.filter((p) => p.kind === 'unchanged').map((p) => row(p.id)))
  console.log('Writes ONLY InvoiceScanItem.receivedQtyBase (the line and its RC copies) — no product, box, price, alert, undo record or invoice.')

  const keys = writes.map((p) => p.id)
  if (!APPLY) return recordReviewed(keys)
  const applied = plan.filter((p) => p.kind === 'unchanged').map((p) => p.id)
  if (!guardAgainstReviewed(keys, applied)) { process.exitCode = 1; return }
  if (writes.length === 0) { console.log('Nothing to write.'); return }

  const backup = writeBackup(writes.flatMap((p) => p.kind === 'write'
    ? [{ table: 'InvoiceScanItem', id: p.id, receivedQtyBase: p.prev }, ...p.clones.map((c) => ({ table: 'InvoiceScanItem', id: c.id, receivedQtyBase: c.prev }))]
    : []))
  let done = 0
  for (const p of writes) {
    if (p.kind !== 'write') continue
    await prisma.$transaction([
      prisma.invoiceScanItem.update({ where: { id: p.id }, data: { receivedQtyBase: p.next } }),
      ...p.clones.map((c) => prisma.invoiceScanItem.update({ where: { id: c.id }, data: { receivedQtyBase: c.next } })),
    ])
    done++
  }
  console.log(`applied ${done} line(s).`)
  printCp(backup)
}

// ─────────────────────────────────────────────────────────────────────────────
// B — guard-blocked lines
// ─────────────────────────────────────────────────────────────────────────────

async function runBlocked() {
  const lines = await loadLines({
    approved: false, action: { in: PRICED }, matchedItemId: { not: null },
    session: { status: 'APPROVED', parentSessionId: null },
  })
  const itemIds = [...new Set(lines.map((l) => l.matchedItemId!))]
  const offersByItem = await loadOffers(itemIds)
  const afterCount = await loadLastCounts()
  const defaultRc = await defaultRcId()
  const rcName = await rcNames()

  const memberships = new Set((await prisma.itemRevenueCenter.findMany({
    where: { inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true, revenueCenterId: true },
  })).map((m) => `${m.inventoryItemId}|${m.revenueCenterId}`))
  const allocations = new Set((await prisma.stockAllocation.findMany({
    where: { inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true, revenueCenterId: true },
  })).map((m) => `${m.inventoryItemId}|${m.revenueCenterId}`))

  // Latest approved purchase date per (item, supplier), for "a newer invoice exists".
  const approvedSame = itemIds.length ? await prisma.invoiceScanItem.findMany({
    where: { approved: true, matchedItemId: { in: itemIds }, session: { status: 'APPROVED' } },
    select: { matchedItemId: true, session: { select: { supplierId: true, purchaseDate: true, approvedAt: true } } },
  }) : []
  const latestBy = new Map<string, Date>()
  for (const a of approvedSame) {
    const d = lineDate(a.session)
    if (!d || !a.session.supplierId) continue
    const k = `${a.matchedItemId}|${a.session.supplierId}`
    const prev = latestBy.get(k)
    if (!prev || d > prev) latestBy.set(k, d)
  }
  // The purchase date of each box's own source invoice.
  const srcIds = [...new Set([...offersByItem.values()].flat().map((o) => o.lastInvoiceSessionId).filter((v): v is string => !!v))]
  const srcDate = new Map((await prisma.invoiceSession.findMany({
    where: { id: { in: srcIds } }, select: { id: true, purchaseDate: true, approvedAt: true },
  })).map((s) => [s.id, lineDate(s)]))

  const info = new Map<string, { l: Line; verdict: string; rcId: string | null; lineOffer: Offer | null }>()
  const inputs: BlockedInput[] = lines.map((l) => {
    const item = l.matchedItem!
    const offers = offersByItem.get(item.id) ?? []
    const { d, lineOffer } = decide(l, offers)
    const verdict = d.ok ? (d.implausible ? 'PRICE_IMPLAUSIBLE' : 'ok') : d.reason
    // The receiving rule through this supplier's box — the frozen value deliberately not passed.
    const receiveBase = lineReceived(qtyOf(l), resolveLineFormat(chainOf(item), lineOffer)).base
    const rcId = l.revenueCenterId ?? l.session.revenueCenterId ?? defaultRc
    const ld = lineDate(l.session)
    const box: BoxFacts | null = lineOffer ? {
      id: lineOffer.id, isPrimary: lineOffer.isPrimary, lastUpdated: lineOffer.lastUpdated,
      sourcePurchaseDate: lineOffer.lastInvoiceSessionId ? srcDate.get(lineOffer.lastInvoiceSessionId) ?? null : null,
      newerSameSupplierLine: !!(ld && l.session.supplierId && (latestBy.get(`${item.id}|${l.session.supplierId}`)?.getTime() ?? 0) > ld.getTime()),
      linePurchaseDate: ld ?? new Date(0), sessionApprovedAt: l.session.approvedAt,
    } : null
    const boxWrite = d.ok && lineOffer
      ? boxRefreshWrite({ line: l, item, heldChain: lineOffer.packChain, d })
      : null
    info.set(l.id, { l, verdict, rcId, lineOffer })
    return {
      id: l.id, action: l.action, approved: l.approved, matchedItemId: l.matchedItemId, sessionStatus: l.session.status,
      isClone: !!l.session.parentSessionId, splitToSessionId: l.splitToSessionId,
      item: { isActive: item.isActive, mergedIntoId: item.mergedIntoId },
      receiveBase, verdict, rcId, defaultRcId: defaultRc,
      hasMembership: !!rcId && memberships.has(`${item.id}|${rcId}`),
      hasAllocation: !!rcId && allocations.has(`${item.id}|${rcId}`),
      box, boxWrite,
    }
  })

  const plan = planBlocked(inputs, { withBoxRefresh: WITH_BOX_REFRESH })
  const writes = plan.filter((p): p is Extract<BlockedPlan, { kind: 'write' }> => p.kind === 'write')
  const VERDICT_WORDS: Record<string, string> = {
    ok: 'clear today', PACK_DISAGREES: 'case size differs', RATE_UNCOSTABLE: 'priced by weight, counted by each',
    NO_PRICE: 'no price', PRICE_IMPLAUSIBLE: 'price looks far off', NOT_LINKED: 'not linked',
  }
  console.log(`=== Mode blocked — lines approve refused, left unreceived inside an approved invoice ===`)
  console.log(`Receives the stock only; prices, boxes and products are left as they are${WITH_BOX_REFRESH ? ' (except the box refreshes listed)' : ''}.\n`)
  for (const p of plan) {
    const { l, verdict, rcId } = info.get(p.id)!
    const unit = l.matchedItem!.baseUnit
    const extra: string[] = []
    let tag = 'WRITE '
    if (p.kind === 'skip-split-parent') { tag = 'skip  '; extra.push('already counted through its RC copy — skipped') }
    if (p.kind === 'listed') { tag = 'LIST  '; extra.push(p.reason === 'switched-off' ? 'product is switched off — not written' : p.reason === 'merged' ? 'product was merged — not written' : 'cannot be received — not written') }
    if (p.kind === 'write') {
      extra.push(`today: ${VERDICT_WORDS[verdict] ?? verdict}`)
      if (p.membership) extra.push(`+ on the ${rcName(rcId)} list`)
      if (p.allocation) extra.push(`+ stock row in ${rcName(rcId)}`)
      if (p.boxRefresh) extra.push(`+ REFRESH ${supplierOf(l)}'s box (${p.boxRefresh.boxId}) to ${boxWords(p.boxRefresh.write, unit)}`)
      else if (WITH_BOX_REFRESH && p.boxRefreshBlocked.length) extra.push(`box not refreshed: ${p.boxRefreshBlocked.join('; ')}`)
    }
    if (afterCount(rcId, lineDate(l.session))) extra.push('DATED AFTER THE LAST COUNT — moves today\'s stock')
    console.log([
      tag, l.session.invoiceNumber ?? '(no #)', ymd(lineDate(l.session)), supplierOf(l), l.matchedItem!.itemName,
      `"${l.rawDescription}"`, money(Number(l.rawLineTotal ?? 0)),
      `${qty(num(l.receivedQtyBase), unit)} → ${p.kind === 'write' ? qty(p.receivedQtyBase, unit) : '(unchanged)'}`, ...extra,
    ].join(' | '))
  }
  const row = (id: string) => { const { l } = info.get(id)!; return { total: Number(l.rawLineTotal ?? 0), recent: isRecent(l.session) } }
  const tally = new Map<string, number>()
  for (const p of writes) { const v = info.get(p.id)!.verdict; tally.set(v, (tally.get(v) ?? 0) + 1) }
  console.log('')
  totalsLine('Would receive', writes.map((p) => row(p.id)))
  console.log(`  today's verdicts: ${[...tally].map(([v, n]) => `${n} ${VERDICT_WORDS[v] ?? v}`).join(', ') || '—'}`)
  console.log(`  memberships to add: ${writes.filter((p) => p.membership).length}; stock rows to add: ${writes.filter((p) => p.allocation).length}`)
  totalsLine('Split parents skipped (already counted through their RC copy)', plan.filter((p) => p.kind === 'skip-split-parent').map((p) => row(p.id)))
  totalsLine('Listed, not written', plan.filter((p) => p.kind === 'listed').map((p) => row(p.id)))
  if (WITH_BOX_REFRESH) console.log(`  boxes to refresh: ${writes.filter((p) => p.boxRefresh).length}`)
  const sessions = new Map<string, number>()
  for (const p of writes) { const s = info.get(p.id)!.l.sessionId; sessions.set(s, (sessions.get(s) ?? 0) + 1) }
  console.log(`  invoices to get a note: ${sessions.size} — "${appendRepairNote(null, 1, TODAY_LABEL)}"`)

  const keys = [...writes.map((p) => p.id), ...writes.filter((p) => p.boxRefresh).map((p) => `box:${p.id}`)]
  if (!APPLY) return recordReviewed(keys)

  // Applied = a reviewed line now approved (no longer a candidate), or a reviewed box now carrying this line's invoice.
  const planFile = existsSync(planPath(MODE)) ? (JSON.parse(readFileSync(planPath(MODE), 'utf8')) as PlanFile) : null
  const reviewedLineIds = (planFile?.keys ?? []).filter((k) => !k.startsWith('box:'))
  const nowApproved = (await prisma.invoiceScanItem.findMany({ where: { id: { in: reviewedLineIds }, approved: true }, select: { id: true } })).map((r) => r.id)
  const reviewedBoxLines = (planFile?.keys ?? []).filter((k) => k.startsWith('box:')).map((k) => k.slice(4))
  const boxDone: string[] = []
  for (const id of reviewedBoxLines) {
    const l = await prisma.invoiceScanItem.findUnique({ where: { id }, select: { sessionId: true, matchedItemId: true, supplierItemCode: true, session: { select: { supplierId: true } } } })
    if (!l?.matchedItemId || !l.session.supplierId) continue
    const hit = await prisma.inventorySupplierPrice.count({ where: { inventoryItemId: l.matchedItemId, supplierId: l.session.supplierId, lastInvoiceSessionId: l.sessionId } })
    if (hit > 0) boxDone.push(`box:${id}`)
  }
  if (!guardAgainstReviewed(keys, [...nowApproved, ...boxDone])) { process.exitCode = 1; return }
  if (writes.length === 0) { console.log('Nothing to write.'); return }

  // Backup: every row this run touches, as it is now.
  const sessionRows = await prisma.invoiceSession.findMany({ where: { id: { in: [...sessions.keys()] } }, select: { id: true, errorMessage: true } })
  const boxIds = writes.flatMap((p) => (p.boxRefresh ? [p.boxRefresh.boxId] : []))
  const boxRows = boxIds.length ? await prisma.inventorySupplierPrice.findMany({ where: { id: { in: boxIds } }, select: OFFER_ROW_SELECT }) : []
  const backup = writeBackup([
    ...writes.map((p) => ({ table: 'InvoiceScanItem', id: p.id, approved: false, receivedQtyBase: num(info.get(p.id)!.l.receivedQtyBase) })),
    ...sessionRows.map((s) => ({ table: 'InvoiceSession', id: s.id, errorMessage: s.errorMessage })),
    ...writes.flatMap((p) => (p.membership ? [{ table: 'ItemRevenueCenter', created: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId } }] : [])),
    ...writes.flatMap((p) => (p.allocation ? [{ table: 'StockAllocation', created: { inventoryItemId: p.allocation.itemId, revenueCenterId: p.allocation.rcId } }] : [])),
    ...boxRows.map((b) => ({ table: 'InventorySupplierPrice', ...b })),
  ])

  const noted = new Set<string>()
  const sessionNote = new Map(sessionRows.map((s) => [s.id, s.errorMessage]))
  let done = 0
  for (const p of writes) {
    const { l } = info.get(p.id)!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops: any[] = [
      prisma.invoiceScanItem.update({ where: { id: p.id }, data: { approved: true, receivedQtyBase: p.receivedQtyBase } }),
    ]
    if (p.membership) {
      ops.push(prisma.itemRevenueCenter.upsert({
        where: { inventoryItemId_revenueCenterId: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId } },
        create: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId }, update: {},
      }))
    }
    if (p.allocation) {
      ops.push(prisma.stockAllocation.upsert({
        where: { revenueCenterId_inventoryItemId: { revenueCenterId: p.allocation.rcId, inventoryItemId: p.allocation.itemId } },
        create: { revenueCenterId: p.allocation.rcId, inventoryItemId: p.allocation.itemId, quantity: 0 }, update: {},
      }))
    }
    if (p.boxRefresh) {
      const w = p.boxRefresh.write
      ops.push(prisma.inventorySupplierPrice.update({
        where: { id: p.boxRefresh.boxId },
        data: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          packChain: w.packChain as any, pricing: w.pricing as any,
          packQty: w.packQty, packSize: w.packSize, packUOM: w.packUOM,
          lastInvoiceSessionId: l.sessionId, lastUpdated: new Date(),
        },
      }))
    }
    // The invoice's note travels with its first repaired line (idempotent: never appended twice).
    if (!noted.has(l.sessionId)) {
      noted.add(l.sessionId)
      ops.push(prisma.invoiceSession.update({
        where: { id: l.sessionId },
        data: { errorMessage: appendRepairNote(sessionNote.get(l.sessionId) ?? null, sessions.get(l.sessionId)!, TODAY_LABEL) },
      }))
    }
    await prisma.$transaction(ops)
    done++
  }
  console.log(`applied ${done} line(s); ${noted.size} invoice note(s).`)
  printCp(backup)
}

// ─────────────────────────────────────────────────────────────────────────────
// C — create-new lines on RC-split invoices
// ─────────────────────────────────────────────────────────────────────────────

async function runSplitCreateNew() {
  const clones = await loadLines({
    approved: true, action: 'CREATE_NEW', matchedItemId: null,
    session: { status: 'APPROVED', parentSessionId: { not: null } },
  })
  const parentSessionIds = [...new Set(clones.map((c) => c.session.parentSessionId!))]
  const parents = parentSessionIds.length ? await prisma.invoiceScanItem.findMany({
    where: { sessionId: { in: parentSessionIds } },
    select: { id: true, sessionId: true, rawDescription: true, sortOrder: true, matchedItemId: true, receivedQtyBase: true, rawLineTotal: true },
  }) : []
  const undo = parentSessionIds.length ? await prisma.invoiceApproveUndo.findMany({
    where: { sessionId: { in: parentSessionIds }, kind: 'ITEM_CREATED' }, select: { sessionId: true, targetId: true },
  }) : []
  const itemCreatedBySession = new Map<string, string[]>()
  for (const u of undo) itemCreatedBySession.set(u.sessionId, [...(itemCreatedBySession.get(u.sessionId) ?? []), u.targetId])
  const itemIds = [...new Set(parents.map((p) => p.matchedItemId).filter((v): v is string => !!v))]
  const itemRows = itemIds.length ? await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds } }, select: { id: true, itemName: true, isActive: true, mergedIntoId: true, baseUnit: true },
  }) : []
  const items = new Map(itemRows.map((i) => [i.id, { name: i.itemName, isActive: i.isActive, mergedIntoId: i.mergedIntoId }]))
  const baseUnitOf = new Map(itemRows.map((i) => [i.id, i.baseUnit]))
  const memberships = new Set((itemIds.length ? await prisma.itemRevenueCenter.findMany({
    where: { inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true, revenueCenterId: true },
  }) : []).map((m) => `${m.inventoryItemId}|${m.revenueCenterId}`))
  const afterCount = await loadLastCounts()
  const rcName = await rcNames()

  const byId = new Map(clones.map((c) => [c.id, c]))
  const plan = planSplitCreateNew({
    clones: clones.map((c) => ({
      id: c.id, parentSessionId: c.session.parentSessionId!, rawDescription: c.rawDescription, sortOrder: c.sortOrder,
      rawLineTotal: c.rawLineTotal?.toString(), receivedQtyBase: num(c.receivedQtyBase),
      rcId: c.revenueCenterId ?? c.session.revenueCenterId,
    })),
    parents: parents.map((p) => ({
      id: p.id, sessionId: p.sessionId, rawDescription: p.rawDescription, sortOrder: p.sortOrder,
      matchedItemId: p.matchedItemId, receivedQtyBase: num(p.receivedQtyBase), rawLineTotal: p.rawLineTotal?.toString(),
    })),
    itemCreatedBySession, items, memberships,
  })
  const writes = plan.filter((p): p is Extract<typeof p, { kind: 'write' }> => p.kind === 'write')

  console.log(`=== Mode split-create-new — the RC copy of a new-product line never got the new product ===`)
  console.log(`${clones.length} RC-copy line(s) with no product.\n`)
  for (const p of plan) {
    const c = byId.get(p.id)!
    const extra: string[] = []
    let tag = 'WRITE '
    let itemName = '?'
    let receipt = '(unchanged)'
    if (p.kind === 'look') { tag = 'LOOK  '; extra.push(`NEEDS A LOOK — ${p.reason}`) }
    else {
      itemName = p.itemName
      const unit = baseUnitOf.get(p.itemId)
      receipt = p.receivedQtyBase != null
        ? `${qty(num(c.receivedQtyBase), unit)} → ${qty(p.receivedQtyBase, unit)}`
        : `keeps ${qty(p.kept!.value, unit)}${p.kept!.differs ? ` (the original line's share would be ${qty(p.kept!.fromParent, unit)})` : ''}`
      extra.push(`share ${p.share.toPrecision(3)}`)
      if (p.membership) extra.push(`+ on the ${rcName(p.membership.rcId)} list`)
      if (p.flags.includes('switched-off')) extra.push('PRODUCT IS SWITCHED OFF — linked anyway')
    }
    if (afterCount(c.revenueCenterId ?? c.session.revenueCenterId, lineDate(c.session))) extra.push('DATED AFTER THE LAST COUNT — moves today\'s stock')
    console.log([
      tag, c.session.invoiceNumber ?? '(no #)', ymd(lineDate(c.session)), supplierOf(c), itemName,
      `"${c.rawDescription}"`, money(Number(c.rawLineTotal ?? 0)), receipt, ...extra,
    ].join(' | '))
  }
  const row = (id: string) => { const c = byId.get(id)!; return { total: Number(c.rawLineTotal ?? 0), recent: isRecent(c.session) } }
  console.log('')
  totalsLine('Would link', writes.map((p) => row(p.id)))
  console.log(`  receipts written: ${writes.filter((p) => p.receivedQtyBase != null).length}; kept: ${writes.filter((p) => p.kept).length} (differing: ${writes.filter((p) => p.kept?.differs).length})`)
  console.log(`  shares other than 1: ${writes.filter((p) => Math.abs(p.share - 1) > 1e-9).length}; memberships to add: ${writes.filter((p) => p.membership).length}; switched-off products: ${writes.filter((p) => p.flags.includes('switched-off')).length}`)
  totalsLine('Needs a look (never written)', plan.filter((p) => p.kind === 'look').map((p) => row(p.id)))
  console.log('Writes ONLY the RC copy (product link + receipt) and its RC membership — never the original line, the product, its boxes, prices or wordings.')

  const keys = writes.map((p) => p.id)
  if (!APPLY) return recordReviewed(keys)
  const planFile = existsSync(planPath(MODE)) ? (JSON.parse(readFileSync(planPath(MODE), 'utf8')) as PlanFile) : null
  const applied = (await prisma.invoiceScanItem.findMany({
    where: { id: { in: planFile?.keys ?? [] }, matchedItemId: { not: null } }, select: { id: true },
  })).map((r) => r.id)
  if (!guardAgainstReviewed(keys, applied)) { process.exitCode = 1; return }
  if (writes.length === 0) { console.log('Nothing to write.'); return }

  const backup = writeBackup([
    ...writes.map((p) => ({ table: 'InvoiceScanItem', id: p.id, matchedItemId: null, receivedQtyBase: num(byId.get(p.id)!.receivedQtyBase) })),
    ...writes.flatMap((p) => (p.membership ? [{ table: 'ItemRevenueCenter', created: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId } }] : [])),
  ])
  let done = 0
  const seenMembership = new Set<string>()
  for (const p of writes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops: any[] = [prisma.invoiceScanItem.update({
      where: { id: p.id },
      data: { matchedItemId: p.itemId, ...(p.receivedQtyBase != null ? { receivedQtyBase: p.receivedQtyBase } : {}) },
    })]
    if (p.membership && !seenMembership.has(`${p.membership.itemId}|${p.membership.rcId}`)) {
      seenMembership.add(`${p.membership.itemId}|${p.membership.rcId}`)
      ops.push(prisma.itemRevenueCenter.upsert({
        where: { inventoryItemId_revenueCenterId: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId } },
        create: { inventoryItemId: p.membership.itemId, revenueCenterId: p.membership.rcId }, update: {},
      }))
    }
    await prisma.$transaction(ops)
    done++
  }
  console.log(`applied ${done} line(s).`)
  printCp(backup)
}

async function main() {
  if (MODE === 'unitless-weight') await runUnitless()
  else if (MODE === 'blocked') await runBlocked()
  else await runSplitCreateNew()
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
