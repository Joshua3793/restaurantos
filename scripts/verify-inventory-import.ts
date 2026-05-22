import { mapRowToPayload, type RawRow } from '../src/lib/inventory-import'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.error(`FAIL ${label}: got ${a}, expected ${e}`) }
  else console.log(`ok   ${label}`)
}
function row(p: Partial<RawRow>): RawRow {
  return {
    rowNumber: 1, itemName: 'X', purchasePrice: '0', priceBasis: '',
    caseContains: '', contentUnit: '', stockOnHand: '', barcode: '', ...p,
  }
}

// Per Case of 24 each at $24 -> pricePerBaseUnit 1.00, baseUnit each
const tomatoes = mapRowToPayload(row({
  itemName: 'Diced Tomatoes', purchasePrice: '24', priceBasis: 'Per Case',
  caseContains: '24', contentUnit: 'each', stockOnHand: '12',
}))
check('tomatoes pricePerBaseUnit', tomatoes.pricePerBaseUnit, 1)
check('tomatoes baseUnit', tomatoes.baseUnit, 'each')
check('tomatoes stockOnHand', tomatoes.stockOnHand, 12)

// Per kg at $18.50 -> pricePerBaseUnit 0.0185 (per g), baseUnit g, stock 40kg -> 40000g
const flour = mapRowToPayload(row({
  itemName: 'Flour', purchasePrice: '18.5', priceBasis: 'Per kg', stockOnHand: '40',
}))
check('flour pricePerBaseUnit', flour.pricePerBaseUnit, 0.0185)
check('flour baseUnit', flour.baseUnit, 'g')
check('flour stockOnHand', flour.stockOnHand, 40000)

// Per Case of 6 L at $65 -> pricePerBaseUnit 65/6000, baseUnit ml
const oil = mapRowToPayload(row({
  itemName: 'Olive Oil', purchasePrice: '65', priceBasis: 'Per Case',
  caseContains: '6', contentUnit: 'L', stockOnHand: '4',
}))
check('oil pricePerBaseUnit', oil.pricePerBaseUnit, 65 / 6000)
check('oil baseUnit', oil.baseUnit, 'ml')
check('oil stockOnHand', oil.stockOnHand, 4000)

// Per Each at $3.50 -> pricePerBaseUnit 3.50, baseUnit each
const each = mapRowToPayload(row({
  itemName: 'Lemon', purchasePrice: '3.5', priceBasis: 'Per Each', stockOnHand: '20',
}))
check('lemon pricePerBaseUnit', each.pricePerBaseUnit, 3.5)
check('lemon baseUnit', each.baseUnit, 'each')
check('lemon stockOnHand', each.stockOnHand, 20)

if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1) }
console.log('\nall checks passed')
