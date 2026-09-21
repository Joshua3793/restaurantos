/**
 * Freeze InvoiceScanItem.receivedQtyBase for every approved line.
 *
 *   npx tsx scripts/backfill-received-qty-base.ts                     # DRY RUN: writes a diff file, changes nothing
 *   npx tsx scripts/backfill-received-qty-base.ts --apply             # backup JSON first, then write
 *   npx tsx scripts/backfill-received-qty-base.ts --refreeze          # RE-FREEZE dry run: recompute EVERY approved
 *                                                                      #   line under the CURRENT rule, ignoring the
 *                                                                      #   stored value; writes nothing
 *   npx tsx scripts/backfill-received-qty-base.ts --refreeze --apply  # back up, then update only rows that changed
 *
 * Default mode (no flags) is UNCHANGED from before --refreeze existed:
 * "old" = today's rule read through the item's OWN chain. "next" = the
 * supplier-offer rule. Every line where they differ is a historical miscount
 * the dry run surfaces.
 *
 * --refreeze mode compares a completely different pair: the value already
 * FROZEN in receivedQtyBase (from whatever rule was live when the line was
 * approved) against the CURRENT lineReceived rule, recomputed fresh — the
 * frozen value is never passed in (global-constraints.md: a caller computing
 * the value to freeze must not pass it). RC clone rows are never run through
 * the rule directly; a clone is its parent's new value scaled by
 * (clone.rawLineTotal / parent.rawLineTotal). A clone whose parent can't be
 * found (missing, ambiguous, or never recomputed), or whose totals aren't
 * both a finite number > 0, is an ORPHAN — left alone, only counted.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, type ChainItem } from '../src/lib/item-model'
import { lineReceived, lineReceivedBaseUnits } from '../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../src/lib/invoice/line-format'
import { cloneShare, isMaterialChange } from '../src/lib/invoice/refreeze'

// Reject any flag we don't recognize (a typo like --aply must never silently
// fall through to a different mode) before touching anything else.
const KNOWN_FLAGS = new Set(['--refreeze', '--apply'])
const argv = process.argv.slice(2)
const unknownFlags = argv.filter((a) => !KNOWN_FLAGS.has(a))
if (unknownFlags.length > 0) {
  console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`)
  console.error('Usage: backfill-received-qty-base.ts [--refreeze] [--apply]')
  process.exit(2)
}

const REFREEZE = argv.includes('--refreeze')
const APPLY = argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// Five Sysco per-case lines that carry a stray weight column and must NEVER
// move under the new rule (global-constraints.md refinement: the new rule only
// ever moves a line TO a weight — if one of these changes, the rule is wrong).
const SYSCO_FIVE_NEVER_CHANGE = ['butter', 'halloumi', 'cheese curd', 'goats cheese', 'brioche']
const hitsSyscoFive = (itemName: string | null | undefined): boolean => {
  const n = (itemName ?? '').toLowerCase()
  return SYSCO_FIVE_NEVER_CHANGE.some((needle) => n.includes(needle))
}

async function fetchApprovedLines() {
  return prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      matchedItemId: { not: null },
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      session: { status: 'APPROVED' },
    },
    select: {
      id: true,
      sessionId: true,
      sortOrder: true,
      splitToSessionId: true,
      rawDescription: true,
      receivedQtyBase: true,
      rawQty: true,
      rawUnit: true,
      totalQty: true,
      totalQtyUOM: true,
      rateUOM: true,
      invoicePackQty: true,
      invoicePackSize: true,
      invoicePackUOM: true,
      rawUnitPrice: true,
      rate: true,
      rawLineTotal: true,
      session: {
        select: {
          supplierId: true,
          supplierName: true,
          invoiceNumber: true,
          purchaseDate: true,
          parentSessionId: true,
          supplier: { select: { name: true } },
        },
      },
      matchedItem: {
        select: {
          id: true,
          itemName: true,
          ...PRICING_SELECT,
          supplierPrices: {
            select: { supplierId: true, supplierName: true, packChain: true, pricing: true },
          },
        },
      },
    },
  })
}

type ScanLine = Awaited<ReturnType<typeof fetchApprovedLines>>[number]

/** The `LineQtyInput` literal `lineReceived`/`lineReceivedBaseUnits` need —
 *  deliberately WITHOUT `receivedQtyBase`: a caller computing the value to
 *  freeze must never pass the frozen value in (it would just echo itself back). */
