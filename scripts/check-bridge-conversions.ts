// Pure-logic assertions for the count↔weight bridge. Run: npx tsx scripts/check-bridge-conversions.ts
import { convertQtyBridged, dimensionallyCostable } from '../src/lib/uom'

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
let failures = 0
function check(label: string, got: number | boolean, want: number | boolean) {
  const ok = typeof want === 'number' && typeof got === 'number' ? approx(got, want) : got === want
  if (!ok) { failures++; console.error(`✗ ${label}: got ${got}, want ${want}`) }
  else console.log(`✓ ${label}`)
}

const bridge = { qty: 1100, unit: 'g' }   // 1 each = 1100 g

// measured → count
check('200g → each',  convertQtyBridged(200, 'g', 'each', bridge), 200 / 1100)
check('8.8kg → each', convertQtyBridged(8.8, 'kg', 'each', bridge), 8)
// count → measured
check('2 each → g',   convertQtyBridged(2, 'each', 'g', bridge), 2200)
check('2 each → kg',  convertQtyBridged(2, 'each', 'kg', bridge), 2.2)
// same dimension delegates to convertQty (bridge ignored)
check('1kg → g',      convertQtyBridged(1, 'kg', 'g', bridge), 1000)
check('3 each → each',convertQtyBridged(3, 'each', 'each', bridge), 3)
// no bridge: cross-dimension passes through unchanged (today's behavior)
check('200g → each (no bridge)', convertQtyBridged(200, 'g', 'each', null), 200)
// dimensionallyCostable with bridge
check('costable g↔each +bridge', dimensionallyCostable('g', 'each', bridge), true)
check('costable g↔each no bridge', dimensionallyCostable('g', 'each', null), false)
check('costable g↔ml (unchanged)', dimensionallyCostable('g', 'ml'), true)

if (failures) { console.error(`\n${failures} fail:`); process.exit(1) }
console.log('\nall bridge assertions passed')
