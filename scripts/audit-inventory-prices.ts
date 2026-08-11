/**
 * Inventory price audit — dumps every item's SPINE-derived price in a
 * human-comparable unit ($/kg, $/L, $/each) plus its pack format, so the values
 * can be compared against BC market / benchmark prices.
 *
 * Purely a READ. Writes nothing. Emits:
 *   - scratch/inventory-price-audit.json  (full rows)
 *   - scratch/inventory-price-audit.csv   (spreadsheet-friendly)
 *   - a structural-anomaly report to stdout (weird pack formats)
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/audit-inventory-prices.ts [outDir]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import {
  pricePerBaseUnit,
  asChainItem,
  basePerPurchase,
  levelBaseUnits,
  eachMeasureOf,
  type PackLink,
} from '../src/lib/item-model'
import { UNIT_FACTORS, CONTAINER_UNITS } from '../src/lib/uom'

const OUT_DIR = path.resolve(process.cwd(), process.argv[2] || 'scratch')

/** Display denominator per dimension: MASS → kg, VOLUME → L, COUNT → each. */
const DISPLAY: Record<string, { unit: string; factor: number }> = {
  MASS: { unit: 'kg', factor: 1000 },
  VOLUME: { unit: 'L', factor: 1000 },
  COUNT: { unit: 'each', factor: 1 },
}

function renderChain(chain: PackLink[], baseUnit: string): string {
  if (!chain?.length) return '(no chain)'
  const parts = chain.map((l, i) => {
    const inner = i === chain.length - 1 ? baseUnit : chain[i + 1].unit
    return `1 ${l.unit} = ${l.per} ${inner}`
  })
  return parts.join(' → ')
}

