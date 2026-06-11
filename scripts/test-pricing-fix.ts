// Deterministic reproduction + regression test for the 2026-06-11 pricing
// corruption (Pork Butt $9990/kg; potato/cheese price inflation; lb-qty packSize
// drop). Run: TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/test-pricing-fix.ts
import { calcPricePerBaseUnit, getUnitConv } from '../src/lib/utils'

let failures = 0
function check(name: string, got: number, want: number, tol = 1e-4) {
  const ok = Math.abs(got - want) <= Math.max(tol, Math.abs(want) * 0.001)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}  want ${want}`)
  if (!ok) failures++
}

// ── Bug A — catch-weight UOM item with packUOM='each' (Pork Butt) ─────────────
// Rate is $9.99/kg; baseUnit g. Correct ppb = 9.99/1000 = 0.00999.
// Pre-fix: getUnitConv('each')=1 → 9.99 ($9990/kg). Fix: count packUOM falls
// back to a weight unit so the rate is converted to $/g.
check('A: Pork Butt UOM packUOM=each',
  calcPricePerBaseUnit(9.99, 6, 'each', null, 1, 'each', 'UOM'),
  0.00999)

// A UOM item that already has a weight packUOM must be UNCHANGED.
check('A: Brisket UOM packUOM=kg (unchanged)',
  calcPricePerBaseUnit(19.70, 1, 'each', null, 7, 'kg', 'UOM'),
  0.01970)
check('A: meat priced per lb (unchanged)',
  calcPricePerBaseUnit(4.50, 1, 'each', null, 1, 'lb', 'UOM'),
  4.50 / getUnitConv('lb')) // 0.009920

// ── Bug C — carton-of-weight represented with qtyUOM='each' (correct form) ────
// Yellow potato 1×50lb, $36.95 → 36.95/(50lb in g) = 0.001629. The fix
// normalizes the item's qtyUOM to 'each' so the else-branch keeps packSize.
check('C: 50lb carton, qtyUOM=each (correct path)',
  calcPricePerBaseUnit(36.95, 1, 'each', null, 50, 'lb', 'CASE'),
  36.95 / (50 * getUnitConv('lb')))

// Manual weight-buy form must stay correct (qty in qtyPerPurchaseUnit, packSize 1)
check('C: weight-buy $24/kg salmon (unchanged)',
  calcPricePerBaseUnit(24, 1, 'kg', null, 1, 'each', 'CASE'),
  0.024)

// ── Bug B is removed in the matcher; here we assert the spine math the route
//    runs once newPrice = rawUnitPrice (the real case price). ──────────────────
check('B: Kennebec 1×50lb at real $34.32',
  calcPricePerBaseUnit(34.32, 1, 'each', null, 50, 'lb', 'CASE'),
  34.32 / (50 * getUnitConv('lb')))
check('B: Cream cheese 1×1.5kg at real $26.25',
  calcPricePerBaseUnit(26.25, 1, 'each', null, 1.5, 'kg', 'CASE'),
  26.25 / (1.5 * getUnitConv('kg')))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
