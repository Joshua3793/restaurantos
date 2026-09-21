/**
 * READ-ONLY. Is "price x billed weight = line total" a reliable test that a line
 * was billed by weight? Compares it with the OCR pricing mode on every countable
 * approved line. 2026-09-21 result: 1,773 lines, 0 disagreements.
 *
 *   npx tsx docs/audits/2026-09-20-line-first-receiving/money-check.ts
 */
import { prisma } from '../../../src/lib/prisma'
import { UNIT_FACTORS, canonicalUom } from '../../../src/lib/uom'
const isMeasure = (u?: string | null) => { if (!u) return false; const f = UNIT_FACTORS[canonicalUom(u)]; return !!f && f.dim !== 'count' }
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
;(async () => {
  const lines = await prisma.invoiceScanItem.findMany({
    where: { approved: true, matchedItemId: { not: null }, splitToSessionId: null, action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] }, session: { status: 'APPROVED' } },
    select: { rawDescription: true, rawQty: true, rawUnit: true, rawUnitPrice: true, rawLineTotal: true, totalQty: true, totalQtyUOM: true, rate: true, rateUOM: true, pricingMode: true, invoicePackQty: true, invoicePackSize: true, invoicePackUOM: true, matchedItem: { select: { itemName: true } }, session: { select: { supplierName: true } } },
  })
  const stat: Record<string, number> = {}
  const bump = (k: string) => { stat[k] = (stat[k] ?? 0) + 1 }
  const bad: string[] = []
  for (const l of lines) {
    const shippedMeasure = isMeasure(l.rawUnit) && n(l.rawQty) > 0
    const billedMeasure = isMeasure(l.totalQtyUOM) && n(l.totalQty) > 0
    const mode = l.pricingMode ?? 'null'
    if (shippedMeasure) bump('A shipped unit is a measure')
    if (!shippedMeasure && billedMeasure) {
      bump(`B container + billed measure · mode=${mode}`)
      const price = n(l.rate) || n(l.rawUnitPrice), total = n(l.rawLineTotal)
      if (price > 0 && total > 0) {
        // does price × billed reproduce the total (unit of rate = unit of billed assumed when rateUOM missing)?
        const byWeight = Math.abs(price * n(l.totalQty) - total) <= Math.max(0.02, total * 0.02)
        const byCase = Math.abs(n(l.rawUnitPrice) * n(l.rawQty) - total) <= Math.max(0.02, total * 0.02)
        bump(`B mode=${mode} · money: ${byWeight ? 'rate×billed=total' : byCase ? 'price×cases=total' : 'neither'}`)
        if (mode === 'per_weight' && !byWeight) bad.push(`per_weight but rate×billed≠total: ${l.matchedItem?.itemName} | ${l.rawQty} ${l.rawUnit} | billed ${l.totalQty}${l.totalQtyUOM} | rate ${l.rate}/${l.rateUOM} price ${l.rawUnitPrice} total ${l.rawLineTotal}`)
        if (mode !== 'per_weight' && byWeight && !byCase) bad.push(`NOT per_weight but rate×billed=total: ${l.matchedItem?.itemName} | ${l.rawQty} ${l.rawUnit} | billed ${l.totalQty}${l.totalQtyUOM} | price ${l.rawUnitPrice} total ${l.rawLineTotal} mode ${mode}`)
      } else bump(`B mode=${mode} · money: no price/total`)
    }
  }
  console.log(lines.length, 'countable approved lines')
  for (const k of Object.keys(stat).sort()) console.log(String(stat[k]).padStart(5), k)
  console.log('\nDisagreements between OCR mode and the money check:', bad.length); for (const b of bad.slice(0, 25)) console.log('  ', b)
  await prisma.$disconnect()
})()
