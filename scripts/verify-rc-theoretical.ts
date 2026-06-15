/**
 * Regression checks for RC-partitioned theoretical stock.
 * Run via the tsconfig-paths command in the plan Conventions section.
 */
import { prisma } from '../src/lib/prisma'
import { buildPurchaseMap } from '../src/lib/count-expected'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

async function main() {
  // ── Albacore catch-weight: 20 lb billed $370, NOT 200 lb / $3,700 ──
  const alb = await prisma.inventoryItem.findFirst({ where: { itemName: 'Albacore tuna' }, select: { id: true, pricePerBaseUnit: true } })
  if (!alb) {
    check('Albacore tuna fixture present (cannot verify per-weight fix without it)', false)
  } else {
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true, name: true } })
    let total = 0
    const since = new Date('2000-01-01')
    for (const rc of rcs) {
      const m = await buildPurchaseMap(since, rc.id)
      total += (m.get(alb.id) ?? 0)
    }
    const value = total * Number(alb.pricePerBaseUnit)
    check('Albacore purchase value ≈ $370 (was $3,700)', Math.abs(value - 370) < 5, `got $${value.toFixed(2)}, ${total.toFixed(0)} g across all RCs`)
    check('Albacore counted once (≈9,072 g, not 90,718)', total > 8000 && total < 10000, `${total.toFixed(0)} g`)
  }

  // ── ALL = sum of every RC, per item and in total ──
  {
    const { getTheoreticalStockMap } = await import('../src/lib/count-expected')
    const items = await prisma.inventoryItem.findMany({ where: { isActive: true }, select: { id: true, pricePerBaseUnit: true } })
    const ids = items.map(i => i.id)
    const price = new Map(items.map(i => [i.id, Number(i.pricePerBaseUnit)]))
    const rcs = await prisma.revenueCenter.findMany({ select: { id: true } })

    const all = await getTheoreticalStockMap(null, ids)
    const perRc = await Promise.all(rcs.map(rc => getTheoreticalStockMap(rc.id, ids)))
    const sumRc = new Map<string, number>()
    for (const m of perRc) for (const [id, q] of m) sumRc.set(id, (sumRc.get(id) ?? 0) + q)

    let maxItemDiff = 0
    for (const id of ids) maxItemDiff = Math.max(maxItemDiff, Math.abs((all.get(id) ?? 0) - (sumRc.get(id) ?? 0)))
    const valAll = ids.reduce((s, id) => s + (all.get(id) ?? 0) * price.get(id)!, 0)
    const valSum = ids.reduce((s, id) => s + (sumRc.get(id) ?? 0) * price.get(id)!, 0)
    check('ALL == ΣRC per item', maxItemDiff < 1e-6, `max item qty diff ${maxItemDiff}`)
    check('ALL value == ΣRC value', Math.abs(valAll - valSum) < 0.01, `ALL $${valAll.toFixed(2)} vs ΣRC $${valSum.toFixed(2)}`)
    console.log(`   ALL theoretical stock value = $${valAll.toFixed(2)}`)
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
