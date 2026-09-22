/**
 * READ-ONLY audit: products whose pricing shape contradicts itself, and products
 * CREATED from a by-weight invoice line that are still counted as units.
 *
 *   npx tsx scripts/audit-create-new-shape.ts            # prints + writes the JSON
 *   npx tsx scripts/audit-create-new-shape.ts --all      # also list healthy CREATE_NEW by-weight items
 *
 * This script writes NOTHING to the database. It has no --apply and no update
 * call anywhere in it.
 *
 * TWO findings, because one test cannot see both halves of the bug:
 *
 *   A. SHAPE — `isSelfContradictory` (src/lib/invoice/create-new-repair.ts) reads
 *      an item's four pricing fields and names what disagrees: a COUNT item with
 *      a lb chain link, a $/each rate over a measured pack, a measure link that
 *      says 1 lb = 1 base unit. Kennebec, Salami and Kohlrabi are here.
 *
 *   B. EVIDENCE — a CANDIDATE list, not a verdict. An item born from a
 *      `CREATE_NEW` line that was billed by weight (`isByWeightLine`,
 *      src/lib/invoice/create-new-seed.ts) and is TODAY a COUNT item with no
 *      each-measure bridge. Its four fields are perfectly ordinary — Fennel O/S
 *      is `COUNT / [{each:1}] / RATE $/each`, which is what half the catalogue
 *      looks like — so only its birth certificate gives it away. But
 *      `isByWeightLine` also matches a per-CASE line that merely carries a
 *      billed-weight column, which is a legitimate catch-weight purchase of a
 *      genuinely countable item. Section B therefore prints the line's
 *      `pricingMode`, `rawUnit`, `rateUOM` and `totalQtyUOM` so a human can tell
 *      the two apart, and nothing here is repaired without `--item`.
 *
 * Per finding it also counts what has already been frozen through the shape —
 * recipe ingredients, count lines and approved receipts — which is the size of
 * the repair, not a detail.
 */
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/lib/prisma'
import { PRICING_SELECT } from '../src/lib/item-model'
import { isSelfContradictory } from '../src/lib/invoice/create-new-repair'
import { isByWeightLine, lineMeasureUnit } from '../src/lib/invoice/create-new-seed'

const argv = process.argv.slice(2)
const KNOWN_FLAGS = new Set(['--all'])
const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a))
if (unknown.length > 0) {
  console.error(`Unknown flag(s): ${unknown.join(', ')}`)
  console.error('Usage: audit-create-new-shape.ts [--all]')
  process.exit(2)
}
const SHOW_ALL = argv.includes('--all')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

async function fetchItems() {
  return prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, stockOnHand: true, ...PRICING_SELECT,
      _count: { select: { recipeIngredients: true, countLines: true, invoiceMatches: true } },
    },
    orderBy: { itemName: 'asc' },
  })
}
type ItemRow = Awaited<ReturnType<typeof fetchItems>>[number]

/** Every approved line that CREATED a product — the birth certificates. */
async function fetchCreateNewLines() {
  return prisma.invoiceScanItem.findMany({
    where: { approved: true, action: 'CREATE_NEW', matchedItemId: { not: null }, session: { status: 'APPROVED' } },
    select: {
      id: true, matchedItemId: true, rawDescription: true,
      rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true,
      rate: true, rateUOM: true, rawUnitPrice: true, rawLineTotal: true, newPrice: true,
      pricingMode: true, invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      receivedQtyBase: true,
      session: { select: { invoiceNumber: true, supplierName: true, purchaseDate: true } },
    },
  })
}
type ScanLine = Awaited<ReturnType<typeof fetchCreateNewLines>>[number]

const seedLineOf = (l: ScanLine) => ({
  pricingMode: l.pricingMode, rateUOM: l.rateUOM, totalQtyUOM: l.totalQtyUOM, rawUnit: l.rawUnit,
  rate: l.rate, rawUnitPrice: l.rawUnitPrice, newPrice: l.newPrice,
  invoicePackQty: l.invoicePackQty, invoicePackSize: l.invoicePackSize, invoicePackUOM: l.invoicePackUOM,
})

