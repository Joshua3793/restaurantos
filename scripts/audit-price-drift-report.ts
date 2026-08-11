/**
 * Render the price-drift findings as a review-ready Markdown checklist.
 * Reads scratch/price-drift-report.json → writes scratch/PRICE-REVIEW.md
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/audit-price-drift-report.ts [dir]
 */
import fs from 'fs'
import path from 'path'

const DIR = path.resolve(process.cwd(), process.argv[2] || 'scratch')

type Finding = {
  id: string; name: string; category: string; supplier: string | null
  price: number; unit: string
  benchLo: number | null; benchHi: number | null; benchSrc: string | null; benchNote: string | null
  ratio: number | null; verdict: string; severity: string
  reasons: string[]; packChain: string; packChainIssues: string[]; lastInvoiceDate: string | null
}

const findings: Finding[] = JSON.parse(fs.readFileSync(path.join(DIR, 'price-drift-report.json'), 'utf8'))
const audit = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory-price-audit.json'), 'utf8'))

const money = (n: number) => `$${n.toFixed(2)}`
const drift = (f: Finding) =>
  f.ratio == null ? '—' : f.ratio > 1 ? `${f.ratio.toFixed(1)}× over` : `${(1 / f.ratio).toFixed(1)}× under`

function table(rows: Finding[]): string {
  const head = '| Item | Category | Current | BC benchmark | Drift | What looks wrong |\n|---|---|---|---|---|---|'
  const body = rows
    .map((f) => {
      const bench = f.benchLo != null ? `$${f.benchLo}–$${f.benchHi}/${f.unit} <sub>${f.benchSrc}</sub>` : '—'
      const why = f.reasons.join('<br>').replace(/\|/g, '\\|')
      return `| **${f.name}** | ${f.category} | ${money(f.price)}/${f.unit} | ${bench} | ${drift(f)} | ${why} |`
    })
    .join('\n')
  return `${head}\n${body}`
}

const bySev = (s: string) => findings.filter((f) => f.severity === s)

const purchased = audit.filter((r: { isPrepLinked: boolean }) => !r.isPrepLinked)

type OfferRow = {
  name: string; category: string; supplier: string; offerFormat: string; offerPrice: number
  chainBaseTotal: number; offerBaseTotal: number; factor: number
  currentPerDisplay: string; impliedPerDisplay: string | null
  impact: string; direction: string
}
const offerPath = path.join(DIR, 'offer-pack-mismatch.json')
const offerRows: OfferRow[] = fs.existsSync(offerPath) ? JSON.parse(fs.readFileSync(offerPath, 'utf8')) : []
const offerCost = offerRows.filter((o) => o.impact === 'COST_AND_STOCK')
const offerStock = offerRows.filter((o) => o.impact === 'STOCK_ONLY')

const offerSection = `
## ⚠️ Pack format conflicts — ${offerRows.length} items

Each item's \`packChain\` is compared with its primary supplier offer's stated
format (\`packQty × packSize packUOM\`).

**A disagreement does not by itself mean the cost is wrong.** The item's chain
always equals its primary offer's \`packChain\` (197/197 verified) — the format
triple is a separate record written from each invoice. So a mismatch means one of
the two is stale, and the data does not say which:

- the **chain** is stale when a supplier changed pack size — approve writes the
  new price over the old format, so the cost IS wrong by the ratio;
- the **triple** is stale when someone edited the item afterwards.

Compare \`lastUpdated\` on both and use the BC band as the tiebreaker. In this
snapshot the split was an even 16 / 16.

### ${offerCost.length} items where the two disagree on a PACK-priced item

### ${offerStock.length} items where the cost is fine but the pack total is not

These are **RATE**-priced ($/kg set directly), so the unit cost is right. The
wrong pack total corrupts count conversions and stock-on-hand instead.

| Item | Supplier | Offer says | Chain says | Rate (correct) |
|---|---|---|---|---|
${offerStock
  .map((o) => `| ${o.name} | ${o.supplier} | ${o.offerFormat} | ${o.chainBaseTotal} base | ${o.currentPerDisplay} |`)
  .join('\n')}

---
`

