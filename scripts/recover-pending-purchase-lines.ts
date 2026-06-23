/**
 * Recover PENDING purchase lines on APPROVED invoices that were already matched to the
 * correct item but never confirmed — so approve skipped them and their stock was never
 * credited. Activates them (action -> ADD_SUPPLIER, approved -> true) and teaches the
 * supplier-code rule so future invoices auto-match (no re-leak).
 *
 * DRY RUN:  TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/recover-pending-purchase-lines.ts
 * APPLY:    APPLY=1 TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/recover-pending-purchase-lines.ts
 */
import { prisma } from '../src/lib/prisma'
import { saveMatchRule } from '../src/lib/invoice-matcher'
import { getTheoreticalStockMap } from '../src/lib/count-expected'
import { asChainItem, pricePerBaseUnit, PRICING_SELECT } from '../src/lib/item-model'

const APPLY = process.env.APPLY === '1'

async function main() {
  // Only recover lines that ALREADY carry the correct matchedItemId (low-confidence
  // matches left at PENDING). We never invent a new link here.
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      action: 'PENDING',
      matchedItemId: { not: null },
      session: { status: 'APPROVED', parentSessionId: null },
    },
    select: {
      id: true, rawDescription: true, rawLineTotal: true, supplierItemCode: true, matchedItemId: true,
      invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true,
      matchedItem: { select: { itemName: true } },
      session: { select: { supplierName: true } },
    },
    orderBy: { rawLineTotal: 'desc' },
  })

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${lines.length} PENDING lines (already matched) to activate:\n`)
  const affectedItems = new Set<string>()
  for (const l of lines) {
    affectedItems.add(l.matchedItemId!)
    console.log(`  $${Number(l.rawLineTotal||0).toFixed(2).padStart(8)}  [${l.supplierItemCode??'—'}]  -> ${l.matchedItem?.itemName}   (${l.rawDescription.slice(0,40)})`)
  }

  // theoretical BEFORE (affected items only)
  const ids = [...affectedItems]
  const before = await getTheoreticalStockMap(null, ids)
  const itemsMeta = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, itemName: true, ...PRICING_SELECT } })
  const ppb = new Map(itemsMeta.map(i => [i.id, pricePerBaseUnit(asChainItem(i))]))
  const nameOf = new Map(itemsMeta.map(i => [i.id, i.itemName]))
  const baseOf = new Map(itemsMeta.map(i => [i.id, i.baseUnit]))

  if (!APPLY) {
    console.log(`\n(DRY RUN — no writes. Re-run with APPLY=1 to activate + teach rules.)`)
    await prisma.$disconnect(); return
  }

  // Activate lines + teach match rules
  let activated = 0
  for (const l of lines) {
    await prisma.invoiceScanItem.update({
      where: { id: l.id },
      data: { action: 'ADD_SUPPLIER', approved: true },
    })
    const fmt = (l.invoicePackQty != null && l.invoicePackSize != null)
      ? { packQty: Number(l.invoicePackQty), packSize: Number(l.invoicePackSize), packUOM: l.invoicePackUOM ?? 'each' }
      : null
    await saveMatchRule(l.rawDescription, l.matchedItemId!, l.session.supplierName, fmt, l.supplierItemCode).catch(e => console.error('  rule save failed:', e))
    activated++
  }
  console.log(`\nActivated ${activated} lines; taught ${activated} match rules (code + description).`)

  // theoretical AFTER
  const after = await getTheoreticalStockMap(null, ids)
  console.log(`\nTheoretical stock recovered (affected items):`)
  let totalValGain = 0
  for (const id of ids) {
    const b = before.get(id) ?? 0, a = after.get(id) ?? 0
    const gain = a - b
    if (Math.abs(gain) < 1e-6) continue
    totalValGain += gain * (ppb.get(id) ?? 0)
    console.log(`  ${(nameOf.get(id)||'').padEnd(26).slice(0,26)} ${b.toFixed(0).padStart(8)} -> ${a.toFixed(0).padStart(8)} ${baseOf.get(id)}  (+$${(gain*(ppb.get(id)??0)).toFixed(0)})`)
  }
  console.log(`\nTotal theoretical value recovered: $${totalValGain.toFixed(0)}`)

  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
