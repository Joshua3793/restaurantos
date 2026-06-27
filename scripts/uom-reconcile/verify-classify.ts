// @ts-nocheck — runtime-only assertions; union narrowing is not needed here.
import { classifyDimensionRelationship } from '../../src/lib/invoice/classify'
import type { ScanItem } from '../../src/components/invoices/types'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// Minimal ScanItem factory — only the fields the classifier reads.
function line(p: Partial<ScanItem>): ScanItem {
  return {
    id: 'x', rawDescription: 'x', matchConfidence: 'HIGH', action: 'UPDATE_PRICE',
    ...p,
  } as unknown as ScanItem
}

// 1) Same dimension (kg line on a g item) → IDENTICAL
eq('identical', classifyDimensionRelationship(line({
  rateUOM: 'kg', pricingMode: 'per_weight',
  matchedItem: { dimension: 'MASS', baseUnit: 'g', itemName: 'Flour' } as never,
})).verdict, 'IDENTICAL')

// 2) Weight line on a VOLUME item, name in library, no in-line volume → DENSITY_BRIDGE / suggest
{
  const r = classifyDimensionRelationship(line({
    rateUOM: 'kg', pricingMode: 'per_weight',
    matchedItem: { dimension: 'VOLUME', baseUnit: 'ml', itemName: 'Liquid Egg Yolk' } as never,
  }))
  eq('density verdict', r.verdict, 'DENSITY_BRIDGE')
  eq('density tier', r.tier, 'suggest')
  eq('density value', r.verdict === 'DENSITY_BRIDGE' && r.density, 1.03)
}

// 3) Weight line on a COUNT item WITH derivable per-each (packSize+count) → PACK_BRIDGE / auto
{
  const r = classifyDimensionRelationship(line({
    pricingMode: 'per_weight', invoicePackUOM: 'lb', invoicePackSize: 2.04 as never, rawQty: 12 as never,
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Cabbage', countUnit: 'each' } as never,
  }))
  eq('pack verdict', r.verdict, 'PACK_BRIDGE')
  eq('pack tier', r.tier, 'auto')
}

// 4) Weight line on a COUNT item, weak match, nothing derivable → TRUE_CONFLICT
{
  const r = classifyDimensionRelationship(line({
    rateUOM: 'kg', pricingMode: 'per_weight', matchConfidence: 'LOW',
    matchedItem: { dimension: 'COUNT', baseUnit: 'each', itemName: 'Fresh Lemons', countUnit: 'each' } as never,
  }))
  eq('true conflict', r.verdict, 'TRUE_CONFLICT')
}

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
