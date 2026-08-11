/**
 * Build the interactive audit page from the audit JSON outputs.
 *
 * Reads (all produced by the audit scripts, into the same dir):
 *   inventory-price-audit.json   ← audit-inventory-prices.ts
 *   price-drift-report.json      ← audit-price-drift.ts
 *   offer-pack-mismatch.json     ← audit-offer-pack-mismatch.ts
 *   count-unit-collisions.json   ← audit-count-unit-collision.ts
 *
 * Writes docs/audits/index.html — a self-contained page (no external requests;
 * the Artifact CSP blocks them).
 *
 * Full regeneration from a live database:
 *   D=docs/audits
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-inventory-prices.ts $D
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-price-drift.ts $D
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-offer-pack-mismatch.ts $D
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-count-unit-collision.ts $D
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/build-audit-page.ts $D
 */
import fs from 'fs'
import path from 'path'

const DIR = path.resolve(process.cwd(), process.argv[2] || 'docs/audits')
const TEMPLATE = path.resolve(process.cwd(), 'scripts/templates/audit-page.template.html')

/** Benchmark vintage — update when the StatCan table is re-pulled. */
const BENCHMARK_MONTH = 'June 2026'

interface AuditRow {
  id: string; name: string; category: string; supplier: string | null
  primaryOfferSupplier: string | null; pricePerDisplay: number; displayUnit: string
  packChain: string; isPrepLinked: boolean; anomalies: string[]; lastInvoiceDate: string | null
}
interface DriftRow {
  id: string; name: string; category: string; supplier: string | null
  severity: string; verdict: string; price: number; unit: string
  benchLo: number | null; benchHi: number | null; benchSrc: string | null; benchNote: string | null
  ratio: number | null; reasons: string[]; packChain: string
}
interface OfferRow {
  name: string; category: string; supplier: string; offerFormat: string; offerPrice: number
  chainBaseTotal: number; offerBaseTotal: number; factor: number
  currentPerDisplay: string; impliedPerDisplay: string | null; impact: string
}
interface CollisionRow {
  name: string; collisionFactor: number; stockOnHandBase: number; baseUnit: string
  displayedCountQty: number; countUnit: string; chain: unknown
}

const read = <T>(f: string): T => {
  const p = path.join(DIR, f)
  if (!fs.existsSync(p)) throw new Error(`Missing ${p} — run the audit scripts into ${DIR} first.`)
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}

/** Round for payload size WITHOUT distorting the value. `ratio` must keep enough
 *  significant figures that 1/ratio stays accurate for very small ratios —
 *  rounding to 3 decimals turned a 106.5× drift into 111.1×. */
const sig = (n: number, digits = 6) => Number(n.toPrecision(digits))
const money = (n: number) => Number(n.toFixed(2))

function main() {
  const audit = read<AuditRow[]>('inventory-price-audit.json')
  const drift = read<DriftRow[]>('price-drift-report.json')
  const offers = read<OfferRow[]>('offer-pack-mismatch.json')
  const collisions = read<CollisionRow[]>('count-unit-collisions.json')

  const items = audit.map((r) => ({
    id: r.id, n: r.name, c: r.category, s: r.supplier || r.primaryOfferSupplier || null,
    p: money(r.pricePerDisplay), u: r.displayUnit, ch: r.packChain,
    prep: r.isPrepLinked, an: r.anomalies, inv: r.lastInvoiceDate,
  }))

  const findings = drift.map((f) => ({
    id: f.id, n: f.name, c: f.category, s: f.supplier, sev: f.severity, v: f.verdict,
    p: money(f.price), u: f.unit, lo: f.benchLo, hi: f.benchHi, src: f.benchSrc,
    note: f.benchNote, r: f.ratio == null ? null : sig(f.ratio),
    why: f.reasons, ch: f.packChain,
  }))

  const proven = offers.map((o) => ({
    n: o.name, c: o.category, s: o.supplier, fmt: o.offerFormat, op: o.offerPrice,
    cb: o.chainBaseTotal, ob: money(o.offerBaseTotal), f: sig(o.factor),
    now: o.currentPerDisplay, should: o.impliedPerDisplay, impact: o.impact,
  }))

  const coll = collisions.map((c) => ({
    n: c.name, f: c.collisionFactor, soh: c.stockOnHandBase, bu: c.baseUnit,
    shows: sig(Number(c.displayedCountQty), 4), cu: c.countUnit, ch: JSON.stringify(c.chain),
  }))

  const data = {
    // Date the database was actually read, stamped by audit-inventory-prices.ts.
    // Deliberately NOT a file mtime — copying the outputs would rewrite that and
    // silently mislabel the data.
    generated: read<{ generatedAt: string }>('audit-meta.json').generatedAt.slice(0, 10),
    benchmarkMonth: BENCHMARK_MONTH,
    totals: {
      items: items.length,
      purchased: items.filter((i) => !i.prep).length,
      prep: items.filter((i) => i.prep).length,
      flagged: findings.length,
      provenCost: proven.filter((p) => p.impact === 'COST_AND_STOCK').length,
      provenStock: proven.filter((p) => p.impact === 'STOCK_ONLY').length,
      zero: findings.filter((f) => f.v === 'NO PRICE').length,
      collisions: coll.length,
    },
    items, findings, proven, collisions: coll,
  }

  const tpl = fs.readFileSync(TEMPLATE, 'utf8')
  if (!tpl.includes('__DATA__')) throw new Error('Template is missing the __DATA__ placeholder')
  // JSON can contain `</script>` inside a string and would close the tag early.
  const json = JSON.stringify(data).replace(/<\//g, '<\\/')
  const html = tpl.replace('__DATA__', json)

  const out = path.join(DIR, 'index.html')
  fs.writeFileSync(out, html)
  console.log(`Wrote ${out} — ${(html.length / 1024).toFixed(0)} KB`)
  console.log(`  ${data.totals.items} items · ${data.totals.flagged} flagged · ` +
    `${data.totals.provenCost} cost-wrong · ${data.totals.collisions} count collisions`)
}

main()