function inputOf(l: ScanLine) {
  return {
    rawQty: l.rawQty?.toString() ?? null,
    rawUnit: l.rawUnit,
    totalQty: l.totalQty?.toString() ?? null,
    totalQtyUOM: l.totalQtyUOM,
    rateUOM: l.rateUOM,
    invoicePackQty: l.invoicePackQty?.toString() ?? null,
    invoicePackSize: l.invoicePackSize?.toString() ?? null,
    invoicePackUOM: l.invoicePackUOM,
    rawUnitPrice: l.rawUnitPrice?.toString() ?? null,
    rate: l.rate?.toString() ?? null,
    rawLineTotal: l.rawLineTotal?.toString() ?? null,
  }
}

/** The chain a line should be received through: the item's chain, adjusted for
 *  the line's own supplier offer when it has a usable one. Null only when the
 *  line has no matched item (defensive — the query already requires one). */
function offerChainFor(l: ScanLine): ChainItem | null {
  if (!l.matchedItem) return null
  return resolveLineFormat(
    asChainItem(l.matchedItem),
    pickOffer(l.matchedItem.supplierPrices, {
      supplierId: l.session.supplierId,
      supplierName: l.session.supplierName,
      canonicalName: l.session.supplier?.name ?? null,
    }),
  )
}

function printedPack(l: ScanLine): string | null {
  const q = l.invoicePackQty != null ? Number(l.invoicePackQty) : NaN
  const s = l.invoicePackSize != null ? Number(l.invoicePackSize) : NaN
  if (!(q > 0) || !(s > 0) || !l.invoicePackUOM) return null
  return `${q} x ${s} ${l.invoicePackUOM}`
}

function qtyAndUnit(qty: unknown, unit: string | null): string | null {
  if (qty == null) return null
  const n = Number(qty)
  if (!Number.isFinite(n)) return null
  return unit ? `${n} ${unit}` : `${n}`
}

// ─────────────────────────────────────────────────────────────────────────
// Default mode — UNCHANGED from before --refreeze existed.
// ─────────────────────────────────────────────────────────────────────────
async function runOriginal(lines: ScanLine[]) {
  const diff: unknown[] = []
  const writes: { id: string; next: number; prev: string | null }[] = []
  for (const l of lines) {
    if (!l.matchedItem) continue
    const input = inputOf(l)
    const chain = asChainItem(l.matchedItem)
    const old = lineReceivedBaseUnits(input, chain)
    const next = lineReceivedBaseUnits(
      input,
      resolveLineFormat(
        chain,
        pickOffer(l.matchedItem.supplierPrices, {
          supplierId: l.session.supplierId,
          supplierName: l.session.supplierName,
          canonicalName: l.session.supplier?.name ?? null,
        }),
      ),
    )
    if (Math.abs(next - old) > Math.max(0.001, old * 0.005)) {
      diff.push({
        item: l.matchedItem.itemName,
        base: l.matchedItem.baseUnit,
        line: l.rawDescription,
        supplier: l.session.supplierName,
        invoice: l.session.invoiceNumber,
        date: l.session.purchaseDate,
        old,
        next,
        ratio: old > 0 ? +(next / old).toFixed(3) : null,
      })
    }
    if (next > 0) writes.push({ id: l.id, next, prev: l.receivedQtyBase?.toString() ?? null })
  }

  writeFileSync(`received-qty-base-diff-${stamp}.json`, JSON.stringify(diff, null, 2))
  console.log(
    `${lines.length} approved lines · ${writes.length} to freeze · ${diff.length} change vs today's rule`,
  )
  console.log(`diff → received-qty-base-diff-${stamp}.json`)
  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply.')
    return
  }

  writeFileSync(
    `received-qty-base-backup-${stamp}.json`,
    JSON.stringify(
      writes.map((w) => ({ id: w.id, prev: w.prev })),
      null,
      2,
    ),
  )
  for (const w of writes) {
    await prisma.invoiceScanItem.update({ where: { id: w.id }, data: { receivedQtyBase: w.next } })
  }
  console.log(`applied ${writes.length} · backup → received-qty-base-backup-${stamp}.json`)
}