interface Finding {
  finding: 'SHAPE' | 'EVIDENCE'
  itemId: string
  itemName: string
  dimension: string
  baseUnit: string
  packChain: unknown
  pricing: unknown
  countUnit: string | null
  eachMeasure: string | null
  stockOnHand: number
  reasons: string[]
  suggestedMeasure: string | null
  frozen: { recipeIngredients: number; countLines: number; receipts: number }
  birthLine: {
    id: string; description: string; invoice: string | null; supplier: string | null; qty: string; measure: string | null
    // The four fields `isByWeightLine` actually reads. Printed in section B so a
    // human can tell a genuine per-lb line from a per-case line that merely
    // carries a billed-weight column.
    pricingMode: string | null; rawUnit: string | null; rateUOM: string | null; totalQtyUOM: string | null
  } | null
}

const eachMeasureLabel = (i: ItemRow): string | null =>
  i.eachMeasureQty != null && i.eachMeasureUnit ? `${Number(i.eachMeasureQty)} ${i.eachMeasureUnit}` : null

function findingOf(item: ItemRow, kind: Finding['finding'], reasons: string[], line: ScanLine | null): Finding {
  return {
    finding: kind,
    itemId: item.id,
    itemName: item.itemName,
    dimension: item.dimension,
    baseUnit: item.baseUnit,
    packChain: item.packChain,
    pricing: item.pricing,
    countUnit: item.countUnit,
    eachMeasure: eachMeasureLabel(item),
    stockOnHand: Number(item.stockOnHand),
    reasons,
    suggestedMeasure: line ? lineMeasureUnit(seedLineOf(line)) : null,
    frozen: {
      recipeIngredients: item._count.recipeIngredients,
      countLines: item._count.countLines,
      receipts: item._count.invoiceMatches,
    },
    birthLine: line
      ? {
          id: line.id,
          description: line.rawDescription,
          invoice: line.session.invoiceNumber,
          supplier: line.session.supplierName,
          qty: `${line.rawQty?.toString() ?? '?'} ${line.rawUnit ?? ''}`.trim(),
          measure: lineMeasureUnit(seedLineOf(line)),
          pricingMode: line.pricingMode,
          rawUnit: line.rawUnit,
          rateUOM: line.rateUOM,
          totalQtyUOM: line.totalQtyUOM,
        }
      : null,
  }
}

