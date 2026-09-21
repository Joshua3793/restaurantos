import { prisma } from '../../../src/lib/prisma'
import { dimensionOf } from '../../../src/lib/item-model'
;(async () => {
  const items = await prisma.inventoryItem.findMany({ where: { isActive: true }, select: { itemName: true, dimension: true, baseUnit: true, pricing: true, eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true, _count: { select: { recipeIngredients: true } }, supplierPrices: { select: { supplierName: true, isPrimary: true, pricing: true } } } })
  let it = 0, of = 0
  for (const i of items) {
    const p = i.pricing as { mode?: string; rateUnit?: string; rate?: number } | null
    if (p?.mode === 'RATE' && p.rateUnit && dimensionOf(p.rateUnit) !== i.dimension) { it++; console.log(`ITEM  ${i.itemName.slice(0, 34).padEnd(34)} ${i.dimension}/${i.baseUnit} RATE ${p.rate}/${p.rateUnit} · each-measure ${i.eachMeasureQty ?? '-'} ${i.eachMeasureUnit ?? ''} · density ${i.densityGPerMl ?? '-'} · recipes ${i._count.recipeIngredients}`) }
    for (const o of i.supplierPrices) { const q = o.pricing as typeof p; if (q?.mode === 'RATE' && q.rateUnit && dimensionOf(q.rateUnit) !== i.dimension) { of++; console.log(`OFFER ${i.itemName.slice(0, 34).padEnd(34)} ${o.supplierName.slice(0, 16)}${o.isPrimary ? '*' : ''} RATE ${q.rate}/${q.rateUnit} on ${i.dimension}/${i.baseUnit} · density ${i.densityGPerMl ?? '-'}`) } }
  }
  console.log(`\nactive items ${items.length}: ${it} item(s) and ${of} offer(s) carry a RATE whose unit is another dimension than the item`)
  const withEach = items.filter(i => i.dimension === 'COUNT' && i.eachMeasureQty != null).length
  console.log('COUNT items with an each-measure:', withEach)
  await prisma.$disconnect()
})()
