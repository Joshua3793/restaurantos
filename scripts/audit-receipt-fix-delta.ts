/**
 * READ-ONLY before/after for the receiving fix (2026-08-11).
 *
 * Holds FROZEN copies of the two pre-fix implementations — `buildPurchaseMap`'s
 * inline maths (what theoretical stock used) and `lineReceivedBaseUnits` (what the
 * RC split editor and the approved-invoice report used) — and compares both against
 * the single fixed helper they now share.
 *
 * The two had already drifted: the count-expected copy grew a pack-dimension guard
 * that the shared helper never got, so the same line credited different stock
 * depending on which surface asked. That drift is reported separately.
 *
 *   TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *     scripts/audit-receipt-fix-delta.ts
 */
try {
  process.loadEnvFile()
} catch (err) {
  console.error('Failed to load .env:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

import { prisma } from '@/lib/prisma'
import { PRICING_SELECT, asChainItem, basePerUnit, dimensionOf, type ChainItem } from '@/lib/item-model'
import { convertQty, canonicalUom, UNIT_FACTORS } from '@/lib/uom'
import { lineReceivedBaseUnits, type LineQtyInput } from '@/lib/invoice/line-qty'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : 0
}
const money = (v: number) => `$${v.toFixed(2)}`
const pad = (s: string, w: number) => s.slice(0, w).padEnd(w)

type Line = LineQtyInput

/** FROZEN pre-fix `lineReceivedBaseUnits` — the report / RC-split rule. */
function oldSharedHelper(line: Line, chainItem: ChainItem): number {
  const qty = n(line.rawQty)
  if (qty <= 0) return 0
  const baseUnit = chainItem.baseUnit
  const isRate = chainItem.pricing?.mode === 'RATE'
  if (isRate) {
    let billedQty = qty
    let billedUOM: string | null
    if (n(line.totalQty) > 0) { billedQty = n(line.totalQty); billedUOM = line.totalQtyUOM ?? baseUnit }
    else { billedQty = qty; billedUOM = line.rawUnit ?? baseUnit }
    if (billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) return convertQty(billedQty, billedUOM, baseUnit)
  }
  const packQty = n(line.invoicePackQty), packSize = n(line.invoicePackSize), packUOM = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM) return convertQty(qty * packQty * packSize, packUOM, baseUnit)
  const top = chainItem.packChain?.[0]?.unit
  return qty * (top ? basePerUnit(chainItem, top) : 1)
}

/** FROZEN pre-fix `buildPurchaseMap` inline maths — the theoretical-stock rule. */
function oldStockRule(line: Line, chainItem: ChainItem): number {
  const qty = n(line.rawQty)
  if (qty <= 0) return 0                       // plus a `rawQty: { not: null }` query filter
  const baseUnit = chainItem.baseUnit
  const isRate = chainItem.pricing.mode === 'RATE'
  let billedQty = qty
  let billedUOM: string | null = null
  if (isRate) {
    if (n(line.totalQty) > 0) { billedQty = n(line.totalQty); billedUOM = line.totalQtyUOM ?? baseUnit }
    else { billedQty = qty; billedUOM = line.rawUnit ?? baseUnit }
  }
  if (isRate && billedUOM && UNIT_FACTORS[canonicalUom(billedUOM)]) {
    return convertQty(billedQty, billedUOM, baseUnit)
  }
  const packQty = n(line.invoicePackQty), packSize = n(line.invoicePackSize), packUOM = line.invoicePackUOM ?? null
  if (packQty > 0 && packSize > 0 && packUOM && dimensionOf(packUOM) === chainItem.dimension) {
    return convertQty(qty * packQty * packSize, packUOM, baseUnit)
  }
  const top = chainItem.packChain[0]?.unit
  return qty * (top ? basePerUnit(chainItem, top) : 1)
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
      rawQty: true, rawUnit: true, totalQty: true, totalQtyUOM: true, rateUOM: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, rawLineTotal: true,
      matchedItem: { select: { id: true, itemName: true, ...PRICING_SELECT } },
    },
  })

  interface Agg { name: string; oldStock: number; oldReport: number; next: number; spend: number; lines: number; item: typeof lines[number]['matchedItem'] }
  const byItem = new Map<string, Agg>()
  let driftLines = 0

  for (const l of lines) {
    const m = l.matchedItem
    if (!m) continue
    const chainItem = asChainItem(m)
    const input: Line = {
      rawQty: l.rawQty?.toString() ?? null, rawUnit: l.rawUnit,
      totalQty: l.totalQty?.toString() ?? null, totalQtyUOM: l.totalQtyUOM, rateUOM: l.rateUOM,
      invoicePackQty: l.invoicePackQty?.toString() ?? null,
      invoicePackSize: l.invoicePackSize?.toString() ?? null,
      invoicePackUOM: l.invoicePackUOM,
    }
    // The old stock rule also never SAW rawQty-null lines (query filter).
    const oldStock  = l.rawQty == null ? 0 : oldStockRule(input, chainItem)
    const oldReport = oldSharedHelper(input, chainItem)
    const next      = lineReceivedBaseUnits(input, chainItem)
    if (Math.abs(oldStock - oldReport) > 1e-6) driftLines++

    const e = byItem.get(m.id) ?? { name: m.itemName, oldStock: 0, oldReport: 0, next: 0, spend: 0, lines: 0, item: m }
    e.oldStock += oldStock; e.oldReport += oldReport; e.next += next
    e.spend += n(l.rawLineTotal); e.lines++
    byItem.set(m.id, e)
  }

  const changed = [...byItem.entries()].filter(([, e]) => Math.abs(e.next - e.oldStock) > 1e-6)
  console.log(`${lines.length} approved lines · ${byItem.size} items`)
  console.log(`pre-fix drift between the two implementations: ${driftLines} lines\n`)
  console.log(`THEORETICAL STOCK CHANGES ON ${changed.length} ITEMS:\n`)

  const rows = changed.map(([id, e]) => {
    const m = e.item!
    const dims = { dimension: m.dimension, baseUnit: m.baseUnit ?? 'each', packChain: m.packChain, countUnit: m.countUnit }
    const cu = resolveCountUom(dims) || (m.baseUnit ?? 'each')
    return {
      id, name: e.name, spend: e.spend, lines: e.lines, cu,
      before: convertBaseToCountUom(e.oldStock, cu, dims),
      after:  convertBaseToCountUom(e.next,     cu, dims),
      delta:  e.next - e.oldStock,
    }
  }).sort((a, b) => b.spend - a.spend)

  for (const r of rows) {
    const dir = r.after > r.before ? '↑' : '↓'
    console.log(`  ${pad(r.name, 30)} ${String(r.lines).padStart(3)}L ${money(r.spend).padStart(10)}  ${r.before.toFixed(2)} → ${r.after.toFixed(2)} ${r.cu} ${dir}`)
  }

  const up = rows.filter(r => r.delta > 0).length
  console.log(`\n${up} items receive MORE stock, ${rows.length - up} receive less.`)
  console.log(`Spend on affected lines: ${money(rows.reduce((s, r) => s + r.spend, 0))}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