async function main() {
  const [items, createLines] = await Promise.all([fetchItems(), fetchCreateNewLines()])

  // The most recent CREATE_NEW line per item — its birth certificate.
  const birthByItem = new Map<string, ScanLine>()
  for (const l of createLines) {
    if (!l.matchedItemId) continue
    const prev = birthByItem.get(l.matchedItemId)
    const da = l.session.purchaseDate?.getTime() ?? 0
    const db = prev?.session.purchaseDate?.getTime() ?? -1
    if (!prev || da > db) birthByItem.set(l.matchedItemId, l)
  }

  const shape: Finding[] = []
  const evidence: Finding[] = []
  const healthy: Finding[] = []

  for (const item of items) {
    const reasons = isSelfContradictory(item)
    const birth = birthByItem.get(item.id) ?? null
    if (reasons.length > 0) {
      shape.push(findingOf(item, 'SHAPE', reasons, birth))
      continue
    }
    if (!birth || !isByWeightLine(seedLineOf(birth))) continue
    const bornByWeight = findingOf(item, 'EVIDENCE', ['created from a by-weight line but counted as units'], birth)
    // A COUNT item with an each-measure CAN honestly take a weight (the bridge
    // exists); one without cannot, and every receipt on it was frozen as a count
    // of units wearing a pound's number.
    if (item.dimension === 'COUNT' && eachMeasureLabel(item) === null) evidence.push(bornByWeight)
    else healthy.push({ ...bornByWeight, reasons: [] })
  }

  console.log(`${items.length} active item(s) · ${createLines.length} approved CREATE_NEW line(s)\n`)

  const table = (rows: Finding[]) =>
    console.table(rows.map((f) => ({
      item: f.itemName,
      dim: `${f.dimension}/${f.baseUnit}`,
      chain: JSON.stringify(f.packChain),
      pricing: JSON.stringify(f.pricing),
      count: f.countUnit,
      reasons: f.reasons.join(' · '),
      measure: f.suggestedMeasure ?? '(none)',
      'recipes/counts/receipts': `${f.frozen.recipeIngredients}/${f.frozen.countLines}/${f.frozen.receipts}`,
      id: f.itemId,
    })))

  console.log('=== A. SELF-CONTRADICTORY SHAPE ===')
  if (shape.length === 0) console.log('  (none)')
  else table(shape)

  // The birth-line columns `isByWeightLine` reads, so section B can be judged
  // rather than trusted.
  const evidenceTable = (rows: Finding[]) =>
    console.table(rows.map((f) => ({
      item: f.itemName,
      dim: `${f.dimension}/${f.baseUnit}`,
      chain: JSON.stringify(f.packChain),
      pricing: JSON.stringify(f.pricing),
      count: f.countUnit,
      'birth line': f.birthLine?.description ?? '(none)',
      'birth qty': f.birthLine?.qty ?? '?',
      pricingMode: f.birthLine?.pricingMode ?? '(null)',
      rawUnit: f.birthLine?.rawUnit ?? '(null)',
      rateUOM: f.birthLine?.rateUOM ?? '(null)',
      totalQtyUOM: f.birthLine?.totalQtyUOM ?? '(null)',
      measure: f.suggestedMeasure ?? '(none)',
      'recipes/counts/receipts': `${f.frozen.recipeIngredients}/${f.frozen.countLines}/${f.frozen.receipts}`,
      id: f.itemId,
    })))

  console.log('\n=== B. CANDIDATES: BORN FROM A BY-WEIGHT LINE, STILL COUNTED AS UNITS (no each-measure) ===')
  console.log('    CANDIDATES, not findings. `isByWeightLine` also matches a per-CASE line that merely carries a')
  console.log('    billed-weight column — a legitimate catch-weight purchase of a countable item. Judge each row')
  console.log('    from its birth line below (a true finding is priced per lb/kg: pricingMode per_weight, or a')
  console.log('    rateUOM/rawUnit that IS the weight unit). Nothing here is repaired without an explicit --item.')
  if (evidence.length === 0) console.log('  (none)')
  else evidenceTable(evidence)

  if (SHOW_ALL) {
    console.log('\n=== C. BORN FROM A BY-WEIGHT LINE, SHAPE OK (informational) ===')
    if (healthy.length === 0) console.log('  (none)')
    else table(healthy)
  }

  // The paste-ready command is SECTION A ONLY. Section B is a candidate list —
  // half of it is legitimately counted stock (ENGLISH MUFFIN GF 4PK) — and a
  // runnable line containing those ids is an invitation to repair a product that
  // was never broken. B's ids are printed to be read, one per line, never in a
  // command.
  console.log(`\n${shape.length} item(s) with a self-contradictory shape: ${shape.map((f) => f.itemName).join(', ') || '(none)'}`)
  if (shape.length > 0) {
    console.log('\nRepair dry run for section A:')
    console.log(`  npx tsx scripts/repair-create-new-shape.ts ${shape.map((f) => `--item ${f.itemId}`).join(' ')}`)
  }
  if (evidence.length > 0) {
    console.log(`\nCANDIDATES — decide per item (section B, ${evidence.length}). Judge each from its birth line above,`)
    console.log('then add the ones you have decided to repair to the command yourself:')
    for (const f of evidence) console.log(`  ${f.itemId}  ${f.itemName}`)
  }

  const file = `create-new-shape-audit-${stamp}.json`
  writeFileSync(file, JSON.stringify({ stamp, itemsScanned: items.length, shape, evidence, healthy }, null, 2))
  console.log(`\naudit → ${file}  (read-only: this script wrote nothing to the database)`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
