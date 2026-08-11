/**
 * Write a revenue centre's stock from a purchase window.
 *
 * A non-default revenue centre holds its stock in `StockAllocation.quantity`,
 * in BASE units (the default centre's stock lives on the item itself). This sets
 * those allocations from what was bought for the centre over a window — the
 * convention for a centre that is never physically counted.
 *
 * Modes:
 *   --replace  the centre's position IS the window's purchases; every other
 *              allocation for the centre is zeroed
 *   --add      the window's purchases are added on top of what is already there
 *
 * Dry run by default. Pass --apply to write. Always writes a restore file first.
 *
 * Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register \
 *        scripts/set-rc-stock-from-purchases.ts <export.json> --replace|--add [--apply]
 */
import fs from 'fs'
import path from 'path'
import { prisma } from '../src/lib/prisma'
import { asChainItem, pricePerBaseUnit } from '../src/lib/item-model'

const SRC = process.argv[2]
const MODE = process.argv.includes('--replace') ? 'replace'
  : process.argv.includes('--add') ? 'add' : null
const APPLY = process.argv.includes('--apply')

async function main() {
  if (!SRC || !MODE) {
    console.error('Usage: set-rc-stock-from-purchases.ts <export.json> --replace|--add [--apply]')
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), SRC), 'utf8'))
  const rc = await prisma.revenueCenter.findFirst({ where: { name: data.revenueCenter } })
  if (!rc) { console.error(`No revenue centre "${data.revenueCenter}"`); process.exit(1) }
  if (rc.isDefault) {
    console.error(`${rc.name} is the DEFAULT revenue centre — its stock lives on the item, not in allocations. Refusing.`)
    process.exit(1)
  }

  // Only quantities that reconciled against an invoiced total. A line with no
  // total is a bad OCR pack, not stock: the "1 × 501 lb" Veal Bones line would
  // otherwise put 227 kg of phantom product on the shelf.
  const wanted = new Map<string, number>()
  for (const r of data.items) {
    if (r.qtyBaseReconciled > 0) wanted.set(r.item, r.qtyBaseReconciled)
  }
  const dropped = data.items.filter((r: { qtyBaseReconciled: number }) => !(r.qtyBaseReconciled > 0))

  const items = await prisma.inventoryItem.findMany({
    where: { itemName: { in: [...wanted.keys()] } },
  })
  const byName = new Map(items.map((i) => [i.itemName, i]))
  const missing = [...wanted.keys()].filter((n) => !byName.has(n))

  const existing = await prisma.stockAllocation.findMany({
    where: { revenueCenterId: rc.id },
    include: { inventoryItem: true },
  })
  const exByItem = new Map(existing.map((a) => [a.inventoryItemId, a]))

  // Restore file BEFORE anything is written.
  const stamp = new Date().toISOString().slice(0, 10)
  const restore = path.resolve(process.cwd(), `docs/audits/rc-stock-backup-${rc.name.toLowerCase()}-${stamp}.json`)
  fs.writeFileSync(restore, JSON.stringify(
    existing.map((a) => ({
      revenueCenterId: a.revenueCenterId,
      inventoryItemId: a.inventoryItemId,
      itemName: a.inventoryItem.itemName,
      quantity: Number(a.quantity),
    })), null, 2))

  type Op = { name: string; itemId: string; from: number; to: number; value: number }
  const ops: Op[] = []
  for (const [name, qty] of wanted) {
    const it = byName.get(name)
    if (!it) continue
    const from = Number(exByItem.get(it.id)?.quantity ?? 0)
    const to = MODE === 'replace' ? qty : from + qty
    ops.push({ name, itemId: it.id, from, to, value: to * pricePerBaseUnit(asChainItem(it)) })
  }
  const zeroed: Op[] = []
  if (MODE === 'replace') {
    for (const a of existing) {
      if (wanted.has(a.inventoryItem.itemName)) continue
      const from = Number(a.quantity)
      if (from === 0) continue
      zeroed.push({
        name: a.inventoryItem.itemName, itemId: a.inventoryItemId, from, to: 0,
        value: -from * pricePerBaseUnit(asChainItem(a.inventoryItem)),
      })
    }
  }

  console.log(`${rc.name} — ${MODE.toUpperCase()} from purchases ${data.from} … ${data.to}`)
  console.log(`  restore file: ${restore}`)
  if (missing.length) console.log(`  ⚠ items in the export with no matching inventory row: ${missing.join(', ')}`)
  if (dropped.length) console.log(`  excluded, unreconciled: ${dropped.map((d: { item: string }) => d.item).join(', ')}`)
  console.log(`\n  ${ops.length} allocations set:`)
  for (const o of ops.sort((a, b) => b.value - a.value)) {
    console.log(`    ${o.name.slice(0, 34).padEnd(35)} ${String(o.from).padStart(9)} → ${String(Math.round(o.to)).padStart(9)}   $${o.value.toFixed(2)}`)
  }
  if (zeroed.length) {
    console.log(`\n  ${zeroed.length} existing allocations ZEROED (worth $${(-zeroed.reduce((t, z) => t + z.value, 0)).toFixed(2)}):`)
    for (const z of zeroed.sort((a, b) => a.value - b.value).slice(0, 12)) {
      console.log(`    ${z.name.slice(0, 34).padEnd(35)} ${String(z.from).padStart(9)} → 0   $${(-z.value).toFixed(2)}`)
    }
    if (zeroed.length > 12) console.log(`    …and ${zeroed.length - 12} more`)
  }
  const after = ops.reduce((t, o) => t + o.value, 0)
  console.log(`\n  ${rc.name} value after: $${after.toFixed(2)}`)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.')
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction([
    ...ops.map((o) => prisma.stockAllocation.upsert({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rc.id, inventoryItemId: o.itemId } },
      update: { quantity: o.to },
      create: { revenueCenterId: rc.id, inventoryItemId: o.itemId, quantity: o.to },
    })),
    ...zeroed.map((z) => prisma.stockAllocation.update({
      where: { revenueCenterId_inventoryItemId: { revenueCenterId: rc.id, inventoryItemId: z.itemId } },
      data: { quantity: 0 },
    })),
  ])
  console.log(`\nAPPLIED — ${ops.length} set, ${zeroed.length} zeroed. Restore with ${restore}.`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
