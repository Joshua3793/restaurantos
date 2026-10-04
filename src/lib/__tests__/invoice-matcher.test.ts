import { describe, it, expect, vi, beforeEach } from 'vitest'
// matchLineItems reads three tables through the prisma singleton: the items
// (already W4-filtered by the query), this supplier's aliases (tiers 0/1 by
// code/text, tier 3 by item) and this supplier's offers. The stand-in below
// answers each from small fixtures, honouring the where-clauses the matcher is
// supposed to send — so a test that "leaks" another supplier's alias fails
// because the matcher asked for it, not because the mock handed it over.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prismaMock = vi.hoisted(() => ({}) as any)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
import { matchLineItems } from '@/lib/invoice-matcher'
import type { OcrLineItem } from '@/lib/invoice-ocr'

type Item = { id: string; itemName: string; isActive: boolean; mergedIntoId: string | null; recipe: { type: string } | null }
type Alias = { id: string; inventoryItemId: string; supplierId: string; text: string; rawText: string; supplierItemCode: string | null; packQty: number | null; packSize: number | null; packUOM: string | null; useCount: number; lastUsed: Date }

const chain = { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 10 }, countUnit: 'case', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
const it_ = (id: string, itemName: string, o: Partial<Item> = {}): Item => ({ id, itemName, isActive: true, mergedIntoId: null, recipe: null, ...o })
let n = 0
const alias = (o: Partial<Alias> & Pick<Alias, 'inventoryItemId' | 'supplierId' | 'text'>): Alias => ({
  id: `a${++n}`, rawText: o.text.toUpperCase(), supplierItemCode: null, packQty: null, packSize: null, packUOM: null, useCount: 1, lastUsed: new Date(0), ...o,
})

let ITEMS: Item[] = []
let ALIASES: Alias[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aliasQueries: any[] = []

beforeEach(() => {
  ITEMS = []
  ALIASES = []
  aliasQueries.length = 0
  prismaMock.inventoryItem = {
    // the query is where W4 lives for the fuzzy tiers — mimic it
    findMany: async () => ITEMS.filter(i => i.isActive && i.mergedIntoId == null && i.recipe?.type !== 'PREP').map(i => ({ ...i, ...chain })),
  }
  prismaMock.inventorySupplierPrice = { findMany: async () => [] }
  prismaMock.itemSupplierAlias = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: async (args: any) => {
      aliasQueries.push(args)
      const w = args.where
      let rows = ALIASES.filter(a => a.supplierId === w.supplierId)
      if (w.OR) {
        const texts: string[] = w.OR.find((c: { text?: unknown }) => c.text)?.text.in ?? []
        const codes: string[] = w.OR.find((c: { supplierItemCode?: unknown }) => c.supplierItemCode)?.supplierItemCode.in ?? []
        rows = rows.filter(a => texts.includes(a.text) || (a.supplierItemCode != null && codes.includes(a.supplierItemCode)))
      }
      if (w.inventoryItemId?.in) rows = rows.filter(a => w.inventoryItemId.in.includes(a.inventoryItemId))
      rows = [...rows].sort((a, b) => b.useCount - a.useCount || b.lastUsed.getTime() - a.lastUsed.getTime())
      if (args.include) {
        return rows.map(a => {
          const item = ITEMS.find(i => i.id === a.inventoryItemId)
          return { ...a, inventoryItem: item ? { ...item, ...chain } : null }
        })
      }
      return rows.map(a => ({ inventoryItemId: a.inventoryItemId, rawText: a.rawText }))
    },
  }
})

const line = (description: string, o: Partial<OcrLineItem> = {}): OcrLineItem => ({
  description, supplierItemCode: null, lineCategory: null,
  pricingMode: 'per_case', pricingModeSignal: 'explicit',
  qtyOrdered: 1, qtyOrderedUOM: 'cs', qtyShipped: 1, qtyShippedUOM: 'cs',
  packQty: null, packSize: null, packUOM: null,
  unitPrice: 10, rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
  isCatchweight: false, nominalWeight: null, lineTotal: 10, taxFlag: null, lineTaxAmount: null,
  ...o,
} as OcrLineItem)

describe('matchLineItems — tier 0: this supplier\'s alias by item code', () => {
  it('a code learned under supplier A matches HIGH on A\'s invoice', async () => {
    ITEMS = [it_('grapes', 'Red Grapes'), it_('kale', 'Kale')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'A', text: 'grape red seedless', supplierItemCode: '12345' })]
    const [r] = await matchLineItems([line('SOMETHING ELSE ENTIRELY', { supplierItemCode: '12345' })], 'Sysco', 'Sysco', 'A')
    expect(r).toMatchObject({ matchedItemId: 'grapes', matchConfidence: 'HIGH', matchScore: 100 })
  })

  it('the code is normalised (trim + upper) on both sides', async () => {
    ITEMS = [it_('grapes', 'Red Grapes')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'A', text: 'x', supplierItemCode: 'AB12' })]
    const [r] = await matchLineItems([line('ZZZ', { supplierItemCode: ' ab12 ' })], null, null, 'A')
    expect(r).toMatchObject({ matchedItemId: 'grapes', matchConfidence: 'HIGH' })
  })

  it('the same code learned under supplier B never matches on A\'s invoice', async () => {
    ITEMS = [it_('grapes', 'Red Grapes')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'B', text: 'grape red seedless', supplierItemCode: '12345' })]
    const [r] = await matchLineItems([line('ZZZ QQQ', { supplierItemCode: '12345' })], 'Sysco', 'Sysco', 'A')
    expect(r.matchedItemId).toBeNull()
    expect(r.matchConfidence).toBe('NONE')
  })

  it("carries the alias's learned pack as the line's format", async () => {
    ITEMS = [it_('grapes', 'Red Grapes')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'A', text: 'x', supplierItemCode: 'C1', packQty: 2, packSize: 500, packUOM: 'g' })]
    const [r] = await matchLineItems([line('ZZZ', { supplierItemCode: 'C1' })], null, null, 'A')
    expect(r).toMatchObject({ invoicePackQty: 2, invoicePackSize: 500, invoicePackUOM: 'g' })
  })
})

