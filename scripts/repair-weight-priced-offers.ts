/**
 * Repair supplier offers stored as a case (PACK) price when they were actually
 * billed by weight — a shape only possible BEFORE this branch's dimension-aware
 * rate formula and line-first receiving (a by-weight $3.49/lb price saved as a
 * PACK case price over a case chain). Dry run by default; nothing is written
 * without `--apply`, and the implementer of this script never runs it.
 *
 *   npx tsx scripts/repair-weight-priced-offers.ts            # DRY RUN, read-only
 *   npx tsx scripts/repair-weight-priced-offers.ts --apply    # back up, then write only the `rewrite` rows
 *
 * Scope: every COUNT item with an each-measure bridge AND at least one supplier
 * offer. For each offer, the item's most recent APPROVED, non-clone purchase
 * line from THAT supplier (matched the same way `pickOffer` matches a line to
 * an offer: supplierId, then canonicalName, then supplierName) is the evidence
 * `planOfferRepair` (src/lib/invoice/offer-repair.ts) reasons from. Ties broken
 * by session.purchaseDate desc, then session.createdAt desc.
 *
 * `planOfferRepair` never touches `packChain` or the provenance triple
 * (packQty/packSize/packUOM) — only `pricing` + `lastPrice` move on a `rewrite`.
 * A `human` verdict (the PRIMARY offer) is never auto-applied: rewriting it
 * re-prices the item itself and every recipe that uses it.
 *
 * `--apply` RE-READS each offer immediately before writing it and refuses that
 * one write (leaving it out, reported separately) if the offer's stored
 * `pricing`/`lastPrice` no longer matches what this run planned against — the
 * dry run a human reviewed must not be replayed blind onto data that moved
 * since (an invoice approved on the item, another repair run, a manual edit).
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT, asChainItem, type ChainItem, type Pricing } from '../src/lib/item-model'
import { pickOffer } from '../src/lib/invoice/line-format'
import { offerPricePerBase } from '../src/lib/offer-price'
import { planOfferRepair, type RepairLine } from '../src/lib/invoice/offer-repair'

const argv = process.argv.slice(2)
const KNOWN_FLAGS = new Set(['--apply'])
const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a))
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(', ')}`)
  console.error('Usage: repair-weight-priced-offers.ts [--apply]')
  process.exit(2)
}
const APPLY = argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

async function fetchCandidateItems() {
  return prisma.inventoryItem.findMany({
    where: {
      dimension: 'COUNT',
      eachMeasureQty: { not: null },
      eachMeasureUnit: { not: null },
      supplierPrices: { some: {} },
    },
    select: {
      id: true,
      itemName: true,
      ...PRICING_SELECT,
      supplierPrices: {
        select: {
          id: true,
          supplierName: true,
          supplierId: true,
          lastPrice: true,
          isPrimary: true,
          pricing: true,
          packChain: true,
        },
      },
    },
  })
}

type ItemRow = Awaited<ReturnType<typeof fetchCandidateItems>>[number]
type OfferRow = ItemRow['supplierPrices'][number]

async function fetchApprovedLines(itemIds: string[]) {
  return prisma.invoiceScanItem.findMany({
    where: {
      matchedItemId: { in: itemIds },
      approved: true,
      splitToSessionId: null,
      session: { status: 'APPROVED' },
    },
    select: {
      id: true,
      matchedItemId: true,
      rawDescription: true,
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
          createdAt: true,
          supplier: { select: { name: true } },
        },
      },
    },
  })
}

type ScanLine = Awaited<ReturnType<typeof fetchApprovedLines>>[number]

/** The `RepairLine` literal `planOfferRepair` needs — deliberately WITHOUT
 *  `receivedQtyBase`: passing the frozen value back in would make `lineReceived`
 *  read `via: 'frozen'` and never re-derive the true billed-weight/shipped-unit
 *  classification this repair depends on (global-constraints.md; mirrors
 *  `inputOf` in scripts/backfill-received-qty-base.ts). */
