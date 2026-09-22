import { describe, it, expect, vi, beforeEach } from 'vitest'

// An in-memory recipe graph behind the Prisma singleton. The shapes mirror what
// fetchRecipeWithCost's `include` actually returns (category, prepItems,
// ingredients with inventoryItem + linkedRecipe.inventoryItem) and what
// windowedAvgCost queries (inventoryItem.findMany, invoiceScanItem.findMany).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const graph: Record<string, any> = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findUnique = vi.fn(async ({ where }: any) => graph[where.id] ?? null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scanFindMany = vi.fn(async (_a?: any) => [] as any[])
// The mocked items are all raw (no `recipe` relation), so the `recipe: null`
// filter windowedAvgCost applies is a no-op here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itemFindMany = vi.fn(async ({ where }: any) =>
  (where.id.in as string[]).filter(id => id in ITEMS).map(id => ({ id, ...ITEMS[id] })),
)
vi.mock('@/lib/prisma', () => ({
  prisma: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recipe: { findUnique: (a: any) => findUnique(a) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invoiceScanItem: { findMany: (a: any) => scanFindMany(a) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inventoryItem: { findMany: (a: any) => itemFindMany(a) },
  },
}))

import { costContext, fetchRecipeWithCost } from '@/lib/recipeCosts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ITEMS: Record<string, any> = {
  // $20 / 20,000 g → $0.001/g on the LAST basis
  flour: { itemName: 'Flour', dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'bag', per: 20000 }], pricing: { mode: 'PACK', purchasePrice: 20 }, allergens: ['Wheat'] },
  water: { itemName: 'Water', dimension: 'VOLUME', baseUnit: 'ml', packChain: [{ unit: 'l', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 0 }, allergens: [] },
}

// A PREP-linked raw item: windowedAvgCost's `recipe: null` filter drops it, so it
// NEVER lands in ctx.prices. Kept OUT of ITEMS so the mocked findMany returns
// nothing for it, exactly like the real query.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PREP_LINKED: Record<string, any> = {
  jam: { itemName: 'Bacon Jam', dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'batch', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 5 }, allergens: [] },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = (id: string, over: any) => ({
  id, name: id, type: 'PREP', categoryId: 'c', category: { name: 'c', color: null }, inventoryItemId: null,
  baseYieldQty: '1000', yieldUnit: 'g', portionSize: null, portionUnit: null, menuPrice: null, isActive: true, notes: null,
  steps: [], activeMinutes: null, passiveMinutes: null, passiveNote: null, stages: [], method: [], createdAt: new Date(), updatedAt: new Date(),
  baseIngredientId: null, prepItems: [], ...over,
})
const invIng = (id: string, itemId: string, qty: string, unit: string) => ({
  id, sortOrder: 0, qtyBase: qty, unit, notes: null, recipePercent: null,
  inventoryItemId: itemId, linkedRecipeId: null, customName: null, inventoryItem: ITEMS[itemId] ?? PREP_LINKED[itemId], linkedRecipe: null,
})
// The spine of the linked prep: syncPrepToInventory wrote $5 / 1000 g batch = $0.005/g.
const prepIng = (id: string, recipeId: string, qty: string, unit: string) => ({
  id, sortOrder: 1, qtyBase: qty, unit, notes: null, recipePercent: null,
  inventoryItemId: null, linkedRecipeId: recipeId, customName: null, inventoryItem: null,
  linkedRecipe: { name: recipeId, yieldUnit: 'g', inventoryItem: { allergens: ['Wheat'], dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'batch', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 5 } } },
})

beforeEach(() => {
  for (const k of Object.keys(graph)) delete graph[k]
  findUnique.mockClear(); scanFindMany.mockClear(); itemFindMany.mockClear()
  graph.dough = base('dough', { ingredients: [invIng('i1', 'flour', '1000', 'g')] })              // LAST: $1/batch ($0.001/g)
  graph.pizza = base('pizza', { type: 'MENU', menuPrice: '10', portionSize: '500', portionUnit: 'g', ingredients: [prepIng('i2', 'dough', '500', 'g')] })
})

