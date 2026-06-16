/**
 * Regression checks for two invoice-accuracy bugs:
 *  1. Approve route wrote pricePerBaseUnit = perCasePrice / totalQty for CASE items
 *     (Butter $0.0604/g instead of $0.0152/g → inventory value $6,171 vs $1,555).
 *  2. Re-approval after reset stacks duplicate RC clones → double-counted purchases.
 */
import { prisma } from '../src/lib/prisma'
import { calcPricePerBaseUnit } from '../src/lib/utils'
import { getTheoreticalStockMap } from '../src/lib/count-expected'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!cond) failures++
}

async function main() {
  // ── Bug 1: Butter ppb matches its pack structure, value ≈ $1,555 ──
  const butter = await prisma.inventoryItem.findFirst({
    where: { itemName: 'Butter' },
    select: { id: true, pricePerBaseUnit: true, purchasePrice: true, qtyPerPurchaseUnit: true,
      qtyUOM: true, innerQty: true, packSize: true, packUOM: true, priceType: true },
  })
  if (!butter) { check('Butter fixture present', false); }
  else {
    const expected = calcPricePerBaseUnit(Number(butter.purchasePrice), Number(butter.qtyPerPurchaseUnit),
      butter.qtyUOM ?? 'each', butter.innerQty != null ? Number(butter.innerQty) : null,
      Number(butter.packSize), butter.packUOM, (butter.priceType ?? 'CASE') as 'CASE' | 'UOM')
    const stored = Number(butter.pricePerBaseUnit)
    check('calcPricePerBaseUnit(Butter pack) ≈ $0.01522/g', Math.abs(expected - 0.015224) < 1e-4, `got ${expected.toPrecision(5)}`)
    check('Butter stored ppb matches its pack (not inflated)', Math.abs(stored - expected) / expected < 0.02, `stored ${stored.toPrecision(5)} vs pack ${expected.toPrecision(5)}`)
    const theo = (await getTheoreticalStockMap(null, [butter.id])).get(butter.id) ?? 0
    const value = theo * stored
    check('Butter theoretical value ≈ $1,555 (9 cases × $172.79)', Math.abs(value - 1555) < 30, `got $${value.toFixed(2)} (${theo.toFixed(0)} g × ${stored.toPrecision(4)})`)
  }

  // ── Bug 2: no parent session has more than one clone per revenue center ──
  const clones = await prisma.invoiceSession.findMany({
    where: { parentSessionId: { not: null } },
    select: { parentSessionId: true, revenueCenterId: true },
  })
  const seen = new Map<string, number>()
  for (const c of clones) {
    const k = `${c.parentSessionId}::${c.revenueCenterId}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dups = [...seen.values()].filter(n => n > 1).length
  check('No duplicate (parent, RC) invoice clones', dups === 0, `${dups} duplicate group(s) across ${clones.length} clones`)

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  await prisma.$disconnect()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
