/**
 * Compare every inventory item's spine price against a BC market benchmark band
 * and emit a review list. READ-ONLY — writes no database rows.
 *
 * Input:  scratch/inventory-price-audit.json  (from audit-inventory-prices.ts)
 * Output: scratch/price-drift-report.json / .csv / .md
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/audit-price-drift.ts [dir]
 */
import fs from 'fs'
import path from 'path'
import { benchmarkFor, type Benchmark } from './market-benchmarks-bc'

const DIR = path.resolve(process.cwd(), process.argv[2] || 'scratch')

type AuditRow = {
  id: string; name: string; category: string; supplier: string | null
  dimension: string; baseUnit: string; countUnit: string
  packChain: string; basePerPurchase: number; purchaseUnit: string | null
  pricingMode: string; purchasePrice: number | null; rate: number | null; rateUnit: string | null
  pricePerDisplay: number; displayUnit: string
  eachMeasure: string | null; isStocked: boolean; isPrepLinked: boolean
  offers: number; primaryOfferSupplier: string | null
  lastInvoiceDate: string | null; anomalies: string[]
}

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

type Finding = {
  id: string; name: string; category: string; supplier: string | null
  price: number; unit: string
  benchLo: number | null; benchHi: number | null; benchSrc: string | null; benchNote: string | null
  ratio: number | null          // >1 = above the top of the band, <1 = below the bottom
  verdict: string
  severity: Severity
  reasons: string[]
  packChain: string
  packChainIssues: string[]
  lastInvoiceDate: string | null
}

const SEV_ORDER: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

/** Structural anomalies that make the PACK FORMAT itself untrustworthy. A price
 *  derived from a broken chain is not comparable to anything. */
const FORMAT_CODES = new Set([
  'NO_PACK_CHAIN', 'CHAIN_LINK_PER_LE_0', 'CHAIN_LINK_NO_UNIT', 'UNIT_LABEL_CONTRADICTION',
  'COUNT_UNIT_COLLISION', 'COUNT_UNIT_ORPHAN', 'CONTAINER_AS_BASE', 'RATE_ON_CONTAINER',
  'HUGE_PACK', 'TINY_PACK', 'FLAT_CHAIN_PER_1', 'NON_FINITE_PRICE',
])