describe('matchLineItems — tier 1: this supplier\'s alias by wording', () => {
  it('matches HIGH through the normaliser (case and punctuation differences are one wording)', async () => {
    ITEMS = [it_('grapes', 'Red Grapes'), it_('kale', 'Kale')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'A', text: 'grape red seedless 2 lb' })]
    const [r] = await matchLineItems([line('GRAPE, RED SEEDLESS (2-LB)')], 'Sysco', 'Sysco', 'A')
    expect(r).toMatchObject({ matchedItemId: 'grapes', matchConfidence: 'HIGH', matchScore: 100 })
  })

  it('another supplier\'s wording does not match at tier 1', async () => {
    ITEMS = [it_('grapes', 'Red Grapes')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'B', text: 'zzq wording' })]
    const [r] = await matchLineItems([line('ZZQ WORDING')], null, null, 'A')
    expect(r.matchedItemId).toBeNull()
  })
})

describe('matchLineItems — W4: an alias whose item is inactive, merged or a prep output is ignored', () => {
  it.each([
    ['inactive', { isActive: false }],
    ['merged away', { mergedIntoId: 'survivor' }],
    ['a prep output', { recipe: { type: 'PREP' } }],
  ])('%s → the line falls through to fuzzy on names', async (_label, gone) => {
    ITEMS = [it_('old', 'Old Grapes', gone as Partial<Item>), it_('grapes', 'Grape Red Seedless')]
    ALIASES = [
      alias({ inventoryItemId: 'old', supplierId: 'A', text: 'grape red seedless', supplierItemCode: 'C9' }),
    ]
    const [byCode] = await matchLineItems([line('GRAPE RED SEEDLESS', { supplierItemCode: 'C9' })], null, null, 'A')
    expect(byCode.matchedItemId).toBe('grapes') // own-name fuzzy, never the dead item
    const [byText] = await matchLineItems([line('GRAPE RED SEEDLESS')], null, null, 'A')
    expect(byText.matchedItemId).toBe('grapes')
  })
})

describe('matchLineItems — tiers 2 and 3: fuzzy', () => {
  it("another supplier's alias never raises a fuzzy score: only names count", async () => {
    ITEMS = [it_('grapes', 'Red Grapes'), it_('mystery', 'Mystery Box')]
    // B taught "flame seedless jumbo" → mystery; A's invoice must not borrow it
    ALIASES = [alias({ inventoryItemId: 'mystery', supplierId: 'B', text: 'flame seedless jumbo pack' })]
    const [r] = await matchLineItems([line('FLAME SEEDLESS JUMBO')], null, null, 'A')
    expect(r.matchedItemId).not.toBe('mystery')
    // and the tier-3 read was scoped to A
    expect(aliasQueries.every(q => q.where.supplierId === 'A')).toBe(true)
  })

  it("this supplier's alias can win the fuzzy tier, but is MEDIUM at most", async () => {
    ITEMS = [it_('grapes', 'Red Grapes'), it_('kale', 'Kale')]
    ALIASES = [alias({ inventoryItemId: 'grapes', supplierId: 'A', text: 'flame seedless jumbo', rawText: 'FLAME SEEDLESS JUMBO' })]
    const [r] = await matchLineItems([line('FLAME SEEDLESS JUMBO 18LB')], null, null, 'A')
    expect(r.matchedItemId).toBe('grapes')
    expect(r.matchConfidence).toBe('MEDIUM')
  })

  it('a strong own-name match is HIGH', async () => {
    ITEMS = [it_('grapes', 'Red Grapes')]
    const [r] = await matchLineItems([line('RED GRAPES')], null, null, 'A')
    expect(r).toMatchObject({ matchedItemId: 'grapes', matchConfidence: 'HIGH' })
  })
})

describe('matchLineItems — no supplier on the session', () => {
  it('skips every alias tier: no alias read at all, names only', async () => {
    ITEMS = [it_('grapes', 'Red Grapes'), it_('mystery', 'Mystery Box')]
    ALIASES = [alias({ inventoryItemId: 'mystery', supplierId: 'A', text: 'zzq wording', supplierItemCode: 'C1' })]
    const [r] = await matchLineItems([line('ZZQ WORDING', { supplierItemCode: 'C1' })], 'Sysco', 'Sysco', null)
    expect(r.matchedItemId).toBeNull()
    expect(aliasQueries).toHaveLength(0)
  })
})
