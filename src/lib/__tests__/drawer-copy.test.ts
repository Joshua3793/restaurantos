import { describe, it, expect } from 'vitest'
import {
  recipeCostSentence, countValueSentence, badgeList, bridgeSentence, shortDay, priceEach, lastDeliveryDay,
  boxPriceText, packPriceLine, sortBoxes,
} from '@/lib/drawer-copy'

describe('priceEach', () => {
  it('a count item reads per each', () => {
    expect(priceEach(0.42, 'each')).toBe('$0.42 / each')
  })
  it('a weight item reads per kg, a volume item per L', () => {
    expect(priceEach(0.0125, 'g')).toBe('$12.50 / kg')
    expect(priceEach(0.004, 'ml')).toBe('$4.00 / L')
  })
})

describe('shortDay', () => {
  it('a day key reads "28 Sep"', () => {
    expect(shortDay('2026-09-28')).toBe('28 Sep')
    expect(shortDay('2026-01-05')).toBe('5 Jan')
  })
  it('an ISO timestamp uses its calendar day', () => {
    expect(shortDay('2026-09-28T00:00:00.000Z')).toBe('28 Sep')
  })
  it('anything else is passed through as written', () => {
    expect(shortDay('28 Sep')).toBe('28 Sep')
  })
})

describe('recipeCostSentence', () => {
  it('on the 30-day average: price, and how many deliveries it came from', () => {
    expect(recipeCostSentence({
      basis: 'AVG_30D', pricePerBase: 0.42,
      avg: { pricePerBase: 0.42, paid: 100, received: 238, lines: 4, excluded: 0 },
    }, 'each')).toBe('Recipes cost this at $0.42 / each (30-day average, 4 deliveries).')
  })
  it('one delivery is singular', () => {
    expect(recipeCostSentence({
      basis: 'AVG_30D', pricePerBase: 0.42,
      avg: { pricePerBase: 0.42, paid: 42, received: 100, lines: 1, excluded: 0 },
    }, 'each')).toBe('Recipes cost this at $0.42 / each (30-day average, 1 delivery).')
  })
  it('no deliveries in 30 days: the last price', () => {
    expect(recipeCostSentence({ basis: 'LAST', pricePerBase: 0.46, fallbackReason: 'no-purchases' }, 'each'))
      .toBe('Recipes cost this at $0.46 / each (no deliveries in 30 days — using the last price).')
  })
  it('deliveries that looked wrong: the last price', () => {
    expect(recipeCostSentence({
      basis: 'LAST', pricePerBase: 0.46, fallbackReason: 'implausible',
      avg: { pricePerBase: 46, paid: 46, received: 1, lines: 1, excluded: 0 },
    }, 'each')).toBe('Recipes cost this at $0.46 / each (the recent deliveries looked wrong, so the last price is used).')
  })
  it('a recipe-made item: its cost comes from the recipe', () => {
    expect(recipeCostSentence({ basis: 'LAST', pricePerBase: 0.01, fallbackReason: 'prep-linked' }, 'g'))
      .toBe('Cost comes from the recipe.')
  })
  it('a weight item reads per kg', () => {
    expect(recipeCostSentence({
      basis: 'AVG_30D', pricePerBase: 0.0125,
      avg: { pricePerBase: 0.0125, paid: 50, received: 4000, lines: 2, excluded: 0 },
    }, 'g')).toBe('Recipes cost this at $12.50 / kg (30-day average, 2 deliveries).')
  })
  it('no price at all: says what to do', () => {
    expect(recipeCostSentence({ basis: 'LAST', pricePerBase: 0, fallbackReason: 'no-purchases' }, 'each'))
      .toBe('Recipes cost this at $0.00 / each — it has no price yet. Add a supplier box, or set its price in Edit.')
  })
})

describe('countValueSentence', () => {
  it('last paid, the main supplier and the day', () => {
    expect(countValueSentence(0.46, 'each', 'Sysco', '2026-09-28'))
      .toBe('Counts value it at $0.46 / each (last paid, Sysco, 28 Sep).')
  })
  it('no delivery date: the date is left out', () => {
    expect(countValueSentence(0.46, 'each', 'Sysco', null))
      .toBe('Counts value it at $0.46 / each (last paid, Sysco).')
  })
  it('no supplier: the price was set by hand', () => {
    expect(countValueSentence(0.46, 'each', null, null))
      .toBe('Counts value it at $0.46 / each (last price set by hand).')
  })
  it('a recipe-made item: the recipe sets it', () => {
    expect(countValueSentence(0.0125, 'g', null, null, { recipeName: 'Short Rib Braise' }))
      .toBe('Counts value it at $12.50 / kg (the cost of the recipe Short Rib Braise).')
  })
  it('no price at all: says what to do', () => {
    expect(countValueSentence(0, 'each', null, null))
      .toBe('Counts value it at $0.00 / each — it has no price yet. Add a supplier box, or set its price in Edit.')
  })
})