function inputOf(l: ScanLine): RepairLine {
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

/** The most recent approved, non-clone line belonging to THIS offer's supplier —
 *  same join `pickOffer` uses elsewhere, just walked from the line's own
 *  session ref rather than the offer's. */
function lastLineFor(offer: OfferRow, lines: ScanLine[]): ScanLine | null {
  const matches = lines.filter((l) => {
    const owner = pickOffer([offer], {
      supplierId: l.session.supplierId,
      supplierName: l.session.supplierName,
      canonicalName: l.session.supplier?.name ?? null,
    })
    return owner?.id === offer.id
  })
  if (matches.length === 0) return null
  matches.sort((a, b) => {
    const da = a.session.purchaseDate ? a.session.purchaseDate.getTime() : 0
    const db = b.session.purchaseDate ? b.session.purchaseDate.getTime() : 0
    if (db !== da) return db - da
    return b.session.createdAt.getTime() - a.session.createdAt.getTime()
  })
  return matches[0]
}

interface PlanRow {
  itemId: string
  itemName: string
  offerId: string
  supplier: string | null
  prevPricing: Pricing | null
  prevLastPrice: number
  ppbBefore: number
  line: { invoice: string | null; description: string; date: unknown } | null
  reason?: string
}

interface RewriteRow extends PlanRow {
  nextPricing: Pricing
  nextLastPrice: number
  ppbAfter: number
}

function fmtPricing(p: Pricing | null | undefined): string {
  if (!p) return '(none)'
  return p.mode === 'RATE' ? `RATE ${p.rate}/${p.rateUnit}` : `PACK $${p.purchasePrice}`
}

async function main() {
  const items = await fetchCandidateItems()
  if (items.length === 0) {
    console.log('No COUNT items with an each-measure and a supplier offer — nothing to do.')
    return
  }

  const lines = await fetchApprovedLines(items.map((i) => i.id))
  const linesByItem = new Map<string, ScanLine[]>()
  for (const l of lines) {
    if (!l.matchedItemId) continue
    const arr = linesByItem.get(l.matchedItemId) ?? []
    arr.push(l)
    linesByItem.set(l.matchedItemId, arr)
  }

  const rewrites: RewriteRow[] = []
  const humans: PlanRow[] = []
  const skips: PlanRow[] = []

  for (const item of items) {
    const chainItem: ChainItem = asChainItem(item)
    const itemLines = linesByItem.get(item.id) ?? []
    for (const offer of item.supplierPrices) {
      const lastLine = lastLineFor(offer, itemLines)
      const plan = planOfferRepair({
        offer: { pricing: offer.pricing, lastPrice: Number(offer.lastPrice), isPrimary: offer.isPrimary },
        item: chainItem,
        lastLine: lastLine ? inputOf(lastLine) : null,
      })
      const prevPricing = offer.pricing && typeof offer.pricing === 'object' ? (offer.pricing as Pricing) : null
      const ppbBefore = offerPricePerBase({ packChain: offer.packChain, pricing: prevPricing ?? undefined }, item)
      const lineInfo = lastLine
        ? { invoice: lastLine.session.invoiceNumber, description: lastLine.rawDescription, date: lastLine.session.purchaseDate }
        : null

      const row: PlanRow = {
        itemId: item.id,
        itemName: item.itemName,
        offerId: offer.id,
        supplier: offer.supplierName,
        prevPricing,
        prevLastPrice: Number(offer.lastPrice),
        ppbBefore,
        line: lineInfo,
      }

      if (plan.action === 'rewrite') {
        rewrites.push({
          ...row,
          nextPricing: plan.pricing,
          nextLastPrice: plan.lastPrice,
          ppbAfter: offerPricePerBase({ packChain: offer.packChain, pricing: plan.pricing }, item),
        })
      } else if (plan.action === 'human') {
        row.reason = plan.reason
        humans.push(row)
      } else {
        row.reason = plan.reason
        skips.push(row)
      }
    }
  }

  console.log(`${items.length} COUNT item(s) with an each-measure + offer(s) considered · ${lines.length} approved lines loaded\n`)

  console.log('=== REWRITE ===')
  if (rewrites.length === 0) {
    console.log('  (none)')
  } else {
    console.table(
      rewrites.map((r) => ({
        item: r.itemName,
        supplier: r.supplier,
        'pricing (before)': fmtPricing(r.prevPricing),
        'pricing (after)': fmtPricing(r.nextPricing),
        '$/each (before)': r.ppbBefore.toFixed(4),
        '$/each (after)': r.ppbAfter.toFixed(4),
        line: r.line ? `${r.line.invoice ?? '?'} · ${r.line.description}` : '(none)',
      })),
    )
  }

  console.log('\n=== HUMAN (never auto-applied — primary offer) ===')
  if (humans.length === 0) {
    console.log('  (none)')
  } else {
    for (const r of humans) {
      console.log(`  ${r.itemName} · ${r.supplier} · ${fmtPricing(r.prevPricing)} — ${r.reason}`)
    }
  }

  console.log('\n=== SKIPPED ===')
  if (skips.length === 0) {
    console.log('  (none)')
  } else {
    for (const r of skips) {
      console.log(`  ${r.itemName} · ${r.supplier} · ${fmtPricing(r.prevPricing)} — ${r.reason}`)
    }
  }

  writeFileSync(
    `offer-repair-diff-${stamp}.json`,
    JSON.stringify({ rewrite: rewrites, human: humans, skipped: skips }, null, 2),
  )
  console.log(`\ndiff → offer-repair-diff-${stamp}.json`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply once a human has reviewed the diff.')
    return
  }

  if (rewrites.length === 0) {
    console.log('\nNothing to apply.')
    return
  }

  writeFileSync(
    `offer-repair-backup-${stamp}.json`,
    JSON.stringify(
      rewrites.map((r) => ({ id: r.offerId, prev: { pricing: r.prevPricing, lastPrice: r.prevLastPrice } })),
      null,
      2,
    ),
  )
  console.log(`backup → offer-repair-backup-${stamp}.json`)

  let applied = 0
  let refused = 0
  for (const r of rewrites) {
    const fresh = await prisma.inventorySupplierPrice.findUnique({
      where: { id: r.offerId },
      select: { pricing: true, lastPrice: true },
    })
    const freshPricing = fresh?.pricing && typeof fresh.pricing === 'object' ? (fresh.pricing as Pricing) : null
    const unchanged =
      fresh != null &&
      Number(fresh.lastPrice) === r.prevLastPrice &&
      JSON.stringify(freshPricing) === JSON.stringify(r.prevPricing)
    if (!unchanged) {
      refused++
      console.warn(
        `REFUSED — ${r.itemName} · ${r.supplier}: offer pricing changed since planning, not writing (was ${fmtPricing(r.prevPricing)}, now ${fmtPricing(freshPricing)})`,
      )
      continue
    }
    await prisma.inventorySupplierPrice.update({
      where: { id: r.offerId },
      data: { pricing: r.nextPricing as unknown as object, lastPrice: r.nextLastPrice },
    })
    applied++
  }
  console.log(`\napplied ${applied} · refused (changed since planning) ${refused}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
