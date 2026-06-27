import { densityOf, asChainItem } from '../../src/lib/item-model'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  if (got !== want) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

eq('valid density', densityOf({ densityGPerMl: '1.03' as unknown }), 1.03)
eq('null density',  densityOf({ densityGPerMl: null }), null)
eq('zero rejected', densityOf({ densityGPerMl: 0 }), null)
eq('asChainItem carries density',
   asChainItem({ dimension: 'VOLUME', baseUnit: 'ml', packChain: [], pricing: {}, densityGPerMl: '0.91' as unknown }).densityGPerMl,
   0.91)

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