describe('badgeList', () => {
  it('an ordinary item has no badges', () => {
    expect(badgeList({ isActive: true, isStocked: true, recipe: null })).toEqual([])
  })
  it('each exception is named', () => {
    expect(badgeList({ isActive: false, isStocked: true, recipe: null })).toEqual(['Inactive'])
    expect(badgeList({ isActive: true, isStocked: false, recipe: null })).toEqual(['Not stocked'])
    expect(badgeList({ isActive: true, isStocked: true, recipe: { id: 'r' } })).toEqual(['Recipe-made'])
  })
  it('several at once, in a fixed order', () => {
    expect(badgeList({ isActive: false, isStocked: false, recipe: { id: 'r' } }))
      .toEqual(['Inactive', 'Not stocked', 'Recipe-made'])
  })
  it('isStocked missing reads as stocked', () => {
    expect(badgeList({ isActive: true, isStocked: undefined as unknown as boolean, recipe: undefined })).toEqual([])
  })
})

describe('bridgeSentence', () => {
  it('both bridges, with how many recipes lean on the each-measure', () => {
    expect(bridgeSentence({ eachQty: 85, eachUnit: 'g', densityGPerMl: 1.03 }, 3))
      .toEqual(['1 each = 85 g · used by 3 recipes', '1 ml weighs 1.03 g'])
  })
  it('one recipe is singular; none leaves the count off', () => {
    expect(bridgeSentence({ eachQty: 85, eachUnit: 'g' }, 1)).toEqual(['1 each = 85 g · used by 1 recipe'])
    expect(bridgeSentence({ eachQty: 85, eachUnit: 'g' }, 0)).toEqual(['1 each = 85 g'])
  })
  it('an each-measure with no unit reads in grams', () => {
    expect(bridgeSentence({ eachQty: 120, eachUnit: null }, 0)).toEqual(['1 each = 120 g'])
  })
  it('long decimals are trimmed', () => {
    expect(bridgeSentence({ densityGPerMl: 0.91999999 }, 0)).toEqual(['1 ml weighs 0.92 g'])
  })
  it('no bridge → nothing', () => {
    expect(bridgeSentence({}, 0)).toEqual([])
    expect(bridgeSentence({ eachQty: 0, eachUnit: 'g', densityGPerMl: null }, 2)).toEqual([])
  })
})

describe('lastDeliveryDay', () => {
  const rows = [
    { dayKey: '2026-09-20', supplierName: 'Sysco' },
    { dayKey: '2026-09-28', supplierName: 'SYSCO Canada' },
    { dayKey: '2026-10-01', supplierName: 'Gordon Food Service' },
    { dayKey: null, supplierName: 'Sysco' },
  ]
  it("the main supplier's newest delivery, names matched loosely", () => {
    expect(lastDeliveryDay(rows, 'Sysco')).toBe('2026-09-28')
  })
  it("another supplier's deliveries never count", () => {
    expect(lastDeliveryDay(rows, 'Gordon Food Service')).toBe('2026-10-01')
    expect(lastDeliveryDay(rows, 'Fresh Start Foods')).toBeNull()
  })
  it('no supplier or no rows → null', () => {
    expect(lastDeliveryDay(rows, null)).toBeNull()
    expect(lastDeliveryDay([], 'Sysco')).toBeNull()
  })
})

describe('boxPriceText', () => {
  it('a pack price reads per its top pack', () => {
    expect(boxPriceText({ mode: 'PACK', purchasePrice: 59.63 }, [{ unit: 'case', per: 6 }, { unit: 'bag', per: 1000 }])).toBe('$59.63 per case')
    expect(boxPriceText({ mode: 'PACK', purchasePrice: '12.5' }, [{ unit: 'bag', per: 2000 }])).toBe('$12.50 per bag')
  })
  it('a rate reads per its own unit, tidied', () => {
    expect(boxPriceText({ mode: 'RATE', rate: 3.49, rateUnit: 'LB' }, [])).toBe('$3.49 / lb')
  })
  it('no pack falls back to "case"; no price reads $0.00', () => {
    expect(boxPriceText(null, null)).toBe('$0.00 per case')
  })
})

describe('packPriceLine', () => {
  it('says the price and what one top pack holds', () => {
    expect(packPriceLine({ mode: 'PACK', purchasePrice: 59.63 }, [{ unit: 'case', per: 6 }, { unit: 'bag', per: 1000 }], 'g'))
      .toBe('$59.63 per case · 1 case = 6,000 g')
  })
  it('a rate still says what one pack holds', () => {
    expect(packPriceLine({ mode: 'RATE', rate: 3.49, rateUnit: 'lb' }, [{ unit: 'case', per: 4535.92 }], 'g'))
      .toBe('$3.49 / lb · 1 case = 4,535.92 g')
  })
  it('a pack that is just the base unit leaves the second part off', () => {
    expect(packPriceLine({ mode: 'PACK', purchasePrice: 0.5 }, [{ unit: 'each', per: 1 }], 'each')).toBe('$0.50 per each')
    expect(packPriceLine({ mode: 'PACK', purchasePrice: 2 }, [], 'each')).toBe('$2.00 per case')
  })
})

describe('sortBoxes', () => {
  it('main box first, then cheapest per base unit, unpriced last', () => {
    const boxes = [
      { id: 'a', isPrimary: false, pricePerBaseUnit: 0 },
      { id: 'b', isPrimary: false, pricePerBaseUnit: 0.5 },
      { id: 'c', isPrimary: true, pricePerBaseUnit: 0.9 },
      { id: 'd', isPrimary: false, pricePerBaseUnit: 0.3 },
    ]
    expect(sortBoxes(boxes).map(b => b.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(boxes.map(b => b.id)).toEqual(['a', 'b', 'c', 'd']) // not mutated
  })
})
