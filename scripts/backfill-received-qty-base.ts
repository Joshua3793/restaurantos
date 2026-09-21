/**
 * Freeze InvoiceScanItem.receivedQtyBase for every approved line.
 *
 * THREE explicit modes — anything else is refused (see parseMode in
 * src/lib/invoice/refreeze.ts), including a bare --apply naming no mode:
 *
 *   npx tsx scripts/backfill-received-qty-base.ts                     # (a) DRY RUN of fill-null mode, read-only
 *   npx tsx scripts/backfill-received-qty-base.ts --refreeze          # (b) RE-FREEZE dry run: recompute EVERY approved
 *                                                                      #   line under the CURRENT rule, ignoring the
 *                                                                      #   stored value; writes nothing
 *   npx tsx scripts/backfill-received-qty-base.ts --refreeze --apply  # (b) back up, then update only rows that changed
 *   npx tsx scripts/backfill-received-qty-base.ts --fill-null --apply # (c) apply the ORIGINAL fill-null mode
 *
 * A bare `--apply` (no `--refreeze` or `--fill-null`) is a live foot-gun since
 * the rule changed and is REFUSED: fill-null was written to fill NULL rows
 * under the OLD rule; applying it blanket-wide now (no material-change filter,
 * no clone handling) would re-break the pre-2026-06-19 clone rows --refreeze
 * exists to fix. Explicit `--fill-null --apply` runs it anyway, unchanged
 * otherwise, but now also: (1) never writes a row whose receivedQtyBase is
 * already non-null (fill-null FILLS, it does not overwrite), and (2) skips
 * clone rows (session.parentSessionId set) entirely — those are counted and
 * reported, never derived here; use --refreeze for clones.
 *
 * fill-null mode: "old" = today's rule read through the item's OWN chain.
 * "next" = the supplier-offer rule. Every NULL row where they differ is a
 * historical miscount the dry run surfaces.
 *
 * --refreeze mode compares a completely different pair: the value already
 * FROZEN in receivedQtyBase (from whatever rule was live when the line was
 * approved) against the CURRENT lineReceived rule, recomputed fresh — the
 * frozen value is never passed in (global-constraints.md: a caller computing
 * the value to freeze must not pass it). RC clone rows are never run through
 * the rule directly; a clone is its parent's new value scaled by
 * (clone.rawLineTotal / parent.rawLineTotal). A clone whose parent can't be
 * found (missing, ambiguous, or never recomputed), or whose totals aren't
 * both a finite number > 0, is an ORPHAN — left alone, only counted, and
 * written into the diff JSON's top-level `orphans` array (id, item, supplier,
 * invoice, its stored frozen value, and WHY: "no parent" / "ambiguous parent" /
 * "non-positive totals"). The diff file is therefore `{ changed: [...],
 * orphans: [...] }`, not a bare array.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, type ChainItem } from '../src/lib/item-model'
import { lineReceived, lineReceivedBaseUnits } from '../src/lib/invoice/line-qty'
import { resolveLineFormat, pickOffer } from '../src/lib/invoice/line-format'
import { cloneShare, isMaterialChange, parseMode } from '../src/lib/invoice/refreeze'

const argv = process.argv.slice(2)
const parsed = parseMode(argv)
if ('error' in parsed) {
  console.error(parsed.error)
  console.error('Usage: backfill-received-qty-base.ts [--refreeze [--apply [--skip-pack-path]] | --fill-null --apply]')
  process.exit(2)
}

const REFREEZE = parsed.mode === 'refreeze'
const APPLY = parsed.apply
const SKIP_PACK_PATH = parsed.skipPackPath
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

// Per-case lines that carry a stray billed-weight column but NO printed rate that
// reproduces their total (Butter "2.86 kg" on 2 × 25 × 454 g; Halloumi; Brioche).
// They must NEVER move TO a billed weight: if one does, the money check is wrong.
// (Goats Cheese and Cheese Curd were on this list until 2026-09-21: their printed
// $/kg × billed weight reproduces the total exactly — genuine catch weight — and
// the user decided a printed rate is proof.) Exact item names, so an unrelated
// "cocoa butter" or a per-kg bulk butter line changing legitimately cannot trip it.
const NEVER_BY_BILLED_WEIGHT = ['butter', 'halloumi', 'brioche unsliced']
const hitsSyscoFive = (itemName: string | null | undefined, via?: string): boolean =>
  NEVER_BY_BILLED_WEIGHT.includes((itemName ?? '').trim().toLowerCase()) && (via ?? '').includes('billed-weight')

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
// fill-null mode — the original mode, now explicit (--fill-null --apply).
// Fills NULL receivedQtyBase rows only: it must never overwrite an
// already-frozen row (that is --refreeze's job), and it must never derive a
// clone row's value directly (a clone is a SHARE of its parent's value — see
// --refreeze — never the rule run on the clone's own line).
// ─────────────────────────────────────────────────────────────────────────
async function runFillNull(lines: ScanLine[]) {
  const diff: unknown[] = []
  const writes: { id: string; next: number; prev: string | null }[] = []
  let skippedClones = 0
  let skippedAlreadyFrozen = 0
  for (const l of lines) {
    if (!l.matchedItem) continue
    if (l.session.parentSessionId) { skippedClones++; continue }
    if (l.receivedQtyBase != null) { skippedAlreadyFrozen++; continue }
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
    // l.receivedQtyBase is null here by construction (filtered above).
    if (next > 0) writes.push({ id: l.id, next, prev: null })
  }

  writeFileSync(`received-qty-base-diff-${stamp}.json`, JSON.stringify(diff, null, 2))
  console.log(
    `${lines.length} approved lines · ${writes.length} to freeze · ${diff.length} change vs today's rule`,
  )
  console.log(`clone rows skipped (never filled here — use --refreeze for clones): ${skippedClones}`)
  console.log(`already-frozen rows skipped (fill-null never overwrites): ${skippedAlreadyFrozen}`)
  console.log(`diff → received-qty-base-diff-${stamp}.json`)
  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --fill-null --apply.')
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

type OrphanReason = 'no parent' | 'ambiguous parent' | 'non-positive totals'

interface OrphanRow {
  id: string
  item: string | null
  supplier: string | null
  invoice: string | null
  frozen: number | null
  reason: OrphanReason
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
  // finite number > 0. Orphans keep their frozen value untouched — but are
  // still reported (id, item, supplier, invoice, stored frozen value, and WHY)
  // so someone can go look at them, rather than vanishing into a bare count.
  const orphans: OrphanRow[] = []
  for (const l of lines) {
    if (!l.session.parentSessionId) continue
    const key = `${l.session.parentSessionId}|${l.rawDescription}|${l.sortOrder}`
    const parent = byKey.get(key)
    const parentNext = parent ? next.get(parent.id) : undefined
    const share = parent && parentNext ? cloneShare(parent.rawLineTotal, l.rawLineTotal) : null
    if (parent && parentNext && share !== null) {
      next.set(l.id, {
        base: parentNext.base * share,
        via: `clone of ${parentNext.via}`,
        needsBridge: parentNext.needsBridge,
      })
      continue
    }
    // ambiguousKeys is never mutated after the `byKey.delete` pass above, so a
    // key can still be recognised as "was ambiguous" even though byKey no
    // longer has an entry for it — that's the only way to tell "no parent at
    // all" apart from "more than one candidate parent".
    const reason: OrphanReason = !parent
      ? (ambiguousKeys.has(key) ? 'ambiguous parent' : 'no parent')
      : 'non-positive totals'
    orphans.push({
      id: l.id,
      item: l.matchedItem?.itemName ?? null,
      supplier: l.session.supplierName,
      invoice: l.session.invoiceNumber,
      frozen: l.receivedQtyBase != null ? Number(l.receivedQtyBase) : null,
      reason,
    })
  }

  const diff: DiffRow[] = []
  const writes: { id: string; next: number; prev: string | null; via: string }[] = []
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
    writes.push({ id: l.id, next: computed.base, prev: l.receivedQtyBase?.toString() ?? null, via: computed.via })
  }

  // The diff file is { changed, orphans } — not a bare array — so the orphan
  // clones (never derivable here, left alone) are on record beside the rows
  // that DID change, rather than only a count on the console.
  writeFileSync(
    `received-qty-refreeze-diff-${stamp}.json`,
    JSON.stringify({ changed: diff, orphans }, null, 2),
  )

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
  console.log(`orphan clones (left alone): ${orphans.length}`)
  if (orphans.length > 0) {
    const byReason = new Map<string, number>()
    for (const o of orphans) byReason.set(o.reason, (byReason.get(o.reason) ?? 0) + 1)
    for (const [reason, count] of byReason) console.log(`  ${reason}: ${count}`)
  }
  console.log(`skipped — recomputed to <= 0, never frozen: ${skippedZero}`)
  console.log(`diff ({ changed, orphans }) → received-qty-refreeze-diff-${stamp}.json`)

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

  const syscoFiveHits = diff.filter((row) => hitsSyscoFive(row.item, row.via))
  console.log(
    '\n=== NO-RATE GUARD — Butter / Halloumi / Brioche Unsliced must NOT move to a billed weight ===',
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

  // --apply RECOMPUTES from today's chains and offers; it does not replay the diff a
  // human reviewed. If a pack edit or an approval landed since the dry run, lines can
  // move along a pack path — a change nobody looked at. The rule itself only ever
  // moves a line TO a weight, so anything here means the data shifted: stop.
  const isPackPath = (via: string) => ['printed-pack', 'item-pack', 'none'].includes(baseViaOf(via))
  if (packPathChanges.length > 0 && SKIP_PACK_PATH) {
    const before = writes.length
    for (let i = writes.length - 1; i >= 0; i--) if (isPackPath(writes[i].via)) writes.splice(i, 1)
    console.log(`\n--skip-pack-path: ${before - writes.length} pack-path line(s) EXCLUDED from the write and left as they are (listed above).`)
  } else if (packPathChanges.length > 0) {
    console.error(
      `\nABORTING before any write — ${packPathChanges.length} line(s) would change along a PACK path. ` +
      'That is not the rule: something else changed since the dry run. Re-run the dry run and review it, ' +
      'or pass --skip-pack-path to write only the lines that move TO a weight.',
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
  console.log(
    'If a re-run after a partial failure writes a SECOND backup file, BOTH backups are needed, ' +
      'in that order (oldest first), to fully restore.',
  )
}

async function main() {
  const lines = await fetchApprovedLines()
  if (REFREEZE) {
    await runRefreeze(lines)
  } else {
    await runFillNull(lines)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
