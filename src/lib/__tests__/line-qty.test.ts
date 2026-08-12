import { describe, it, expect } from 'vitest'
import { lineReceivedBaseUnits, lineReceivedCountQty, type LineQtyInput } from '@/lib/invoice/line-qty'
import { asChainItem, type ChainItem } from '@/lib/item-model'

// Item shapes taken from real rows the 2026-08-11 receipt audit flagged.
const item = (over: Partial<Parameters<typeof asChainItem>[0]>): ChainItem =>
  asChainItem({
    dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }],
    pricing: { mode: 'PACK', purchasePrice: 10 },
    ...over,
  })

const line = (over: Partial<LineQtyInput>): LineQtyInput => ({ rawQty: 1, ...over })

describe('lineReceivedBaseUnits — RATE (per-weight) lines', () => {
  const bison = item({
    dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
    packChain: [{ unit: 'each', per: 1 }, { unit: 'each', per: 1000 }],
    pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' },
  })

  it('credits the billed weight when the line carries no container count', () => {
    // Cleveland Meats #1130: rawQty null, totalQty 41.025 kg, $1,025.63.
    // This returned 0 — the goods were paid for and never entered stock.
    expect(lineReceivedBaseUnits(line({ rawQty: null, totalQty: 41.025, totalQtyUOM: 'kg' }), bison))
      .toBeCloseTo(41_025)
  })

  it('falls back to the rate unit, then the priced unit, before the base unit', () => {
    // totalQtyUOM null used to default straight to the base unit, reading a
    // 20.51 kg delivery as 20.51 g — a 1000× under-credit.
    expect(lineReceivedBaseUnits(line({ rawQty: 20.51, totalQty: 20.51, totalQtyUOM: null }), bison))
      .toBeCloseTo(20_510)
    expect(lineReceivedBaseUnits(line({ rawQty: 3, totalQty: 3, totalQtyUOM: null, rateUOM: 'lb' }), bison))
      .toBeCloseTo(1360.776)
  })

  it('still honours an explicit billed unit over the priced unit', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: 2, totalQty: 2, totalQtyUOM: 'lb' }), bison))
      .toBeCloseTo(907.184)
  })

  it('falls through to the pack when a RATE line is billed in a container unit', () => {
    // "CS" is a known unit but has no fixed factor — it only resolves via a pack.
    const r = lineReceivedBaseUnits(
      line({ rawQty: 2, rawUnit: 'CS', invoicePackQty: 4, invoicePackSize: 500, invoicePackUOM: 'g' }),
      bison,
    )
    expect(r).toBeCloseTo(4000)
  })

  it('returns 0 only when there is neither a quantity nor a billed weight', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: null, totalQty: null }), bison)).toBe(0)
  })
})

describe('lineReceivedBaseUnits — cross-dimension packs', () => {
  it('does NOT pass a weight pack through as a count', () => {
    // Brioche Unsliced: 2 cases of 8 × 1100 g into an `each`-based item credited
    // 17,600 "each" because convertQty passes through across dimensions.
    const brioche = item({
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'cs',
      packChain: [{ unit: 'cs', per: 8 }],
      pricing: { mode: 'PACK', purchasePrice: 100 },
      eachMeasureQty: 1100, eachMeasureUnit: 'g',
    })
    const r = lineReceivedBaseUnits(
      line({ rawQty: 2, invoicePackQty: 8, invoicePackSize: 1100, invoicePackUOM: 'g' }),
      brioche,
    )
    expect(r).toBeCloseTo(16)          // 2 cases × 8 loaves, via the each-measure bridge
    expect(r).not.toBeCloseTo(17_600)
  })

  it('bridges weight → volume through the item density', () => {
    // Tomato Whole Peeled: 6 × 100 fl-oz read as weight oz credited 600 ml.
    const tomato = item({
      dimension: 'VOLUME', baseUnit: 'ml',
      packChain: [{ unit: 'case', per: 6 }, { unit: 'each', per: 2840 }],
      pricing: { mode: 'PACK', purchasePrice: 56 },
      densityGPerMl: 1,
    })
    const r = lineReceivedBaseUnits(
      line({ rawQty: 1, invoicePackQty: 6, invoicePackSize: 100, invoicePackUOM: 'oz' }),
      tomato,
    )
    expect(r).toBeCloseTo(17_009.7, 1)
    expect(r).not.toBeCloseTo(600)
  })

  it('falls back to the item chain when no bridge spans the gap', () => {
    // ENGLISH MUFFIN GF 4PK: 6 × 240 G into an `each` item with no each-measure.
    // Crediting 1,440 muffins is worse than trusting the item's own structure.
    const muffin = item({
      dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 6 }],
      pricing: { mode: 'PACK', purchasePrice: 40 },
    })
    const r = lineReceivedBaseUnits(
      line({ rawQty: 1, invoicePackQty: 6, invoicePackSize: 240, invoicePackUOM: 'G' }),
      muffin,
    )
    expect(r).toBeCloseTo(6)
    expect(r).not.toBeCloseTo(1440)
  })

  it('leaves same-dimension pack expansion untouched', () => {
    const salt = item({
      dimension: 'MASS', baseUnit: 'g',
      packChain: [{ unit: 'case', per: 9 }, { unit: 'each', per: 1360.78 }],
      pricing: { mode: 'PACK', purchasePrice: 111.97 },
    })
    expect(lineReceivedBaseUnits(
      line({ rawQty: 1, invoicePackQty: 9, invoicePackSize: 3, invoicePackUOM: 'lb' }),
      salt,
    )).toBeCloseTo(12_246.98, 1)
  })

  it('ignores an unknown pack unit rather than crediting it ×1', () => {
    const bun = item({
      dimension: 'COUNT', baseUnit: 'each',
      packChain: [{ unit: 'case', per: 96 }],
      pricing: { mode: 'PACK', purchasePrice: 41 },
    })
    // "85g" is not a unit token — the old code credited 8 × 85 = 680 each.
    expect(lineReceivedBaseUnits(
      line({ rawQty: 1, invoicePackQty: 8, invoicePackSize: 85, invoicePackUOM: '85g' }),
      bun,
    )).toBeCloseTo(96)
  })
})

describe('lineReceivedCountQty', () => {
  it('reports the receipt in the item’s count UOM', () => {
    const r = lineReceivedCountQty(
      { rawQty: 2, invoicePackQty: 1, invoicePackSize: 20, invoicePackUOM: 'kg' },
      { dimension: 'MASS', baseUnit: 'g', countUnit: 'case',
        packChain: [{ unit: 'case', per: 20_000 }],
        pricing: { mode: 'PACK', purchasePrice: 55 } },
    )
    expect(r.countUom).toBe('case')
    expect(r.qty).toBeCloseTo(2)
  })
})
