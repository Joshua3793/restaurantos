/**
 * READ-ONLY audit of what approved invoice lines actually credited to theoretical
 * stock, versus what the invoice itself says was received.
 *
 * Receiving math lives in `lineReceivedBaseUnits` (src/lib/invoice/line-qty.ts),
 * mirrored by `buildPurchaseMap` (src/lib/count-expected.ts). That function takes
 * one of three paths, and this script replicates the path selection so a finding
 * is only raised against the branch the line ACTUALLY used:
 *
 *   rate  — RATE-priced item + a known billed unit → convertQty(billedQty → base)
 *   pack  — otherwise, expand the INVOICE's own pack: qty × packQty × packSize
 *   chain — no pack on the line → qty × basePerUnit(item's top container)
 *
 * Findings:
 *   A) NO_QUANTITY    rawQty null/0 → returns 0 before the rate branch. Credits nothing.
 *   B) DIMENSION_GAP  the unit used ON THE TAKEN PATH is a different dimension from
 *                     the item's base unit. convertQty passes the number through
 *                     UNCHANGED on a dimension mismatch (uom.ts:249) — so the
 *                     credited figure is a raw number wearing the wrong unit.
 *                     Costing uses convertQtyBridged (density / each-measure), so
 *                     cost and stock disagree on the same line.
 *   C) CHAIN_GAP      base units credited are fine (the pack path uses the invoice's
 *                     own format), but the ITEM's packChain claims a container holds
 *                     a very different amount — which corrupts $/base-unit and makes
 *                     the count-UOM readout absurd ("2200 cs" for 2 cases).
 *   D) UNKNOWN_UOM    a unit token outside the backbone; conversion silently ×1.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/audit-invoice-receipts.ts
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, basePerUnit, dimensionOf, eachMeasureOf, densityOf } from '@/lib/item-model'
import { convertQty, convertQtyBridged, isKnownUnit, UNIT_FACTORS, canonicalUom } from '@/lib/uom'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
import { lineReceivedBaseUnits } from '@/lib/invoice/line-qty'

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : 0
}
const money = (v: number) => `$${v.toFixed(2)}`
const pad = (s: string, w: number) => s.slice(0, w).padEnd(w)

type Bucket = 'NO_QUANTITY' | 'DIMENSION_GAP' | 'CHAIN_GAP' | 'UNKNOWN_UOM' | 'UNIT_DEFAULTED'

interface Finding {
  bucket: Bucket
  itemId: string
  item: string
  supplier: string
  date: string
  spend: number
  detail: string
}

async function main() {
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      session: { status: 'APPROVED' },
      approved: true,
      splitToSessionId: null,
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      matchedItemId: { not: null },
    },
    select: {
      id: true, rawDescription: true, rawQty: true, rawUnit: true, rawLineTotal: true,
      totalQty: true, totalQtyUOM: true, qtyOrdered: true, qtyOrderedUOM: true,
      rate: true, rateUOM: true, pricingMode: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      session: { select: { supplierName: true, invoiceNumber: true, invoiceDate: true } },
      matchedItem: {
        select: { id: true, itemName: true, ...PRICING_SELECT },
      },
    },
  })

  const findings: Finding[] = []
  const pathCount: Record<string, number> = { rate: 0, pack: 0, chain: 0, none: 0 }

  for (const l of lines) {
    const m = l.matchedItem
    if (!m) continue
    const spend = n(l.rawLineTotal)
    const base = {
      itemId: m.id, item: m.itemName,
      supplier: l.session.supplierName ?? '?', date: l.session.invoiceDate ?? '?', spend,
    }

    const chainItem = asChainItem({
      dimension: m.dimension, baseUnit: m.baseUnit ?? 'each',
      packChain: m.packChain, pricing: m.pricing, countUnit: m.countUnit ?? undefined,
    })
    const baseUnit = chainItem.baseUnit
    const baseDim  = dimensionOf(baseUnit)

    const qty = n(l.rawQty)
    if (lineReceivedBaseUnits(l as never, chainItem) <= 0) {
      pathCount.none++
      const w = n(l.qtyOrdered) || n(l.totalQty)
      const u = l.qtyOrderedUOM ?? l.totalQtyUOM ?? l.rateUOM
      findings.push({
        ...base, bucket: 'NO_QUANTITY',
        detail: `qty=${qty || 'none'} billed=${w || 'none'} ${u ?? '(no unit)'}${u && isKnownUnit(u) ? '' : ' — UNIT MISSING/UNUSABLE'}`,
      })
      continue
    }
    if (qty <= 0) { pathCount.none++ }

    // ── replicate lineReceivedBaseUnits' path selection ──────────────────────
    const isRate = chainItem.pricing?.mode === 'RATE'
    let path: 'rate' | 'pack' | 'chain' = 'chain'
    let usedUnit: string | null = null
    let credited = 0

    if (isRate) {
      const billedQty = n(l.totalQty) > 0 ? n(l.totalQty) : qty
      const billedUOM = n(l.totalQty) > 0 ? (l.totalQtyUOM ?? baseUnit) : (l.rawUnit ?? baseUnit)
      // EXACT guard from lineReceivedBaseUnits: UNIT_FACTORS, not isKnownUnit —
      // container units (case/cs/box…) are "known" but absent from UNIT_FACTORS,
      // so a RATE line billed in cases correctly falls through to the pack path.
      if (billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) {
        path = 'rate'; usedUnit = billedUOM
        credited = convertQty(billedQty, billedUOM, baseUnit)
      }
    }
    const pq = n(l.invoicePackQty), ps = n(l.invoicePackSize), pu = l.invoicePackUOM
    if (path !== 'rate') {
      if (pq > 0 && ps > 0 && pu) {
        path = 'pack'; usedUnit = pu
        credited = convertQty(qty * pq * ps, pu, baseUnit)
      } else {
        const top = chainItem.packChain?.[0]?.unit
        path = 'chain'; usedUnit = top ?? null
        credited = qty * (top ? basePerUnit(chainItem, top) : 1)
      }
    }
    pathCount[path]++

    // `credited` above is only the path probe. The number reported is always the
    // REAL helper's, so this script can never describe maths the app doesn't run.
    credited = lineReceivedBaseUnits(l as never, chainItem)

    // E) the billed unit was DEFAULTED to the base unit because totalQtyUOM/rawUnit
    //    were both null, while the item is priced per some other unit (e.g. $/kg into
    //    a g base) — a silent 1000× under-credit that no dimension check can catch.
    if (path === 'rate' && n(l.totalQty) > 0 && !l.totalQtyUOM && !l.rawUnit) {
      const priced = (chainItem.pricing as { rateUnit?: string } | null)?.rateUnit ?? l.rateUOM ?? null
      if (priced && canonicalUom(priced) !== canonicalUom(baseUnit)) {
        findings.push({
          ...base, bucket: 'UNIT_DEFAULTED',
          detail: `OCR captured no unit for totalQty=${n(l.totalQty)}; inferred "${priced}" from the item's pricing`
                + ` → ${credited.toFixed(2)} ${baseUnit}. Correct today, but fragile if the item is repriced.`,
        })
        continue
      }
    }

    // D) unknown unit token anywhere on the line
    const badTokens = [l.rawUnit, l.invoicePackUOM, l.totalQtyUOM, l.rateUOM]
      .filter(u => u != null && String(u).trim() !== '' && !isKnownUnit(u))
    if (badTokens.length) {
      findings.push({ ...base, bucket: 'UNKNOWN_UOM', detail: `unknown unit(s) ${badTokens.map(t => JSON.stringify(t)).join(', ')} · path=${path}` })
      continue
    }

    // B) the unit actually used sits in a different dimension from the base unit,
    //    so convertQty returned the number unchanged.
    if (path !== 'chain' && usedUnit && dimensionOf(usedUnit) !== baseDim
        && !(dimensionOf(usedUnit) !== 'COUNT' && baseDim !== 'COUNT' && densityOf(m as never))
        && !eachMeasureOf(m as never)) {
      const bridged = convertQtyBridged(
        path === 'rate' ? (n(l.totalQty) > 0 ? n(l.totalQty) : qty) : qty * pq * ps,
        usedUnit, baseUnit,
        eachMeasureOf(m as never), densityOf(m as never),
      )
      const countUom = resolveCountUom({ dimension: m.dimension, baseUnit, packChain: m.packChain, countUnit: m.countUnit }) || baseUnit
      findings.push({
        ...base, bucket: 'DIMENSION_GAP',
        detail: `path=${path} · ${usedUnit} (${dimensionOf(usedUnit)}) → base ${baseUnit} (${baseDim}) · credited ${credited.toFixed(2)} ${baseUnit}`
              + ` = ${convertBaseToCountUom(credited, countUom, { dimension: m.dimension, baseUnit, packChain: m.packChain, countUnit: m.countUnit }).toFixed(2)} ${countUom}`
              + ` · bridged would be ${bridged.toFixed(2)} ${baseUnit}${bridged === credited ? ' (NO BRIDGE AVAILABLE)' : ''}`,
      })
      continue
    }

    // C) same dimension: base units are right, but does the item's own chain agree
    //    with the invoice's pack? A mismatch corrupts $/base and the count readout.
    if (!(pq > 0 && ps > 0 && pu) || dimensionOf(pu) !== baseDim) continue
    const invoiceBasePerCase = convertQty(pq * ps, pu, baseUnit)
    const top = chainItem.packChain?.[0]?.unit
    if (!(invoiceBasePerCase > 0) || !top) continue
    const itemBasePerCase = basePerUnit(chainItem, top)
    if (!(itemBasePerCase > 0)) continue
    const ratio = itemBasePerCase / invoiceBasePerCase
    if (ratio > 1.15 || ratio < 0.87) {
      const countUom = resolveCountUom({ dimension: m.dimension, baseUnit, packChain: m.packChain, countUnit: m.countUnit }) || baseUnit
      const shown = convertBaseToCountUom(credited, countUom, { dimension: m.dimension, baseUnit, packChain: m.packChain, countUnit: m.countUnit })
      findings.push({
        ...base, bucket: 'CHAIN_GAP',
        detail: `chain: 1 ${top} = ${itemBasePerCase.toFixed(2)} ${baseUnit} · invoice: ${invoiceBasePerCase.toFixed(2)} (${ratio.toFixed(3)}×)`
              + ` · ${qty} ${pu === baseUnit ? 'unit' : 'cs'} reads as ${shown.toFixed(2)} ${countUom}`,
      })
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const order: Bucket[] = ['NO_QUANTITY', 'UNIT_DEFAULTED', 'DIMENSION_GAP', 'UNKNOWN_UOM', 'CHAIN_GAP']
  const titles: Record<Bucket, string> = {
    NO_QUANTITY:   'A) No billed quantity — credited ZERO stock',
    DIMENSION_GAP: 'B) Cross-dimension line with NO bridge on the item — falls back to the item chain',
    UNKNOWN_UOM:   'D) Unknown UOM token — silent ×1 fallback',
    UNIT_DEFAULTED:'E) Billed unit had to be inferred from the item\'s priced unit',
    CHAIN_GAP:     'C) Item packChain disagrees with the invoice pack (cost + count readout)',
  }

  console.log(`Approved, matched, stock-affecting lines: ${lines.length}`)
  console.log(`receipt path taken: rate=${pathCount.rate} pack=${pathCount.pack} chain=${pathCount.chain} none=${pathCount.none}`)

  for (const b of order) {
    const f = findings.filter(x => x.bucket === b)
    const spend = f.reduce((s, x) => s + x.spend, 0)
    const items = new Set(f.map(x => x.itemId))
    console.log(`\n\n══ ${titles[b]} ══`)
    console.log(`${f.length} lines · ${items.size} items · ${money(spend)} of spend\n`)

    const byItem = new Map<string, { item: string; n: number; $: number; detail: string }>()
    for (const x of f) {
      const e = byItem.get(x.itemId) ?? { item: x.item, n: 0, $: 0, detail: x.detail }
      e.n++; e.$ += x.spend
      byItem.set(x.itemId, e)
    }
    for (const [id, e] of [...byItem.entries()].sort((a, b2) => b2[1].$ - a[1].$).slice(0, 25)) {
      console.log(`  ${pad(e.item, 28)} ${String(e.n).padStart(3)}L ${money(e.$).padStart(10)}  ${e.detail}`)
      console.log(`  ${' '.repeat(28)}     ${' '.repeat(10)}  id=${id}`)
    }
    if (byItem.size > 25) console.log(`  … and ${byItem.size - 25} more items`)
  }

  const zero = findings.filter(f => f.bucket === 'NO_QUANTITY')
  const approx = findings.filter(f => f.bucket === 'DIMENSION_GAP' || f.bucket === 'UNKNOWN_UOM')
  const chain = findings.filter(f => f.bucket === 'CHAIN_GAP')
  const sum = (f: Finding[]) => money(f.reduce((s, x) => s + x.spend, 0))
  console.log(`\n\nCREDITS NOTHING (must fix): ${zero.length} lines · ${sum(zero)}`)
  console.log(`APPROXIMATED FROM THE ITEM CHAIN — needs an each-measure/density or a real unit: ${approx.length} lines · ${sum(approx)}`)
  console.log(`QUANTITY FINE, CHAIN BROKEN (cost + count readout): ${chain.length} lines · ${sum(chain)}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