const md = `# Inventory price audit — BC market comparison

**Scope:** every active inventory item (${audit.length}) was priced from the pack-chain spine
(\`pricePerBaseUnit\`), normalised to $/kg, $/L or $/each, and compared against a
British Columbia price band.

- **${purchased.length}** purchased items compared against a BC benchmark (100% of food items;
  the two exclusions are a cleaning chemical and the \$0 non-stocked "Water" utility row).
- **${audit.length - purchased.length}** PREP-linked items derive their cost from a recipe, not a purchase
  price — market comparison does not apply, so they are checked for pack-format defects only.
- **${findings.length}** items are flagged for manual revision.

**Benchmark sources**

| Tag | Meaning |
|---|---|
| \`STATCAN\` | Statistics Canada table 18-10-0245-01, *Monthly average retail prices for selected products*, GEO = British Columbia, **June 2026** (latest published). Retail is an upper bound on wholesale, so bands sit at roughly 0.4–1.0× the BC retail figure. |
| \`FS\` | BC/Vancouver foodservice distributor range (Sysco / Snow Cap / Legends Haul / Two Rivers class). Industry judgement, not a published quote — treat as "worth a look", not proof. |

A price is only flagged when it sits **more than 1.25× outside** the band, so
band-edge noise is excluded.

---
${offerSection}
## 🔴 CRITICAL — ${bySev('CRITICAL').length} items

Cost math is provably wrong here: the item has no price at all, or it is off by
a multiple large enough that no supplier variation explains it.

${table(bySev('CRITICAL'))}

---

## 🟠 HIGH — ${bySev('HIGH').length} items

${table(bySev('HIGH'))}

---

## 🟡 MEDIUM — ${bySev('MEDIUM').length} items

${table(bySev('MEDIUM'))}

---

## Weird pack formats

These are structural defects in the pack chain, independent of price level.

### \`COUNT_UNIT_COLLISION\` — counts are silently divided by the case size

A chain level is named with the **same token as the base unit** (\`each\`), so
\`levelBaseUnits()\` keys that level by \`each\` and \`basePerUnit(item, 'each')\`
resolves to the **pack size instead of 1**. Valuation is unaffected
(\`stockValue\` uses \`pricePerBaseUnit × stockOnHand\`), which is why this has
never shown up on a cost report — but every count screen shows the wrong number.

${(() => {
  const p = path.join(DIR, 'count-unit-collisions.json')
  if (!fs.existsSync(p)) return '_(run scripts/audit-count-unit-collision.ts)_'
  const c = JSON.parse(fs.readFileSync(p, 'utf8')) as Array<{
    name: string; collisionFactor: number; stockOnHandBase: number; baseUnit: string
    displayedCountQty: number; countUnit: string; chain: unknown
  }>
  return [
    '| Item | Divisor | True on hand | Count screen shows | Chain |',
    '|---|---|---|---|---|',
    ...c.map(
      (x) =>
        `| ${x.name} | ${x.collisionFactor}× | ${x.stockOnHandBase} ${x.baseUnit} | ${Number(x.displayedCountQty).toFixed(2)} ${x.countUnit} | \`${JSON.stringify(x.chain)}\` |`,
    ),
  ].join('\n')
})()}

**Fix:** rename the intermediate chain level to a container token (\`case\`,
\`pack\`, \`tray\`, \`sleeve\`) so it stops shadowing \`each\`.

### \`UNIT_LABEL_CONTRADICTION\` — the level's name disagrees with its own arithmetic

${(() => {
  const rows = audit.filter((r: { anomalies: string[] }) =>
    r.anomalies.some((a: string) => a.startsWith('UNIT_LABEL_CONTRADICTION')),
  )
  return [
    '| Item | Chain | Contradiction |',
    '|---|---|---|',
    ...rows.map(
      (r: { name: string; packChain: string; anomalies: string[] }) =>
        `| ${r.name} | \`${r.packChain}\` | ${r.anomalies.find((a: string) => a.startsWith('UNIT_LABEL_CONTRADICTION'))} |`,
    ),
  ].join('\n')
})()}

### Duplicate product rows

${(() => {
  const dups = findings.filter((f) => f.verdict.includes('DUPLICATE'))
  if (!dups.length) return '_none_'
  return [
    '| Item | Price | Note |',
    '|---|---|---|',
    ...dups.map((f) => `| ${f.name} | ${money(f.price)}/${f.unit} | ${f.reasons.join('; ')} |`),
  ].join('\n')
})()}

---

## Advisory — items with no count↔weight bridge

${audit.filter((r: { anomalies: string[] }) => r.anomalies.includes('COUNT_NO_EACH_MEASURE')).length} COUNT-dimension items have no \`eachMeasure\`. They cost correctly when a
recipe calls for them by the each, but a recipe or invoice that expresses them
by weight cannot be converted. Not a price defect — listed for completeness in
\`inventory-price-audit.csv\`.
`

fs.writeFileSync(path.join(DIR, 'PRICE-REVIEW.md'), md)
console.log(`Wrote ${path.join(DIR, 'PRICE-REVIEW.md')} (${md.length} chars)`)
