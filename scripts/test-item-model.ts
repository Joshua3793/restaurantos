// Pure-engine regression test for the pack-chain item model. No DB.
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/test-item-model.ts
import {
  pricePerBaseUnit, basePerUnit, levelBaseUnits, stockValue, validateChainItem,
  type Dimension, type PackLink, type Pricing,
} from '../src/lib/item-model'

let failures = 0
function eq(label: string, got: number, want: number, tol = 1e-9) {
  const ok = Math.abs(got - want) <= Math.max(tol, Math.abs(want) * 1e-6)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${got} want=${want}`)
  if (!ok) failures++
}

const ketchup = { dimension: 'VOLUME' as Dimension, baseUnit: 'ml',
  packChain: [{ unit: 'case', per: 12 }, { unit: 'bottle', per: 1000 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 48 } as Pricing, countUnit: 'bottle', stockOnHand: 21000 }
eq('ketchup ppb', pricePerBaseUnit(ketchup), 48 / 12000)
eq('ketchup 1 bottle = ml', basePerUnit(ketchup, 'bottle'), 1000)
eq('ketchup 1 case = ml', basePerUnit(ketchup, 'case'), 12000)
eq('ketchup stock value', stockValue(ketchup), 21000 * (48 / 12000))

const romaine = { dimension: 'MASS' as Dimension, baseUnit: 'g',
  packChain: [{ unit: 'case', per: 24 }, { unit: 'head', per: 250 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 32 } as Pricing, countUnit: 'head', stockOnHand: 9000 }
eq('romaine ppb', pricePerBaseUnit(romaine), 32 / 6000)
eq('romaine 1 head = g', basePerUnit(romaine, 'head'), 250)
eq('romaine in kg', basePerUnit(romaine, 'kg'), 1000)

const soda = { dimension: 'VOLUME' as Dimension, baseUnit: 'ml',
  packChain: [{ unit: 'case', per: 4 }, { unit: 'sleeve', per: 6 }, { unit: 'can', per: 355 }] as PackLink[],
  pricing: { mode: 'PACK', purchasePrice: 36 } as Pricing, countUnit: 'can', stockOnHand: 17040 }
eq('soda ppb', pricePerBaseUnit(soda), 36 / 8520)
eq('soda levels case', levelBaseUnits(soda.packChain).case, 8520)

const ribeye = { dimension: 'MASS' as Dimension, baseUnit: 'g',
  packChain: [{ unit: 'case', per: 9000 }] as PackLink[],
  pricing: { mode: 'RATE', rate: 28.6, rateUnit: 'kg' } as Pricing, countUnit: 'kg', stockOnHand: 7400 }
eq('ribeye ppb', pricePerBaseUnit(ribeye), 28.6 / 1000)
eq('ribeye stock value', stockValue(ribeye), 7400 * (28.6 / 1000))

console.log('validate ok:', validateChainItem(ketchup).length === 0 ? 'PASS' : 'FAIL')
if (validateChainItem(ketchup).length !== 0) failures++
console.log('validate catches empty chain:',
  validateChainItem({ ...ketchup, packChain: [] }).length > 0 ? 'PASS' : 'FAIL')
if (validateChainItem({ ...ketchup, packChain: [] }).length === 0) failures++
console.log('validate catches per<=0:',
  validateChainItem({ ...ketchup, packChain: [{ unit: 'x', per: 0 }] }).length > 0 ? 'PASS' : 'FAIL')
if (validateChainItem({ ...ketchup, packChain: [{ unit: 'x', per: 0 }] }).length === 0) failures++

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
