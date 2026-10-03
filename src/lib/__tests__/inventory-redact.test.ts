import { describe, it, expect } from 'vitest'
import { seesItemMoney, canEditItems, redactInventoryItem, redactOffer, redactWastageLog } from '../inventory-redact'

const ITEM = {
  id: 'i1', itemName: 'Butter', baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], eachMeasureQty: null, densityGPerMl: null,
  pricing: { mode: 'PACK', purchasePrice: 142.5 }, purchasePrice: '142.5', pricePerBaseUnit: 0.01256,
  costBasis: { basis: 'AVG_30D', avg: { pricePerBase: 0.0131, paid: 297.4 } },
  stockOnHand: '20000',
  invoiceLineItems: [{ id: 'x', unitPrice: '142.5', lineTotal: '285', invoice: { totalAmount: '1903.22' } }],
  recipeIngredients: [{ id: 'ri1', qtyBase: 50, recipe: { id: 'r1', name: 'Croissant', menuPrice: '6.75' } }],
  recipe: null,
  supplier: { id: 's1', name: 'Gordon' },
}

describe('inventory money + edit gates', () => {
  it('LEAD and up see prices; STAFF does not', () => {
    expect(seesItemMoney('STAFF')).toBe(false)
    for (const r of ['LEAD', 'MANAGER', 'ADMIN', 'OWNER'] as const) expect(seesItemMoney(r)).toBe(true)
  })

  it('only MANAGER and up may edit items', () => {
    expect(canEditItems('STAFF')).toBe(false)
    expect(canEditItems('LEAD')).toBe(false)
    for (const r of ['MANAGER', 'ADMIN', 'OWNER'] as const) expect(canEditItems(r)).toBe(true)
  })

  it('strips every price from an item and its relations, keeps what a count converts through', () => {
    const r = redactInventoryItem(ITEM) as Record<string, unknown>
    for (const v of ['142.5', '0.01256', '0.0131', '297.4', '285', '1903.22', '6.75']) {
      expect(JSON.stringify(r)).not.toContain(v)
    }
    expect(r).toMatchObject({ pricing: null, purchasePrice: null, pricePerBaseUnit: null, costBasis: null, invoiceLineItems: [] })
    expect(r).toMatchObject({ packChain: ITEM.packChain, baseUnit: 'g', countUnit: 'case', stockOnHand: '20000', supplier: ITEM.supplier })
    expect((r.recipeIngredients as { recipe: { name: string } }[])[0].recipe.name).toBe('Croissant')
  })

  it('strips an offer price and its history, keeps the supplier and its pack', () => {
    const offer = {
      id: 'o1', supplierName: 'Gordon', isPrimary: true, lastPrice: 142.5, pricePerBaseUnit: 0.01256,
      pricing: { mode: 'PACK', purchasePrice: 142.5 }, packChain: [{ unit: 'case', per: 11350 }],
      supplierItemCode: 'B-1', volatility: 0.04, stability: 'stable', history: [{ date: '2026-09-01', ppb: 0.0125 }],
    }
    const r = redactOffer(offer)
    expect(r).toMatchObject({ lastPrice: null, pricePerBaseUnit: null, pricing: null, volatility: null, stability: null, history: [] })
    expect(r).toMatchObject({ supplierName: 'Gordon', isPrimary: true, supplierItemCode: 'B-1', packChain: offer.packChain })
  })

  it('strips a wastage log cost and its item price, keeps what was wasted', () => {
    const log = { id: 'w1', qtyWasted: '500', unit: 'g', reason: 'SPOILED', costImpact: '6.28', inventoryItem: ITEM }
    const r = redactWastageLog(log) as Record<string, unknown>
    for (const v of ['6.28', '142.5', '0.01256']) expect(JSON.stringify(r)).not.toContain(v)
    expect(r).toMatchObject({ costImpact: null, qtyWasted: '500', unit: 'g', reason: 'SPOILED' })
    expect((r.inventoryItem as { itemName: string }).itemName).toBe('Butter')
  })

  it('does not mutate its input', () => {
    redactInventoryItem(ITEM)
    expect(ITEM.pricePerBaseUnit).toBe(0.01256)
    expect(ITEM.invoiceLineItems).toHaveLength(1)
  })
})
