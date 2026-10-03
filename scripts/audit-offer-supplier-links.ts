// READ-ONLY. The pre-flight for making InventorySupplierPrice.supplierId required.
// Prints: offers with no supplier link and the supplier each would resolve to;
// offers whose stored supplierName differs from the linked supplier's name;
// duplicates that would collide under the new (item, supplierId, SKU) key;
// APPROVED invoice sessions with no supplier link; and the current FK rule.
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-offer-supplier-links.ts
import { prisma } from '../src/lib/prisma'
import { coverageScore } from '../src/lib/supplier-matcher'

/** Exact alias/name match (case-blind), else the best fuzzy ≥ 0.5 — WITHOUT learning an alias. */
export async function proposeSupplier(name: string): Promise<{ id: string; name: string; how: 'exact' | 'fuzzy'; score: number } | null> {
  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true, aliases: { select: { name: true } } } })
  const n = name.trim().toLowerCase()
  for (const s of suppliers) {
    if (s.name.toLowerCase() === n || s.aliases.some(a => a.name.toLowerCase() === n)) return { id: s.id, name: s.name, how: 'exact', score: 1 }
  }
  let best: { id: string; name: string; how: 'fuzzy'; score: number } | null = null
  for (const s of suppliers) {
    for (const cand of [s.name, ...s.aliases.map(a => a.name)]) {
      const score = coverageScore(name, cand)
      if (score >= 0.5 && (!best || score > best.score)) best = { id: s.id, name: s.name, how: 'fuzzy', score }
    }
  }
  return best
}

async function main() {
  const orphans = await prisma.inventorySupplierPrice.findMany({
    where: { supplierId: null },
    select: { id: true, supplierName: true, isPrimary: true, inventoryItem: { select: { itemName: true } } },
  })
  console.log(`Offers with no supplier link: ${orphans.length}`)
  for (const o of orphans) {
    const p = await proposeSupplier(o.supplierName)
    console.log(`  ${o.id}  ${o.inventoryItem.itemName.padEnd(30)} "${o.supplierName}" → ${p ? `${p.name} (${p.how}${p.how === 'fuzzy' ? ` ${p.score.toFixed(2)}` : ''})` : 'UNRESOLVED'}`)
  }

  const mismatched = await prisma.inventorySupplierPrice.findMany({
    where: { supplierId: { not: null } },
    select: { id: true, supplierName: true, supplier: { select: { name: true } }, inventoryItem: { select: { itemName: true } } },
  })
  const bad = mismatched.filter(o => o.supplier && o.supplierName !== o.supplier.name)
  console.log(`Offers whose supplierName differs from the linked supplier: ${bad.length}`)
  for (const o of bad) console.log(`  ${o.id}  ${o.inventoryItem.itemName.padEnd(30)} "${o.supplierName}" → "${o.supplier!.name}"`)

  const dups = await prisma.$queryRawUnsafe<{ inventoryItemId: string; supplierId: string; code: string; n: number }[]>(
    `SELECT "inventoryItemId", "supplierId", COALESCE("supplierItemCode", '') AS code, COUNT(*)::int AS n
       FROM "InventorySupplierPrice" WHERE "supplierId" IS NOT NULL
      GROUP BY 1, 2, 3 HAVING COUNT(*) > 1`)
  console.log(`Duplicates under (item, supplierId, SKU): ${dups.length}`)
  for (const d of dups) console.log(`  item ${d.inventoryItemId} supplier ${d.supplierId} sku "${d.code}" × ${d.n}`)

  const sessions = await prisma.invoiceSession.findMany({
    where: { supplierId: null, status: 'APPROVED' },
    select: { id: true, supplierName: true, invoiceNumber: true },
  })
  console.log(`APPROVED sessions with no supplier link: ${sessions.length}`)
  for (const s of sessions) {
    const p = s.supplierName ? await proposeSupplier(s.supplierName) : null
    console.log(`  ${s.id}  #${s.invoiceNumber ?? '—'} "${s.supplierName}" → ${p ? `${p.name} (${p.how})` : 'UNRESOLVED'}`)
  }

  const fk = await prisma.$queryRawUnsafe<{ conname: string; confdeltype: string }[]>(
    `SELECT c.conname, c.confdeltype FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'InventorySupplierPrice' AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) LIKE '%"supplierId"%'`)
  console.log(`FK on supplierId: ${fk.map(f => `${f.conname} (on delete ${f.confdeltype === 'r' ? 'RESTRICT' : f.confdeltype === 'n' ? 'SET NULL' : f.confdeltype === 'a' ? 'NO ACTION' : f.confdeltype})`).join(', ') || 'NONE'}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