// ─────────────────────────────────────────────────────────────────────────
// --refreeze mode
// ─────────────────────────────────────────────────────────────────────────
interface NextResult {
  base: number
  via: string
  needsBridge: boolean
}

interface DiffRow {
  item: string | null
  baseUnit: string | null
  supplier: string | null
  invoice: string | null
  date: unknown
  rawDescription: string
  qty: string | null
  billed: string | null
  rateInfo: string | null
  rawUnitPrice: number | null
  rawLineTotal: number | null
  pack: string | null
  old: number
  next: number
  ratio: number | null
  via: string
  needsBridge: boolean
  isClone: boolean
  eachMeasureQty: number | null
  eachMeasureUnit: string | null
  densityGPerMl: number | null
}

function buildDiffRow(l: ScanLine, computed: NextResult, old: number): DiffRow {
  return {
    item: l.matchedItem?.itemName ?? null,
    baseUnit: l.matchedItem?.baseUnit ?? null,
    supplier: l.session.supplierName,
    invoice: l.session.invoiceNumber,
    date: l.session.purchaseDate,
    rawDescription: l.rawDescription,
    qty: qtyAndUnit(l.rawQty, l.rawUnit),
    billed: qtyAndUnit(l.totalQty, l.totalQtyUOM),
    rateInfo: l.rate != null ? `${l.rate.toString()}${l.rateUOM ? ` / ${l.rateUOM}` : ''}` : null,
    rawUnitPrice: l.rawUnitPrice != null ? Number(l.rawUnitPrice) : null,
    rawLineTotal: l.rawLineTotal != null ? Number(l.rawLineTotal) : null,
    pack: printedPack(l),
    old,
    next: computed.base,
    ratio: old > 0 ? +(computed.base / old).toFixed(3) : null,
    via: computed.via,
    needsBridge: computed.needsBridge,
    isClone: !!l.session.parentSessionId,
    eachMeasureQty: l.matchedItem?.eachMeasureQty != null ? Number(l.matchedItem.eachMeasureQty) : null,
    eachMeasureUnit: l.matchedItem?.eachMeasureUnit ?? null,
    densityGPerMl: l.matchedItem?.densityGPerMl != null ? Number(l.matchedItem.densityGPerMl) : null,
  }
}

const baseViaOf = (via: string): string => (via.startsWith('clone of ') ? via.slice('clone of '.length) : via)

