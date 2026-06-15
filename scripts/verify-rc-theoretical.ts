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
  if (!alb) { console.log('Albacore not found — skipping line check'); }
  else {
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

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
