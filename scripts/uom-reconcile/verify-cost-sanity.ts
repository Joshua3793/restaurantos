import { costDriftWithinBand } from '../../src/lib/invoice/cost-sanity'

let fails = 0
function eq(label: string, got: boolean, want: boolean) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('0% drift', costDriftWithinBand(4.22, 4.22), true)
eq('+24% within', costDriftWithinBand(4.22 * 1.24, 4.22), true)
eq('+26% outside', costDriftWithinBand(4.22 * 1.26, 4.22), false)
eq('-26% outside', costDriftWithinBand(4.22 * 0.74, 4.22), false)
eq('no basis allows', costDriftWithinBand(9.9, 0), true)  // current<=0 → nothing to compare
eq('custom band', costDriftWithinBand(2, 1, 1.5), true)    // +100% within a 150% band

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
