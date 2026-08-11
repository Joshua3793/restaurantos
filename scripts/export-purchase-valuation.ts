/**
 * Value a revenue centre's PURCHASES over a window as if they were a count.
 *
 * A revenue centre that is never physically counted (catering runs off what was
 * bought for the job) has no snapshot to value. The standing convention is to
 * treat the purchases of the preceding period as the closing position — which
 * assumes nothing bought was consumed inside the window. That assumption is the
 * whole basis of the number, so it is stated on the output rather than implied.
 *
 * Quantities use `lineReceivedBaseUnits` — the same rule the count's expected
 * quantity and theoretical receiving use, so this can never drift from them.
 * Values are the item's CURRENT corrected price, with the invoiced line total
 * shown beside it: the first is what the stock is worth, the second is what was
 * actually paid, and they differ whenever a price moved after the invoice.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/export-purchase-valuation.ts <revenueCentreName> <from> <to> [out.json]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit, basePerUnit } from '../src/lib/item-model'
import { lineReceivedBaseUnits } from '../src/lib/invoice/line-qty'
import { resolveCountUom } from '../src/lib/count-uom'

const [RC_NAME, FROM, TO] = process.argv.slice(2)
const OUT = path.resolve(process.cwd(), process.argv[5] || 'docs/audits/purchase-valuation.json')

async function main() {
  if (!RC_NAME || !FROM || !TO) {
    console.error('Usage: export-purchase-valuation.ts <revenueCentreName> <from> <to> [out.json]')
    process.exit(1)
  }
  // Items still carrying an unresolved price flag from the BC market audit —
  // their valuation is provisional and the workbook says so.
  const OPEN_FLAGS = new Set<string>()
  try {
    const drift = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/audits/price-drift-report.json'), 'utf8'))
    for (const f of drift) OPEN_FLAGS.add(f.name)
  } catch { /* audit not present — no markers */ }

  const rc = await prisma.revenueCenter.findFirst({ where: { name: RC_NAME } })
  if (!rc) { console.error(`No revenue centre named "${RC_NAME}"`); process.exit(1) }

  const from = new Date(`${FROM}T00:00:00.000Z`)
  const to = new Date(`${TO}T23:59:59.999Z`)

  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true,
      splitToSessionId: null,           // parent lines moved into an RC clone are not live
      matchedItemId: { not: null },
      session: { status: 'APPROVED', purchaseDate: { gte: from, lte: to } },
    },
    include: {
      matchedItem: { include: { supplier: { select: { name: true } } } },
      session: { select: { revenueCenterId: true, supplierName: true, purchaseDate: true, invoiceNumber: true } },
    },
  })

  // A line belongs to this RC by its own override, by an explicit split, or by
  // inheriting the invoice's RC when it carries none of its own.
  type Detail = {
    item: string; category: string; supplier: string; invoiceDate: string; invoiceNumber: string
    description: string; pack: string
    qtyBase: number; countQty: number; countUom: string; baseUnit: string
    lineTotal: number; valued: number; flags: string[]; attribution: string
  }
  const details: Detail[] = []

  // Prisma Decimal columns arrive as Decimal objects; the pure qty helper takes
  // number | string. Narrow explicitly rather than casting the whole row.
  const dec = (v: unknown): number | null => (v == null ? null : Number(v))
  const qtyInput = (l: (typeof lines)[number]) => ({
    rawQty: dec(l.rawQty),
    rawUnit: l.rawUnit,
    totalQty: dec(l.totalQty),
    totalQtyUOM: l.totalQtyUOM,
    invoicePackQty: dec(l.invoicePackQty),
    invoicePackSize: dec(l.invoicePackSize),
    invoicePackUOM: l.invoicePackUOM,
  })

  for (const l of lines) {
    const it = l.matchedItem!
    const split = Array.isArray(l.rcSplit) ? (l.rcSplit as Array<{ rcId?: string; qty?: number }>) : null
    const ci = asChainItem(it)
    const countUom = resolveCountUom(it) || ci.baseUnit
    const perCount = basePerUnit(ci, countUom) || 1

    let qtyBase: number
    let attribution: string
    if (split?.length) {
      const mine = split.filter((e) => e?.rcId === rc.id)
      if (!mine.length) continue
      // Split quantities are expressed in the item's COUNT unit.
      qtyBase = mine.reduce((t, e) => t + (Number(e.qty) || 0), 0) * perCount
      attribution = 'Split across revenue centres'
    } else if (l.revenueCenterId) {
      if (l.revenueCenterId !== rc.id) continue
      qtyBase = lineReceivedBaseUnits(qtyInput(l), ci)
      attribution = 'Line assigned to this revenue centre'
    } else {
      if (l.session.revenueCenterId !== rc.id) continue
      qtyBase = lineReceivedBaseUnits(qtyInput(l), ci)
      attribution = 'Whole invoice assigned to this revenue centre'
    }
    if (!(qtyBase > 0)) continue

    // Reconcile the line against itself: what the quantity is worth at the
    // item's price, versus what the invoice billed. A line that cannot be
    // reconciled is nearly always a bad OCR pack — one Veal Bones line read
    // "1 × 501 lb" with no line total, contributing 227 kg of stock and $0 of
    // spend. Such a line must not be quietly folded into a valuation.
    const lineTotal = l.rawLineTotal == null ? null : Number(l.rawLineTotal)
    const valued = qtyBase * pricePerBaseUnit(ci)
    const flags: string[] = []
    if (lineTotal == null || lineTotal === 0) flags.push('No invoiced total — cannot be reconciled')
    else if (Math.abs(valued - lineTotal) / lineTotal > 0.25) {
      flags.push(
        `Valued $${valued.toFixed(2)} vs invoiced $${lineTotal.toFixed(2)} — check the pack ` +
        `(${l.invoicePackQty ?? '?'} × ${l.invoicePackSize ?? '?'} ${l.invoicePackUOM ?? '?'})`,
      )
    }

    details.push({
      item: it.itemName,
      category: it.category,
      supplier: l.session.supplierName ?? it.supplier?.name ?? '',
      invoiceDate: l.session.purchaseDate!.toISOString().slice(0, 10),
      invoiceNumber: l.session.invoiceNumber ?? '',
      description: l.rawDescription,
      pack: `${l.invoicePackQty ?? '?'} × ${l.invoicePackSize ?? '?'} ${l.invoicePackUOM ?? ''}`.trim(),
      qtyBase,
      countQty: qtyBase / perCount,
      countUom,
      baseUnit: ci.baseUnit,
      lineTotal: lineTotal ?? 0,
      valued,
      flags,
      attribution,
    })
  }

  // Aggregate to one row per item — the position, with the invoice lines behind it.
  const byItem = new Map<string, Detail[]>()
  for (const d of details) {
    const arr = byItem.get(d.item) ?? []
    arr.push(d); byItem.set(d.item, arr)
  }
  const itemRows = await Promise.all([...byItem.entries()].map(async ([name, ds]) => {
    const it = await prisma.inventoryItem.findFirst({ where: { itemName: name } })
    const ci = asChainItem(it!)
    const ppb = pricePerBaseUnit(ci)
    const perFactor = ci.dimension === 'COUNT' ? 1 : 1000
    const perUnit = ci.dimension === 'MASS' ? 'kg' : ci.dimension === 'VOLUME' ? 'L' : 'each'
    const qtyBase = ds.reduce((t, d) => t + d.qtyBase, 0)
    return {
      item: name,
      category: ds[0].category,
      supplier: ds[0].supplier,
      invoices: ds.length,
      lastInvoiceDate: ds.map((d) => d.invoiceDate).sort().slice(-1)[0],
      qtyBase,
      countQty: qtyBase / (basePerUnit(ci, ds[0].countUom) || 1),
      countUom: ds[0].countUom,
      baseUnit: ci.baseUnit,
      pricePerBase: ppb,
      pricePerUnit: ppb * perFactor,
      perUnit,
      invoicedTotal: ds.reduce((t, d) => t + d.lineTotal, 0),
      flagged: ds.some((d) => d.flags.length),
      flags: [...new Set(ds.flatMap((d) => d.flags))],
      // Reconciled quantity excludes lines that could not be checked against an
      // invoiced total — those are listed separately rather than valued.
      qtyBaseReconciled: ds.filter((d) => !d.flags.length).reduce((t, d) => t + d.qtyBase, 0),
      priceUnderReview: OPEN_FLAGS.has(name),
      attribution: [...new Set(ds.map((d) => d.attribution))].join('; '),
    }
  }))
  itemRows.sort((a, b) => a.category.localeCompare(b.category) || a.item.localeCompare(b.item))
  details.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.item.localeCompare(b.item))

  const payload = {
    revenueCenter: rc.name,
    from: FROM, to: TO,
    asAt: TO,
    exportedAt: new Date().toISOString(),
    items: itemRows,
    details,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))

  const valued = itemRows.reduce((t, r) => t + r.qtyBaseReconciled * r.pricePerBase, 0)
  const invoiced = itemRows.reduce((t, r) => t + r.invoicedTotal, 0)
  const excluded = itemRows.reduce((t, r) => t + (r.qtyBase - r.qtyBaseReconciled) * r.pricePerBase, 0)
  console.log(`${rc.name} — purchases ${FROM} to ${TO}`)
  console.log(`  invoice lines            ${details.length}`)
  console.log(`  distinct items           ${itemRows.length}`)
  console.log(`  invoiced (as billed)     $${invoiced.toFixed(2)}`)
  console.log(`  valued at current prices $${valued.toFixed(2)}   (reconciled lines only)`)
  console.log(`  difference vs invoiced   $${(valued - invoiced).toFixed(2)}`)
  console.log(`  EXCLUDED, unreconciled   $${excluded.toFixed(2)}   ${details.filter((d) => d.flags.length).length} lines`)
  for (const d of details.filter((d) => d.flags.length))
    console.log(`     ${d.invoiceDate}  ${d.item.slice(0, 26).padEnd(27)} ${d.pack.padEnd(16)} ${d.flags[0]}`)
  console.log('')
  const byCat = new Map<string, number>()
  for (const r of itemRows) byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.qtyBaseReconciled * r.pricePerBase)
  for (const [c, v] of [...byCat.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${c.padEnd(8)} $${v.toFixed(2)}`)
  console.log(`\nWrote ${OUT}`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