function main() {
  const rows: AuditRow[] = JSON.parse(fs.readFileSync(path.join(DIR, 'inventory-price-audit.json'), 'utf8'))

  // Duplicate-name detection: two rows for the same product whose prices differ
  // are a review item regardless of where they sit against the market.
  const byNorm = new Map<string, AuditRow[]>()
  for (const r of rows) {
    if (r.isPrepLinked) continue
    const k = r.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const list = byNorm.get(k) ?? []
    list.push(r)
    byNorm.set(k, list)
  }
  const dupNames = new Set<string>()
  for (const [, list] of byNorm) if (list.length > 1) list.forEach((r) => dupNames.add(r.id))

  const findings: Finding[] = []

  for (const r of rows) {
    const reasons: string[] = []
    const fmtIssues = r.anomalies.filter((a) => FORMAT_CODES.has(a.split('(')[0]))
    let severity: Severity | null = null
    let verdict = ''
    let bench: Benchmark | null = null
    let ratio: number | null = null

    // 1. Zero price — nothing downstream of this item can cost correctly.
    if (r.pricePerDisplay <= 0) {
      // A non-stocked utility item (tap water) is legitimately $0.
      if (!r.isStocked) continue
      reasons.push('price is $0 — every recipe using this item under-costs silently')
      severity = 'CRITICAL'
      verdict = 'NO PRICE'
    }

    // 2. PREP-linked items derive their cost from a recipe, not a market price —
    //    a market comparison is meaningless. Only report a broken format.
    if (r.isPrepLinked) {
      if (!fmtIssues.length) continue
      findings.push({
        id: r.id, name: r.name, category: r.category, supplier: r.supplier,
        price: r.pricePerDisplay, unit: r.displayUnit,
        benchLo: null, benchHi: null, benchSrc: null, benchNote: 'PREP-linked — cost comes from the recipe, not a purchase price',
        ratio: null, verdict: 'FORMAT', severity: 'MEDIUM',
        reasons: ['pack format is malformed on a recipe-linked item'],
        packChain: r.packChain, packChainIssues: fmtIssues, lastInvoiceDate: r.lastInvoiceDate,
      })
      continue
    }

    // 3. Market comparison. CHM is cleaning chemical, not food — no food-price
    //    benchmark applies, so it is excluded rather than reported unvalidated.
    if (severity !== 'CRITICAL' && r.category !== 'CHM') {
      bench = benchmarkFor(r.name)
      // kg and L are interchangeable for water-like goods (canned tomato, juice,
      // brine) at density ≈ 1 g/ml — compare numerically and say so.
      const densityBridge =
        bench != null &&
        bench.unit !== r.displayUnit &&
        ((bench.unit === 'kg' && r.displayUnit === 'L') || (bench.unit === 'L' && r.displayUnit === 'kg'))
      if (densityBridge) reasons.push('compared across kg/L assuming density ≈ 1 g/ml')

      if (!bench) {
        reasons.push('no BC benchmark matched this product class — price could not be validated')
        severity = 'LOW'
        verdict = 'NO BENCHMARK'
      } else if (bench.unit !== r.displayUnit && !densityBridge) {
        // The item is stored in a different dimension than the benchmark is
        // expressed in (e.g. a bread item stored as COUNT vs a $/kg benchmark).
        reasons.push(
          `item is priced per ${r.displayUnit} but the BC benchmark for this product is per ${bench.unit} — dimension mismatch, likely the wrong dimension on the item`,
        )
        severity = 'HIGH'
        verdict = 'DIMENSION MISMATCH'
      } else {
        const p = r.pricePerDisplay
        // A price just outside a judgement-set band is not evidence of drift.
        // Only depart from the band by ≥ TOL before calling it a finding.
        const TOL = 1.25
        if (p > bench.hi * TOL) {
          ratio = p / bench.hi
          reasons.push(
            `$${p.toFixed(2)}/${r.displayUnit} is ${ratio.toFixed(1)}× the top of the BC band ($${bench.lo}–$${bench.hi}/${bench.unit})`,
          )
          verdict = 'ABOVE MARKET'
          severity = ratio >= 4 ? 'CRITICAL' : ratio >= 2 ? 'HIGH' : 'MEDIUM'
        } else if (p < bench.lo / TOL) {
          ratio = p / bench.lo
          reasons.push(
            `$${p.toFixed(2)}/${r.displayUnit} is ${(1 / ratio).toFixed(1)}× BELOW the bottom of the BC band ($${bench.lo}–$${bench.hi}/${bench.unit}) — under-costing risk`,
          )
          verdict = 'BELOW MARKET'
          severity = 1 / ratio >= 4 ? 'CRITICAL' : 1 / ratio >= 2 ? 'HIGH' : 'MEDIUM'
        }
      }
    }

    // 4. Broken pack format — escalates whatever we already have.
    if (fmtIssues.length) {
      reasons.push(`pack format is malformed: ${fmtIssues.join(', ')}`)
      if (!severity || SEV_ORDER[severity] > SEV_ORDER.HIGH) severity = 'HIGH'
      if (!verdict || verdict === 'NO BENCHMARK') verdict = 'FORMAT'
      else verdict += ' + FORMAT'
    }

    // 5. Duplicate product rows.
    if (dupNames.has(r.id)) {
      reasons.push('duplicate item — another active row carries the same product name')
      if (!severity || SEV_ORDER[severity] > SEV_ORDER.MEDIUM) severity = 'MEDIUM'
      verdict = verdict ? `${verdict} + DUPLICATE` : 'DUPLICATE'
    }

    if (!severity) continue

    findings.push({
      id: r.id, name: r.name, category: r.category, supplier: r.supplier,
      price: r.pricePerDisplay, unit: r.displayUnit,
      benchLo: bench?.lo ?? null, benchHi: bench?.hi ?? null,
      benchSrc: bench?.src ?? null, benchNote: bench?.note ?? null,
      ratio, verdict, severity, reasons,
      packChain: r.packChain, packChainIssues: fmtIssues, lastInvoiceDate: r.lastInvoiceDate,
    })
  }

  findings.sort((a, b) => {
    const s = SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
    if (s) return s
    const ar = a.ratio == null ? 0 : Math.max(a.ratio, 1 / a.ratio)
    const br = b.ratio == null ? 0 : Math.max(b.ratio, 1 / b.ratio)
    return br - ar
  })

  fs.writeFileSync(path.join(DIR, 'price-drift-report.json'), JSON.stringify(findings, null, 2))

  const cols = ['severity', 'verdict', 'category', 'name', 'price', 'unit', 'benchLo', 'benchHi', 'benchSrc', 'ratio', 'packChain', 'supplier', 'lastInvoiceDate', 'reasons'] as const
  const esc = (v: unknown) => {
    const s = Array.isArray(v) ? v.join(' | ') : v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  fs.writeFileSync(
    path.join(DIR, 'price-drift-report.csv'),
    [cols.join(','), ...findings.map((f) => cols.map((c) => esc((f as unknown as Record<string, unknown>)[c])).join(','))].join('\n'),
  )

  // ── summary ───────────────────────────────────────────────────────────────
  const purchased = rows.filter((r) => !r.isPrepLinked)
  const compared = purchased.filter((r) => benchmarkFor(r.name))
  console.log(`Items examined:            ${rows.length}`)
  console.log(`  purchased (comparable):  ${purchased.length}`)
  console.log(`  PREP-linked (recipe cost): ${rows.length - purchased.length}`)
  console.log(`  matched to a BC benchmark: ${compared.length} / ${purchased.length}`)
  console.log(`\nFlagged for manual review: ${findings.length}`)
  for (const s of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as Severity[]) {
    const n = findings.filter((f) => f.severity === s).length
    if (n) console.log(`  ${s.padEnd(9)} ${n}`)
  }
  const byVerdict = findings.reduce<Record<string, number>>((a, f) => ((a[f.verdict] = (a[f.verdict] || 0) + 1), a), {})
  console.log('\nBy verdict:')
  for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)

  console.log(`\nWrote ${path.join(DIR, 'price-drift-report.json')} / .csv`)
}

main()