async function runRefreeze(lines: ScanLine[]) {
  // Parent lookup key: parentSessionId|rawDescription|sortOrder. Verified
  // against scaledCopy() in approve/route.ts — both rawDescription and
  // sortOrder are copied onto the clone row unchanged from the parent, so the
  // parent's OWN sessionId + those two fields reproduces the key a clone
  // carries via session.parentSessionId. Two parent lines sharing a key make
  // every clone at that key ambiguous — never guess which one it came from.
  const byKey = new Map<string, ScanLine>()
  const ambiguousKeys = new Set<string>()
  for (const l of lines) {
    if (l.session.parentSessionId) continue
    const key = `${l.sessionId}|${l.rawDescription}|${l.sortOrder}`
    if (byKey.has(key)) ambiguousKeys.add(key)
    else byKey.set(key, l)
  }
  for (const key of ambiguousKeys) byKey.delete(key)

  // PARENTS and ordinary lines: run the rule (never pass receivedQtyBase).
  const next = new Map<string, NextResult>()
  for (const l of lines) {
    if (!l.matchedItem || l.session.parentSessionId) continue
    const chain = offerChainFor(l)
    if (!chain) continue
    next.set(l.id, lineReceived(inputOf(l), chain))
  }

  // CLONES: never run through the rule — a clone carries a SHARE of its
  // parent's new value. Orphan when the parent can't be found (missing,
  // ambiguous, or its own recompute was skipped) or either total isn't a
  // finite number > 0. Orphans keep their frozen value untouched.
  const orphanIds: string[] = []
  for (const l of lines) {
    if (!l.session.parentSessionId) continue
    const parent = byKey.get(`${l.session.parentSessionId}|${l.rawDescription}|${l.sortOrder}`)
    const parentNext = parent ? next.get(parent.id) : undefined
    const share = parent && parentNext ? cloneShare(parent.rawLineTotal, l.rawLineTotal) : null
    if (!parent || !parentNext || share === null) {
      orphanIds.push(l.id)
      continue
    }
    next.set(l.id, {
      base: parentNext.base * share,
      via: `clone of ${parentNext.via}`,
      needsBridge: parentNext.needsBridge,
    })
  }

  const diff: DiffRow[] = []
  const writes: { id: string; next: number; prev: string | null }[] = []
  let skippedZero = 0
  for (const l of lines) {
    const computed = next.get(l.id)
    if (!computed) continue // orphan clone, or no matched item / rule never ran — left alone
    if (!(computed.base > 0)) {
      skippedZero++ // never freeze a zero
      continue
    }
    const old = Number(l.receivedQtyBase ?? 0)
    if (!isMaterialChange(old, computed.base)) continue
    diff.push(buildDiffRow(l, computed, old))
    writes.push({ id: l.id, next: computed.base, prev: l.receivedQtyBase?.toString() ?? null })
  }

  writeFileSync(`received-qty-refreeze-diff-${stamp}.json`, JSON.stringify(diff, null, 2))

  const viaCounts = new Map<string, number>()
  let needsBridgeCount = 0
  for (const row of diff) {
    const key = baseViaOf(row.via)
    viaCounts.set(key, (viaCounts.get(key) ?? 0) + 1)
    if (row.needsBridge) needsBridgeCount++
  }

  console.log(`--refreeze: ${lines.length} approved lines considered`)
  console.log(`${diff.length} changed vs the frozen value`)
  console.log('changed, by via:')
  for (const [via, count] of [...viaCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${via}: ${count}`)
  }
  console.log(`needsBridge: ${needsBridgeCount}`)
  console.log(`orphan clones (left alone): ${orphanIds.length}`)
  console.log(`skipped — recomputed to <= 0, never frozen: ${skippedZero}`)
  console.log(`diff → received-qty-refreeze-diff-${stamp}.json`)

  const packPathChanges = diff.filter((row) => ['printed-pack', 'item-pack', 'none'].includes(baseViaOf(row.via)))
  console.log(
    '\n=== PACK-PATH CHANGES — should be empty. The new rule only ever moves a line TO a weight; ' +
      'anything here means something other than the rule shifted. ===',
  )
  if (packPathChanges.length === 0) {
    console.log('  (none)')
  } else {
    for (const row of packPathChanges) {
      console.log(`  ${row.item} · ${row.rawDescription} · via=${row.via} old=${row.old} next=${row.next}`)
    }
  }

  const syscoFiveHits = diff.filter((row) => hitsSyscoFive(row.item))
  console.log(
    '\n=== SYSCO-FIVE GUARD — Butter / Halloumi / CHEESE CURD / Goats Cheese / Brioche must NOT change ===',
  )
  if (syscoFiveHits.length === 0) {
    console.log('  (none — clean)')
  } else {
    for (const row of syscoFiveHits) {
      console.log(`  ${row.item} · ${row.rawDescription} · via=${row.via} old=${row.old} next=${row.next}`)
    }
    console.log('  STOP — the rule is wrong')
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --refreeze --apply.')
    return
  }

  if (syscoFiveHits.length > 0) {
    console.error(
      '\nABORTING before any write — the Sysco-five guard tripped. Fix the rule, re-run the dry run, then apply.',
    )
    process.exitCode = 1
    return
  }

  writeFileSync(
    `received-qty-refreeze-backup-${stamp}.json`,
    JSON.stringify(
      writes.map((w) => ({ id: w.id, prev: w.prev })),
      null,
      2,
    ),
  )
  for (const w of writes) {
    await prisma.invoiceScanItem.update({ where: { id: w.id }, data: { receivedQtyBase: w.next } })
  }
  console.log(`\napplied ${writes.length} · backup → received-qty-refreeze-backup-${stamp}.json`)
}

async function main() {
  const lines = await fetchApprovedLines()
  if (REFREEZE) {
    await runRefreeze(lines)
  } else {
    await runOriginal(lines)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
