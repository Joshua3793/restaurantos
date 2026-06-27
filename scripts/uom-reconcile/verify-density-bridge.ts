import { densityCrossedPpb } from '../../src/lib/invoice/density-bridge'

let fails = 0
function near(label: string, got: number, want: number, tol = 1e-9) {
  if (Math.abs(got - want) > tol) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// egg yolk: $4.10/kg = $0.00410/g, density 1.03 → $/ml = 0.00410 × 1.03 = 0.0042230
near('mass→vol egg yolk', densityCrossedPpb(0.00410, 'MASS', 'VOLUME', 1.03), 0.0042230)
// oil: $0.00200/ml, density 0.92 → $/g = 0.00200 / 0.92 = 0.0021739…
near('vol→mass oil', densityCrossedPpb(0.00200, 'VOLUME', 'MASS', 0.92), 0.00200 / 0.92)
// same dimension → unchanged
near('mass→mass unchanged', densityCrossedPpb(0.005, 'MASS', 'MASS', 1.42), 0.005)
near('count base unchanged', densityCrossedPpb(0.005, 'MASS', 'COUNT', 1.42), 0.005)
// no density → unchanged
near('no density unchanged', densityCrossedPpb(0.005, 'MASS', 'VOLUME', 0), 0.005)

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