type Row = {
  id: string
  name: string
  category: string
  supplier: string | null
  dimension: string
  baseUnit: string
  countUnit: string
  packChain: string
  packChainRaw: PackLink[]
  basePerPurchase: number
  purchaseUnit: string | null
  pricingMode: string
  purchasePrice: number | null
  rate: number | null
  rateUnit: string | null
  ppbBase: number
  displayUnit: string
  pricePerDisplay: number
  packPrice: number | null
  eachMeasure: string | null
  densityGPerMl: number | null
  isStocked: boolean
  stockOnHand: number
  offers: number
  primaryOfferSupplier: string | null
  lastInvoiceDate: string | null
  lastInvoiceDesc: string | null
  lastInvoiceUnitPrice: number | null
  isPrepLinked: boolean
  anomalies: string[]
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    include: {
      supplier: { select: { name: true } },
      supplierPrices: { select: { isPrimary: true, supplier: { select: { name: true } } } },
      recipe: { select: { id: true, type: true } },
      invoiceLineItems: {
        orderBy: { invoice: { invoiceDate: 'desc' } },
        take: 1,
        select: {
          unitPrice: true,
          lineTotal: true,
          qtyPurchased: true,
          rawDescription: true,
          invoice: { select: { invoiceDate: true } },
        },
      },
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const rows: Row[] = []

  for (const it of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ci = asChainItem(it as any)
    const ppb = pricePerBaseUnit(ci)
    const disp = DISPLAY[ci.dimension] ?? DISPLAY.COUNT
    const chain = ci.packChain ?? []
    const bpp = basePerPurchase(chain)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pricing = ci.pricing as any
    const em = eachMeasureOf(it as { eachMeasureQty?: unknown; eachMeasureUnit?: string | null })

    const anomalies: string[] = []

    // ── structural / format sanity (mechanical, no market knowledge) ──────────
    if (!chain.length) anomalies.push('NO_PACK_CHAIN')
    if (chain.some((l) => !(Number(l?.per) > 0))) anomalies.push('CHAIN_LINK_PER_LE_0')
    if (chain.some((l) => !l?.unit || !String(l.unit).trim())) anomalies.push('CHAIN_LINK_NO_UNIT')
    if (ppb <= 0) anomalies.push('ZERO_PRICE')
    if (!Number.isFinite(ppb)) anomalies.push('NON_FINITE_PRICE')

    // A leaf whose unit is a *named measurement* unit (lb, oz, kg…) carries a
    // fixed factor. If the chain's `per` disagrees with that factor, the label
    // and the arithmetic contradict each other — e.g. `1 lb = 4535.92 g` (that
    // is 10 lb). Skip the case where the leaf unit IS the base unit; there the
    // token is just a pack level's name and carries no fixed factor claim.
    const leaf = chain[chain.length - 1]
    if (leaf && leaf.unit !== ci.baseUnit) {
      const f = UNIT_FACTORS[leaf.unit]
      const bf = UNIT_FACTORS[ci.baseUnit]
      if (f && bf && f.dim === bf.dim) {
        const expected = f.toBase / bf.toBase
        if (expected > 0 && Math.abs(Number(leaf.per) - expected) / expected > 0.02) {
          anomalies.push(
            `UNIT_LABEL_CONTRADICTION(chain says 1 ${leaf.unit} = ${leaf.per} ${ci.baseUnit}, but 1 ${leaf.unit} is ${expected} ${ci.baseUnit})`,
          )
        }
      }
    }

    // A chain level named with the SAME token as the base unit shadows the base
    // unit in `levelBaseUnits()`. When countUnit is that token, every count
    // screen divides the true on-hand quantity by the pack size.
    const lvAll = levelBaseUnits(chain)
    const cu = ci.countUnit ?? 'each'
    if (cu === ci.baseUnit && cu in lvAll && Math.abs(lvAll[cu] - 1) > 1e-9) {
      anomalies.push(`COUNT_UNIT_COLLISION(counting in '${cu}' resolves to ${lvAll[cu]} ${ci.baseUnit})`)
    }

    // duplicate unit names where the shadowed level actually carries a size
    const unitNames = chain.map((l) => l.unit)
    if (new Set(unitNames).size !== unitNames.length && chain.some((l) => Number(l.per) !== 1))
      anomalies.push('DUPLICATE_CHAIN_UNITS')

    // a purchase level that is a bare measurement unit with per=1 at the top is
    // usually an un-entered pack ("1 case = 1 g")
    if (chain.length === 1 && Number(chain[0].per) === 1 && ci.dimension !== 'COUNT')
      anomalies.push('FLAT_CHAIN_PER_1')

    // implausible pack magnitudes
    if (ci.dimension === 'MASS' && bpp > 0) {
      if (bpp > 200_000) anomalies.push(`HUGE_PACK(${(bpp / 1000).toFixed(0)} kg per purchase unit)`)
      if (bpp < 1) anomalies.push(`TINY_PACK(${bpp} g per purchase unit)`)
    }
    if (ci.dimension === 'VOLUME' && bpp > 0) {
      if (bpp > 200_000) anomalies.push(`HUGE_PACK(${(bpp / 1000).toFixed(0)} L per purchase unit)`)
      if (bpp < 1) anomalies.push(`TINY_PACK(${bpp} ml per purchase unit)`)
    }
    if (ci.dimension === 'COUNT' && bpp > 5000) anomalies.push(`HUGE_PACK(${bpp} each per purchase unit)`)

    // countUnit must be a chain level or a same-dimension measurement unit
    const lv = lvAll
    if (ci.countUnit && !(ci.countUnit in lv)) {
      const cf = UNIT_FACTORS[ci.countUnit]
      const bf = UNIT_FACTORS[ci.baseUnit]
      if (!cf || !bf || cf.dim !== bf.dim) anomalies.push(`COUNT_UNIT_ORPHAN(${ci.countUnit})`)
    }

    // container unit used as the base unit — always wrong (no fixed factor)
    if (CONTAINER_UNITS.has(ci.baseUnit)) anomalies.push(`CONTAINER_AS_BASE(${ci.baseUnit})`)

    // RATE pricing whose rateUnit is a container (rate must be per measurement unit)
    if (pricing?.mode === 'RATE' && CONTAINER_UNITS.has(pricing.rateUnit))
      anomalies.push(`RATE_ON_CONTAINER(${pricing.rateUnit})`)

    // COUNT item priced by the each with no weight bridge — can't cost weight recipes
    if (ci.dimension === 'COUNT' && !em) anomalies.push('COUNT_NO_EACH_MEASURE')

    const packPrice = pricing?.mode === 'PACK' ? Number(pricing.purchasePrice || 0) : null

    rows.push({
      id: it.id,
      name: it.itemName,
      category: it.category,
      supplier: it.supplier?.name ?? null,
      dimension: ci.dimension,
      baseUnit: ci.baseUnit,
      countUnit: ci.countUnit ?? 'each',
      packChain: renderChain(chain, ci.baseUnit),
      packChainRaw: chain,
      basePerPurchase: bpp,
      purchaseUnit: chain[0]?.unit ?? null,
      pricingMode: pricing?.mode ?? 'PACK',
      purchasePrice: packPrice,
      rate: pricing?.mode === 'RATE' ? Number(pricing.rate || 0) : null,
      rateUnit: pricing?.mode === 'RATE' ? pricing.rateUnit : null,
      ppbBase: ppb,
      displayUnit: disp.unit,
      pricePerDisplay: ppb * disp.factor,
      packPrice,
      eachMeasure: em ? `1 each = ${em.qty} ${em.unit}` : null,
      densityGPerMl: it.densityGPerMl != null ? Number(it.densityGPerMl) : null,
      isStocked: it.isStocked,
      stockOnHand: Number(it.stockOnHand || 0),
      offers: it.supplierPrices.length,
      primaryOfferSupplier: it.supplierPrices.find((o) => o.isPrimary)?.supplier?.name ?? null,
      lastInvoiceDate:
        it.invoiceLineItems[0]?.invoice?.invoiceDate?.toISOString().slice(0, 10) ?? null,
      lastInvoiceDesc: it.invoiceLineItems[0]?.rawDescription ?? null,
      lastInvoiceUnitPrice:
        it.invoiceLineItems[0]?.unitPrice != null ? Number(it.invoiceLineItems[0].unitPrice) : null,
      isPrepLinked: it.recipe?.type === 'PREP',
      anomalies,
    })
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'inventory-price-audit.json'), JSON.stringify(rows, null, 2))
  // Stamp when the database was actually read. File mtimes can't carry this —
  // copying the outputs anywhere rewrites them — and the page labels its data
  // with this date.
  fs.writeFileSync(
    path.join(OUT_DIR, 'audit-meta.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), itemCount: rows.length }, null, 2),
  )

  const cols: (keyof Row)[] = [
    'id', 'name', 'category', 'supplier', 'dimension', 'baseUnit', 'countUnit',
    'purchaseUnit', 'packChain', 'basePerPurchase', 'pricingMode', 'purchasePrice',
    'rate', 'rateUnit', 'pricePerDisplay', 'displayUnit', 'eachMeasure',
    'isStocked', 'isPrepLinked', 'offers', 'primaryOfferSupplier',
    'lastInvoiceDate', 'anomalies',
  ]
  const esc = (v: unknown) => {
    const s = Array.isArray(v) ? v.join('; ') : v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
  fs.writeFileSync(path.join(OUT_DIR, 'inventory-price-audit.csv'), csv)

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`Items (active): ${rows.length}`)
  const byDim = rows.reduce<Record<string, number>>((a, r) => ((a[r.dimension] = (a[r.dimension] || 0) + 1), a), {})
  console.log('By dimension:', byDim)
  console.log(`Prep-linked (cost derived from a recipe, not a market price): ${rows.filter((r) => r.isPrepLinked).length}`)
  console.log(`Non-stocked (recipe-only utility): ${rows.filter((r) => !r.isStocked).length}`)

  const flagged = rows.filter((r) => r.anomalies.length)
  console.log(`\n── STRUCTURAL / FORMAT ANOMALIES: ${flagged.length} items ──`)
  const counts = flagged
    .flatMap((r) => r.anomalies.map((a) => a.split('(')[0]))
    .reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] || 0) + 1), a), {})
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)

  console.log(`\nWrote ${path.join(OUT_DIR, 'inventory-price-audit.json')} and .csv`)
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
