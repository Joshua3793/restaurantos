import { describe, it, expect } from 'vitest'
import {
  seesCountMoney, redactItemMoney, redactLineMoney, redactSessionMoney,
  redactAreaMoney, redactSummaryMoney,
} from '../count-redact'

const item = {
  id: 'i1', itemName: 'Butter', baseUnit: 'g', dimension: 'MASS',
  packChain: [{ unit: 'case', per: 11350 }], countUnit: 'case',
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  pricing: { mode: 'PACK', purchasePrice: 142.5 }, purchasePrice: '142.5',
  pricePerBaseUnit: 0.01256, stockOnHand: '4000', lastCountQty: '3000', parLevel: 2,
}
const line = {
  id: 'l1', countedQty: '2', selectedUom: 'case', countedQtyBase: '22700', expectedQty: '20000',
  variancePct: '13.5', varianceCost: '33.91', priceAtCount: '0.01256', inventoryItem: item,
}

describe('count money redaction', () => {
  it('only MANAGER and above see count money', () => {
    expect(seesCountMoney('STAFF')).toBe(false)
    expect(seesCountMoney('LEAD')).toBe(false)
    expect(seesCountMoney('MANAGER')).toBe(true)
    expect(seesCountMoney('ADMIN')).toBe(true)
    expect(seesCountMoney('OWNER')).toBe(true)
  })

  it('nulls the item price, legacy purchase price and computed $/base — and nothing the count converts through', () => {
    const r = redactItemMoney(item)
    expect(r.pricing).toBeNull()
    expect(r.purchasePrice).toBeNull()
    expect(r.pricePerBaseUnit).toBeNull()
    const { pricing: _a, purchasePrice: _b, pricePerBaseUnit: _c, ...rest } = item
    expect(r).toMatchObject(rest)
  })

  it('nulls the line price and $ variance, keeps quantities and the % variance, and redacts its item', () => {
    const r = redactLineMoney(line)
    expect(r.priceAtCount).toBeNull()
    expect(r.varianceCost).toBeNull()
    expect(r).toMatchObject({ countedQty: '2', selectedUom: 'case', countedQtyBase: '22700', expectedQty: '20000', variancePct: '13.5' })
    expect(r.inventoryItem.pricePerBaseUnit).toBeNull()
    expect(r.inventoryItem.packChain).toEqual(item.packChain)
  })

  it('never serializes a price anywhere in a redacted session', () => {
    const session = { id: 's1', totalCountedValue: '24945.95', lines: [line, { ...line, id: 'l2' }] }
    const r = redactSessionMoney(session)
    expect(r.totalCountedValue).toBeNull()
    const json = JSON.stringify(r)
    for (const v of ['24945.95', '142.5', '0.01256', '33.91']) expect(json).not.toContain(v)
  })

  it('does not invent keys a response never had', () => {
    expect(redactSessionMoney({ id: 's1', counts: { total: 3 } })).toEqual({ id: 's1', counts: { total: 3 } })
  })

  it('nulls area value + $ drift and summary $ totals, keeps the counts', () => {
    expect(redactAreaMoney({ id: 'a', itemCount: 9, onHandValue: 812.4, drift: 55 }))
      .toEqual({ id: 'a', itemCount: 9, onHandValue: null, drift: null })
    expect(redactSummaryMoney({ itemsUpdated: 5, totalValue: 900, totalVarianceCost: 40, largeVariances: 1 }))
      .toEqual({ itemsUpdated: 5, totalValue: null, totalVarianceCost: null, largeVariances: 1 })
  })

  it('does not mutate its input', () => {
    redactSessionMoney({ totalCountedValue: 1, lines: [line] })
    expect(line.priceAtCount).toBe('0.01256')
    expect(item.pricePerBaseUnit).toBe(0.01256)
  })
})
