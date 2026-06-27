import { computeRecipeCost } from '../../src/lib/recipeCosts'

let fails = 0
function near(label: string, got: number, want: number, tol = 1e-3) {
  if (Math.abs(got - want) > tol) { console.error(`FAIL ${label}: got ${got}, want ${want}`); fails++ }
  else console.log(`ok   ${label}`)
}

// Item: honey, base ml, $0.01/ml. Recipe asks for 1 kg of it.
// With density 1.42 g/ml: 1 kg = 1000 g = 704.225 ml → cost = 704.225 × 0.01 = $7.042
const recipe = {
  baseYieldQty: 1, portionSize: null, menuPrice: null,
  ingredients: [{
    id: 'i1', sortOrder: 0, qtyBase: 1, unit: 'kg', notes: null,
    inventoryItemId: 'inv1', linkedRecipeId: null, linkedRecipe: null,
    inventoryItem: {
      itemName: 'Honey', baseUnit: 'ml', dimension: 'VOLUME',
      packChain: [{ unit: 'jug', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, // $10 / 1000 ml = $0.01/ml
      densityGPerMl: 1.42 as unknown,
    },
  }],
}
const out = computeRecipeCost(recipe as never)
near('honey kg→ml cost', out.totalCost, 7.0422, 1e-3)
if (out.dimensionConflicts !== 0) { console.error(`FAIL: expected 0 dimension conflicts, got ${out.dimensionConflicts}`); fails++ }
else console.log('ok   no dimension conflict')

if (fails) { console.error(`${fails} failure(s)`); process.exit(1) }
console.log('all passed'); process.exit(0)