describe('fetchRecipeWithCost basis', () => {
  it('default (no basis) reads the nested prep off its spine — byte-identical to today', async () => {
    const r = await fetchRecipeWithCost('pizza')
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.005, lineCost: 2.5, costBasis: 'LAST' })
    expect(r!.basisSummary).toEqual({ basis: 'LAST', avgLines: 0, lastLines: 1 })
    expect(scanFindMany).not.toHaveBeenCalled()
    expect(itemFindMany).not.toHaveBeenCalled()
  })

  it('AVG_30D recurses: the nested prep is re-costed from its raw ingredients at their averages', async () => {
    scanFindMany.mockResolvedValueOnce([{ matchedItemId: 'flour', rawLineTotal: '30', receivedQtyBase: '10000' }]) // flour avg $0.003/g
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    // dough on AVG = 1000 g × $0.003 = $3/batch = $0.003/g; pizza uses 500 g → $1.50
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.003, lineCost: 1.5, costBasis: 'AVG_30D' })
    expect(r!.basisSummary).toEqual({ basis: 'AVG_30D', avgLines: 1, lastLines: 0 })
  })

  it("prices a nested prep's own raw items even though the caller's context only knew the outer recipe's ids", async () => {
    scanFindMany.mockResolvedValueOnce([{ matchedItemId: 'flour', rawLineTotal: '30', receivedQtyBase: '10000' }])
    await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    // pizza has NO raw ingredient ids of its own, so the only windowedAvgCost
    // read is the merge for dough's flour — proving the missing-ids merge ran.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(itemFindMany.mock.calls.map((c: any[]) => c[0].where.id.in)).toEqual([['flour']])
  })

  it('a nested prep whose raw lines ALL fell back is tagged LAST (and priced on the recursion, not the spine)', async () => {
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })   // no scan lines → flour LAST
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.001, costBasis: 'LAST' })
  })

  it('memo: a prep used twice in one request is fetched once', async () => {
    graph.pizza.ingredients.push(prepIng('i3', 'dough', '100', 'g'))
    await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    expect(findUnique.mock.calls.filter(c => c[0].where.id === 'dough')).toHaveLength(1)
  })

  it('diamond: A ⊃ B, A ⊃ C, B ⊃ D, C ⊃ D — D is fetched once and BOTH links stay on the average', async () => {
    scanFindMany.mockResolvedValue([{ matchedItemId: 'flour', rawLineTotal: '30', receivedQtyBase: '10000' }])
    graph.d = base('d', { ingredients: [invIng('di', 'flour', '1000', 'g')] })                 // AVG: $3 / 1000 g
    graph.b = base('b', { ingredients: [prepIng('bi', 'd', '100', 'g')] })                     // $0.30 / 1000 g
    graph.c = base('c', { ingredients: [prepIng('ci', 'd', '200', 'g')] })                     // $0.60 / 1000 g
    graph.a = base('a', { type: 'MENU', ingredients: [prepIng('a1', 'b', '50', 'g'), prepIng('a2', 'c', '50', 'g')] })

    const r = await fetchRecipeWithCost('a', { basis: 'AVG_30D' })
    expect(findUnique.mock.calls.filter(c => c[0].where.id === 'd')).toHaveLength(1)
    expect(r!.ingredients.map(i => i.costBasis)).toEqual(['AVG_30D', 'AVG_30D'])
    expect(r!.ingredients[0].lineCost).toBeCloseTo(50 * (0.3 / 1000), 10)
    expect(r!.ingredients[1].lineCost).toBeCloseTo(50 * (0.6 / 1000), 10)
    expect(r!.basisSummary).toEqual({ basis: 'AVG_30D', avgLines: 2, lastLines: 0 })
    scanFindMany.mockReset()
  })

  it('cycle: A ⊃ B ⊃ A costs the repeated link at the spine, tagged LAST, and terminates', async () => {
    graph.dough.ingredients.push(prepIng('i4', 'pizza', '10', 'g'))
    const r = await fetchRecipeWithCost('pizza', { basis: 'AVG_30D' })
    expect(r).not.toBeNull()
    // Inside pizza's recursion, dough's link BACK to pizza is the cycle edge: it
    // is priced at pizza's spine ($0.005/g), so dough = 1000 g flour × $0.001 +
    // 10 g × $0.005 = $1.05 / 1000 g. A cycle that did not terminate at the
    // spine could not produce a finite number here.
    expect(r!.ingredients[0].pricePerBaseUnit).toBeCloseTo(1.05 / 1000, 10)

    const dough = await fetchRecipeWithCost('dough', { basis: 'AVG_30D' })
    expect(dough!.ingredients.find(i => i.linkedRecipeId === 'pizza')!.costBasis).toBe('LAST')
  })

  it('a missing recipe is still null', async () => {
    expect(await fetchRecipeWithCost('nope', { basis: 'AVG_30D' })).toBeNull()
  })

  it('a PREP-linked raw id — which never gets a price entry — is asked for ONCE per context', async () => {
    // Two different recipes use the same PREP-linked raw item. It can never land
    // in ctx.prices (windowedAvgCost filters `recipe: null`), so without the
    // `asked` sentinel every recipe on the page re-queries it: the N+1.
    graph.toastA = base('toastA', { ingredients: [invIng('ta', 'jam', '10', 'g')] })
    graph.toastB = base('toastB', { ingredients: [invIng('tb', 'jam', '20', 'g')] })
    const ctx = await costContext('AVG_30D', [])
    await fetchRecipeWithCost('toastA', { ctx })
    await fetchRecipeWithCost('toastB', { ctx })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jamCalls = itemFindMany.mock.calls.filter((c: any[]) => (c[0].where.id.in as string[]).includes('jam'))
    expect(jamCalls).toHaveLength(1)
  })

  it('ids the context was seeded with are never re-asked, even by a nested prep', async () => {
    const ctx = await costContext('AVG_30D', ['flour'])
    await fetchRecipeWithCost('pizza', { ctx })   // pizza → dough → flour
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(itemFindMany.mock.calls.map((c: any[]) => c[0].where.id.in)).toEqual([['flour']])
  })

  it('a nested prep whose yield unit is a DIFFERENT dimension than its spine falls back to the spine', async () => {
    scanFindMany.mockResolvedValue([{ matchedItemId: 'flour', rawLineTotal: '30', receivedQtyBase: '10000' }])
    // Stale sync: the recipe now yields 10 `each` (portions) but its synced item
    // is still denominated in g. convertQty passes 10 each → 10 g through 1:1, so
    // perBase would be $3/10 = $0.30/g — 60× the spine's $0.005/g.
    graph.portioned = base('portioned', { baseYieldQty: '10', yieldUnit: 'each', ingredients: [invIng('pi', 'flour', '1000', 'g')] })
    graph.plate = base('plate', { type: 'MENU', ingredients: [prepIng('p1', 'portioned', '100', 'g')] })

    const r = await fetchRecipeWithCost('plate', { basis: 'AVG_30D' })
    expect(r!.ingredients[0]).toMatchObject({ pricePerBaseUnit: 0.005, lineCost: 0.5, costBasis: 'LAST' })
    scanFindMany.mockReset()
  })
})
