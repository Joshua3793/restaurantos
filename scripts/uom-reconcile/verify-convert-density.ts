import { convertQtyBridged } from '../../src/lib/uom'

let fails = 0
function near(label: string, got: number, want: number, tol = 1e-6) {
  if (Math.abs(got - want) > tol) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// honey 1.42 g/ml. 1 kg of honey = 1000 g → 1000/1.42 = 704.225 ml
near('kg→l honey', convertQtyBridged(1, 'kg', 'l', null, 1.42), 0.704225, 1e-4)
// 1 L of honey → 1000 ml × 1.42 = 1420 g = 1.42 kg
near('l→kg honey', convertQtyBridged(1, 'l', 'kg', null, 1.42), 1.42, 1e-4)
// no density → unchanged 1:1 passthrough (today's behaviour preserved)
near('kg→l no density', convertQtyBridged(1, 'kg', 'l', null, null), 1)
near('kg→l zero density', convertQtyBridged(1, 'kg', 'l', null, 0), 1)
// same dimension ignores density entirely
near('kg→g same dim', convertQtyBridged(2, 'kg', 'g', null, 1.42), 2000)
// count↔measured bridge still works, density irrelevant
near('each→g pack bridge', convertQtyBridged(2, 'each', 'g', { qty: 1100, unit: 'g' }, null), 2200)

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
