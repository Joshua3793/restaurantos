import { describe, it, expect } from 'vitest'
import { lineReceivedBaseUnits, lineReceivedCountQty, lineReceived, billedWeightIsPriced, type LineQtyInput } from '@/lib/invoice/line-qty'
import { matchedLikeOf } from '@/lib/invoice/matched-like'
import { resolveLineFormat, pickOffer, type SupplierRef } from '@/lib/invoice/line-format'
import { liveLineOf, offerForSupplier } from '@/lib/invoice/resolution'
import { asChainItem, type ChainItem } from '@/lib/item-model'
import type { ScanItem } from '@/components/invoices/types'

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

describe('frozen receipts and supplier offers', () => {
  const romaine = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 4 }, { unit: 'pack', per: 12 }],
  })

  it('a frozen receivedQtyBase wins over every live rule', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: '24' }), romaine)).toBe(24)
  })
  it('a null or zero frozen value computes live', () => {
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: null }), romaine)).toBe(96)
    expect(lineReceivedBaseUnits(line({ rawQty: 2, receivedQtyBase: 0 }), romaine)).toBe(96)
  })
  it('lineReceivedCountQty reads the line through the supplier offer', () => {
    const matched = { dimension: 'COUNT', baseUnit: 'each', packChain: romaine.packChain, pricing: romaine.pricing, countUnit: 'each' }
    expect(lineReceivedCountQty(line({ rawQty: 2 }), matched).qty).toBe(96)
    expect(lineReceivedCountQty(line({ rawQty: 2 }), matched, { packChain: [{ unit: 'case', per: 12 }] }).qty).toBe(24)
  })
})

describe('line-first receiving — real lines from the 2026-09-20 audit', () => {
  // COUNT item, 24 each/case, 1 each ≈ 0.4 lb (181.4368 g)
  const eggplant = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
    eachMeasureQty: 181.4368, eachMeasureUnit: 'g',
  })
  const eggplantNoBridge = item({
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
  })
  const sausage = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 7000 }], pricing: { mode: 'PACK', purchasePrice: 60 } })
  const butter  = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 120 } })
  const zucchini = item({ dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'lb', per: 250 }], pricing: { mode: 'PACK', purchasePrice: 19.96 } })

  it('shipped unit is a weight on a COUNT item → bridged through the each-measure', () => {
    const r = lineReceived(line({ rawQty: 12, rawUnit: 'lb', totalQty: 12, totalQtyUOM: 'lb', rate: 3.49, rateUOM: 'lb', rawUnitPrice: 3.49, rawLineTotal: 41.88 }), eggplant)
    expect(r.base).toBeCloseTo(30, 1)          // was 12 × 24 = 288
    expect(r.needsBridge).toBe(false)
    expect(r.via).toBe('billed-weight')   // $3.49/lb × 12 lb = $41.88: the printed rate proves it
  })

  it('same line, item has NO each-measure → today’s value, needsBridge', () => {
    const r = lineReceived(line({ rawQty: 12, rawUnit: 'lb', totalQty: 12, totalQtyUOM: 'lb', rate: 3.49, rateUOM: 'lb', rawUnitPrice: 3.49, rawLineTotal: 41.88 }), eggplantNoBridge)
    expect(r).toEqual({ base: 288, via: 'item-pack', needsBridge: true })
  })

  it('cases + a billed weight the money proves → the billed weight', () => {
    const r = lineReceived(line({ rawQty: 2, rawUnit: 'CS', totalQty: 14.6, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawUnitPrice: 8.5, rawLineTotal: 124.1, invoicePackQty: 1, invoicePackSize: 7, invoicePackUOM: 'kg' }), sausage)
    expect(r).toEqual({ base: 14600, via: 'billed-weight', needsBridge: false })   // was 14,000 nominal
  })

  it('a mis-scanned printed pack does not matter when the money proves the weight', () => {
    const r = lineReceived(line({ rawQty: 4, rawUnit: 'CS', totalQty: 28.7, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawLineTotal: 243.95, invoicePackQty: 1, invoicePackSize: 1, invoicePackUOM: 'kg' }), sausage)
    expect(r.base).toBe(28700)
    expect(r.via).toBe('billed-weight')
  })

  it('per-weight line on a PACK-priced offer (zucchini: 1 ea, billed 3.02 kg)', () => {
    const r = lineReceived(line({ rawQty: 1, rawUnit: 'ea', totalQty: 3.02, totalQtyUOM: 'kg', rate: 6.61, rateUOM: 'kg', rawUnitPrice: 19.96, rawLineTotal: 19.96 }), zucchini)
    // unitPrice (19.96) is DERIVED = total ÷ 1 ea, so 'price × cases = total' proves nothing.
    // The printed rate does: $6.61/kg × 3.02 kg = $19.96.
    expect(r).toEqual({ base: 3020, via: 'billed-weight', needsBridge: false })
  })

  it('…and the same line once rawUnitPrice is the RATE, not the line total, resolves by weight', () => {
    const r = lineReceived(line({ rawQty: 1, rawUnit: 'ea', totalQty: 3.02, totalQtyUOM: 'kg', rate: 6.61, rateUOM: 'kg', rawUnitPrice: 6.61, rawLineTotal: 19.96 }), zucchini)
    expect(r).toEqual({ base: 3020, via: 'billed-weight', needsBridge: false })
  })

  it('Sysco per-case line with a bogus billed-weight column keeps the pack (Butter)', () => {
    const r = lineReceived(line({ rawQty: 2, rawUnit: 'CS', totalQty: 2.86, totalQtyUOM: 'kg', rawUnitPrice: 172.79, rawLineTotal: 345.58, invoicePackQty: 25, invoicePackSize: 454, invoicePackUOM: 'g' }), butter)
    expect(r).toEqual({ base: 22700, via: 'printed-pack', needsBridge: false })
  })

  it('rate unit differs from the billed unit but shares its dimension → converted before the money check', () => {
    // $8.50/kg, billed 32.19 lb (= 14.6 kg) → 124.10
    expect(billedWeightIsPriced(line({ rawQty: 2, rawUnit: 'CS', totalQty: 32.187, totalQtyUOM: 'lb', rate: 8.5, rateUOM: 'kg', rawLineTotal: 124.1 }))).toBe(true)
  })

  it('billedWeightIsPriced refuses: no total, no price, count unit, cross-dimension rate, both reconcile', () => {
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rate: 2 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rawLineTotal: 10 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'each', rate: 2, rawLineTotal: 10 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 5, totalQtyUOM: 'kg', rate: 2, rateUOM: 'l', rawLineTotal: 10 }))).toBe(false)
    // no printed rate → rawUnitPrice stands in, and then 'price × cases' reconciling too IS ambiguous
    expect(billedWeightIsPriced(line({ rawQty: 5, totalQty: 5, totalQtyUOM: 'kg', rawUnitPrice: 2, rawLineTotal: 10 }))).toBe(false)
  })

  it('regression locks: frozen wins; a RATE item still prefers the billed weight over the shipped qty', () => {
    expect(lineReceived(line({ rawQty: 2, receivedQtyBase: '24' }), sausage)).toEqual({ base: 24, via: 'frozen', needsBridge: false })
    const bison = item({ dimension: 'MASS', baseUnit: 'g', countUnit: 'kg', packChain: [{ unit: 'each', per: 1 }, { unit: 'each', per: 1000 }], pricing: { mode: 'RATE', rate: 25, rateUnit: 'kg' } })
    // ordered 10 kg, billed 10.4 kg, NO line total → the money cannot speak → RATE branch, billed first
    expect(lineReceived(line({ rawQty: 10, rawUnit: 'kg', totalQty: 10.4, totalQtyUOM: 'kg' }), bison)).toEqual({ base: 10400, via: 'rate', needsBridge: false })
    // unit-less billed weight still resolves through the priced unit
    expect(lineReceived(line({ rawQty: null, totalQty: 41.025 }), bison).base).toBeCloseTo(41025)
  })

  it('a PRINTED rate is proof on its own — the derived unit price reconciling by case is a tautology', () => {
    // Real line (Acecard sausage): 2 CS, unitPrice 116.435 = 232.87 ÷ 2 (derived by the scanner),
    // rate $15.95/kg read off the page, billed 14.6 kg → 15.95 × 14.6 = 232.87.
    const l = line({ rawQty: 2, rawUnit: 'CS', rawUnitPrice: 116.435, totalQty: 14.6, totalQtyUOM: 'kg', rate: 15.95, rateUOM: 'kg', rawLineTotal: 232.87, invoicePackQty: 1, invoicePackSize: 7, invoicePackUOM: 'kg' })
    expect(billedWeightIsPriced(l)).toBe(true)
    expect(lineReceived(l, sausage)).toEqual({ base: 14600, via: 'billed-weight', needsBridge: false })
  })

  it('a printed rate that does NOT reproduce the total proves nothing (Butter keeps its pack)', () => {
    const l = line({ rawQty: 2, rawUnit: 'CS', rawUnitPrice: 172.79, totalQty: 2.86, totalQtyUOM: 'kg', rate: 7.61, rateUOM: 'kg', rawLineTotal: 345.58, invoicePackQty: 25, invoicePackSize: 454, invoicePackUOM: 'g' })
    expect(billedWeightIsPriced(l)).toBe(false)
    expect(lineReceived(l, butter).via).toBe('printed-pack')
  })

  it('a rate quoted per CASE (or any unit that is not a weight/volume) can never prove a billed weight', () => {
    // $62.05 per CS × 14.6 "kg" would be nonsense arithmetic; the guard must refuse before multiplying.
    expect(billedWeightIsPriced(line({ rawQty: 2, rawUnit: 'CS', totalQty: 2, totalQtyUOM: 'kg', rate: 62.05, rateUOM: 'CS', rawLineTotal: 124.1 }))).toBe(false)
    expect(billedWeightIsPriced(line({ totalQty: 2, totalQtyUOM: 'kg', rate: 62.05, rateUOM: 'widget', rawLineTotal: 124.1 }))).toBe(false)
  })

  it('ORDER: a billed weight proven by the money beats a shipped quantity in a weight unit', () => {
    // ordered 14 kg, caught 14.6 kg, priced on the caught weight — PACK item, so the RATE branch is not in play
    const r = lineReceived(line({ rawQty: 14, rawUnit: 'kg', totalQty: 14.6, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawLineTotal: 124.1 }), sausage)
    expect(r).toEqual({ base: 14600, via: 'billed-weight', needsBridge: false })
  })

  it('lineReceivedBaseUnits is lineReceived().base for every shape above', () => {
    const l = line({ rawQty: 2, rawUnit: 'CS', totalQty: 14.6, totalQtyUOM: 'kg', rate: 8.5, rateUOM: 'kg', rawLineTotal: 124.1 })
    expect(lineReceivedBaseUnits(l, sausage)).toBe(lineReceived(l, sausage).base)
  })
})

describe('lineReceivedCountQty carries the item bridges and the provenance', () => {
  const matched = {
    dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
    packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 70.3 },
    eachMeasureQty: '181.4368', eachMeasureUnit: 'g',     // Decimal arrives as a string
  }
  const lb12 = { rawQty: '12', rawUnit: 'lb', totalQty: '12', totalQtyUOM: 'lb', rate: '3.49', rateUOM: 'lb', rawUnitPrice: '3.49', rawLineTotal: '41.88' }

  it('bridges a weight line to a COUNT item on the client exactly as the server does', () => {
    const r = lineReceivedCountQty(lb12, matched)
    expect(r.qty).toBeCloseTo(30, 1)
    expect(r.countUom).toBe('each')
    expect(r.needsBridge).toBe(false)
  })
  it('without the bridge fields it falls back and says so', () => {
    const { eachMeasureQty: _q, eachMeasureUnit: _u, ...bare } = matched
    const r = lineReceivedCountQty(lb12, bare)
    expect(r.qty).toBe(288)
    expect(r.needsBridge).toBe(true)
  })
})

describe('client and server agree — genuinely independent build paths', () => {
  // The client and server build their LineQtyInput from completely different
  // starting shapes and different code:
  //   server — a raw Prisma-row-like object, Decimal-stringified field-by-field
  //            exactly as buildPurchaseMap (count-expected.ts) does, resolved via
  //            resolveLineFormat(asChainItem(matchedItem), pickOffer(...)).
  //   client — a genuine ScanItem literal (string fields, every OTHER ScanItem
  //            field a real line carries) with matchedItem an InventoryMatch
  //            literal (incl. supplierPrices), pushed straight through
  //            liveLineOf → lineReceivedCountQty(…, matchedLikeOf(item.matchedItem),
  //            offerForSupplier(item, ref)) exactly as card.tsx's `received` does.
  // No helper is shared between the two builds — sharing one is exactly the bug
  // this test exists to catch (a helper that "agrees with itself" proves nothing).

  it('sausage: 2 CS, billed 14.6 kg, rate 8.5/kg, total 124.10 — MASS item, base g, countUnit kg, no offer', () => {
    // ── server: a Prisma-row-like object, field-by-field as buildPurchaseMap builds it ──
    const si = {
      receivedQtyBase: null as number | null,
      rawQty: 2, rawUnit: 'CS',
      totalQty: 14.6, totalQtyUOM: 'kg',
      rateUOM: 'kg',
      invoicePackQty: 1, invoicePackSize: 7, invoicePackUOM: 'kg',
      rawUnitPrice: 8.5, rate: 8.5, rawLineTotal: 124.10,
    }
    const matchedItemRow = {
      dimension: 'MASS', baseUnit: 'g', countUnit: 'kg',
      packChain: [{ unit: 'case', per: 7000 }],
      pricing: { mode: 'PACK', purchasePrice: 60 },
      supplierPrices: [] as Array<{ supplierId: string | null; supplierName: string; packChain: unknown; pricing: unknown }>,
    }
    const session = { supplierId: null as string | null, supplierName: null as string | null, supplier: null as { name: string } | null }
    const serverBase = lineReceivedBaseUnits(
      {
        receivedQtyBase: si.receivedQtyBase?.toString() ?? null,
        rawQty: si.rawQty?.toString() ?? null,
        rawUnit: si.rawUnit,
        totalQty: si.totalQty?.toString() ?? null,
        totalQtyUOM: si.totalQtyUOM,
        rateUOM: si.rateUOM,
        invoicePackQty: si.invoicePackQty?.toString() ?? null,
        invoicePackSize: si.invoicePackSize?.toString() ?? null,
        invoicePackUOM: si.invoicePackUOM,
        rawUnitPrice: si.rawUnitPrice?.toString() ?? null,
        rate: si.rate?.toString() ?? null,
        rawLineTotal: si.rawLineTotal?.toString() ?? null,
      },
      resolveLineFormat(
        asChainItem(matchedItemRow),
        pickOffer(matchedItemRow.supplierPrices, {
          supplierId: session.supplierId, supplierName: session.supplierName, canonicalName: session.supplier?.name ?? null,
        }),
      ),
    )
    expect(serverBase).toBeCloseTo(14600, 1)

    // ── client: a genuine ScanItem literal, through liveLineOf/matchedLikeOf/offerForSupplier ──
    const scanItem: ScanItem = {
      id: 'scan-sausage', rawDescription: 'SAUSAGE ITALIAN 7KG', rawQty: '2', rawUnit: 'CS',
      rawUnitPrice: '8.5', rawLineTotal: '124.10',
      matchedItemId: 'item-sausage',
      matchedItem: {
        id: 'item-sausage', itemName: 'Sausage', pricePerBaseUnit: '0.0086', purchasePrice: '60',
        baseUnit: 'g', dimension: 'MASS', countUnit: 'kg',
        packChain: [{ unit: 'case', per: 7000 }],
        pricing: { mode: 'PACK', purchasePrice: 60 },
        supplierPrices: [],
      },
      matchConfidence: 'HIGH', matchScore: 100, action: 'UPDATE_PRICE', approved: false,
      isNewItem: false, newItemData: null, previousPrice: null, newPrice: null, priceDiffPct: null,
      invoicePackQty: '1', invoicePackSize: '7', invoicePackUOM: 'kg',
      totalQty: '14.6', totalQtyUOM: 'kg', sortOrder: 0,
      rate: '8.5', rateUOM: 'kg',
      receivedQtyBase: null,
    }
    const ref: SupplierRef = { supplierId: null, supplierName: null, canonicalName: null }
    const clientResult = lineReceivedCountQty(liveLineOf(scanItem), matchedLikeOf(scanItem.matchedItem!), offerForSupplier(scanItem, ref))
    const clientBase = clientResult.qty * 1000 // countUom 'kg' → g

    expect(clientBase).toBeCloseTo(serverBase, 1)
  })

  it('eggplant: 12 lb @ 3.49, total 41.88 — COUNT item 24/case, each-measure 181.4368 g, no offer', () => {
    const si = {
      receivedQtyBase: null as number | null,
      rawQty: 12, rawUnit: 'lb',
      totalQty: 12, totalQtyUOM: 'lb',
      rateUOM: 'lb',
      invoicePackQty: null as number | null, invoicePackSize: null as number | null, invoicePackUOM: null as string | null,
      rawUnitPrice: 3.49, rate: 3.49, rawLineTotal: 41.88,
    }
    const matchedItemRow = {
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
      packChain: [{ unit: 'case', per: 24 }],
      pricing: { mode: 'PACK', purchasePrice: 70.3 },
      eachMeasureQty: 181.4368, eachMeasureUnit: 'g',
      supplierPrices: [] as Array<{ supplierId: string | null; supplierName: string; packChain: unknown; pricing: unknown }>,
    }
    const session = { supplierId: null as string | null, supplierName: null as string | null, supplier: null as { name: string } | null }
    const serverBase = lineReceivedBaseUnits(
      {
        receivedQtyBase: si.receivedQtyBase?.toString() ?? null,
        rawQty: si.rawQty?.toString() ?? null,
        rawUnit: si.rawUnit,
        totalQty: si.totalQty?.toString() ?? null,
        totalQtyUOM: si.totalQtyUOM,
        rateUOM: si.rateUOM,
        invoicePackQty: si.invoicePackQty?.toString() ?? null,
        invoicePackSize: si.invoicePackSize?.toString() ?? null,
        invoicePackUOM: si.invoicePackUOM,
        rawUnitPrice: si.rawUnitPrice?.toString() ?? null,
        rate: si.rate?.toString() ?? null,
        rawLineTotal: si.rawLineTotal?.toString() ?? null,
      },
      resolveLineFormat(
        asChainItem(matchedItemRow),
        pickOffer(matchedItemRow.supplierPrices, {
          supplierId: session.supplierId, supplierName: session.supplierName, canonicalName: session.supplier?.name ?? null,
        }),
      ),
    )

    const scanItem: ScanItem = {
      id: 'scan-eggplant', rawDescription: 'EGGPLANT ITALIAN', rawQty: '12', rawUnit: 'lb',
      rawUnitPrice: '3.49', rawLineTotal: '41.88',
      matchedItemId: 'item-eggplant',
      matchedItem: {
        id: 'item-eggplant', itemName: 'Eggplant', pricePerBaseUnit: '2.93', purchasePrice: '70.3',
        baseUnit: 'each', dimension: 'COUNT', countUnit: 'each',
        packChain: [{ unit: 'case', per: 24 }],
        pricing: { mode: 'PACK', purchasePrice: 70.3 },
        eachMeasureQty: '181.4368', eachMeasureUnit: 'g',
        supplierPrices: [],
      },
      matchConfidence: 'HIGH', matchScore: 100, action: 'UPDATE_PRICE', approved: false,
      isNewItem: false, newItemData: null, previousPrice: null, newPrice: null, priceDiffPct: null,
      invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
      totalQty: '12', totalQtyUOM: 'lb', sortOrder: 1,
      rate: '3.49', rateUOM: 'lb',
      receivedQtyBase: null,
    }
    const ref: SupplierRef = { supplierId: null, supplierName: null, canonicalName: null }
    const clientResult = lineReceivedCountQty(liveLineOf(scanItem), matchedLikeOf(scanItem.matchedItem!), offerForSupplier(scanItem, ref))
    const clientBase = clientResult.qty // countUom 'each' === base unit 'each'

    expect(clientBase).toBeCloseTo(serverBase, 1)
  })

  it('romaine: the SUPPLIER OFFER pack (12/case) differs from the item\'s own primary pack (48/case) — both sides must resolve through the offer', () => {
    // Item's PRIMARY pack: 4 cases-of-12 = 48 each/case. This line's supplier is
    // NOT primary — its own offer sells 12 each/case flat. Exercises the offer
    // half of resolveLineFormat / offerForSupplier on both sides.
    const si = {
      receivedQtyBase: null as number | null,
      rawQty: 2, rawUnit: 'case',
      totalQty: null as number | null, totalQtyUOM: null as string | null,
      rateUOM: null as string | null,
      invoicePackQty: null as number | null, invoicePackSize: null as number | null, invoicePackUOM: null as string | null,
      rawUnitPrice: 30, rate: null as number | null, rawLineTotal: 60,
    }
    const matchedItemRow = {
      dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
      packChain: [{ unit: 'case', per: 48 }],
      pricing: { mode: 'PACK', purchasePrice: 100 },
      supplierPrices: [
        { supplierId: 'sup-b', supplierName: 'Supplier B', packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 30 } },
      ],
    }
    const session = { supplierId: 'sup-b', supplierName: 'Supplier B', supplier: { name: 'Supplier B' } }
    const serverBase = lineReceivedBaseUnits(
      {
        receivedQtyBase: si.receivedQtyBase?.toString() ?? null,
        rawQty: si.rawQty?.toString() ?? null,
        rawUnit: si.rawUnit,
        totalQty: si.totalQty?.toString() ?? null,
        totalQtyUOM: si.totalQtyUOM,
        rateUOM: si.rateUOM,
        invoicePackQty: si.invoicePackQty?.toString() ?? null,
        invoicePackSize: si.invoicePackSize?.toString() ?? null,
        invoicePackUOM: si.invoicePackUOM,
        rawUnitPrice: si.rawUnitPrice?.toString() ?? null,
        rate: si.rate?.toString() ?? null,
        rawLineTotal: si.rawLineTotal?.toString() ?? null,
      },
      resolveLineFormat(
        asChainItem(matchedItemRow),
        pickOffer(matchedItemRow.supplierPrices, {
          supplierId: session.supplierId, supplierName: session.supplierName, canonicalName: session.supplier?.name ?? null,
        }),
      ),
    )
    // 2 cases × 12 each (the OFFER's pack, not the item's 48) = 24.
    expect(serverBase).toBeCloseTo(24, 5)

    const scanItem: ScanItem = {
      id: 'scan-romaine', rawDescription: 'ROMAINE HEARTS', rawQty: '2', rawUnit: 'case',
      rawUnitPrice: '30', rawLineTotal: '60',
      matchedItemId: 'item-romaine',
      matchedItem: {
        id: 'item-romaine', itemName: 'Romaine', pricePerBaseUnit: '2.08', purchasePrice: '100',
        baseUnit: 'each', dimension: 'COUNT', countUnit: 'each',
        packChain: [{ unit: 'case', per: 48 }],
        pricing: { mode: 'PACK', purchasePrice: 100 },
        supplierPrices: [
          { id: 'offer-1', supplierId: 'sup-b', supplierName: 'Supplier B', lastPrice: '30', pricePerBaseUnit: '2.5',
            packQty: null, packSize: null, packUOM: null, isPrimary: false,
            packChain: [{ unit: 'case', per: 12 }], pricing: { mode: 'PACK', purchasePrice: 30 } },
        ],
      },
      matchConfidence: 'HIGH', matchScore: 100, action: 'UPDATE_PRICE', approved: false,
      isNewItem: false, newItemData: null, previousPrice: null, newPrice: null, priceDiffPct: null,
      invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
      totalQty: null, totalQtyUOM: null, sortOrder: 2,
      receivedQtyBase: null,
    }
    const ref: SupplierRef = { supplierId: 'sup-b', supplierName: 'Supplier B', canonicalName: 'Supplier B' }
    const clientResult = lineReceivedCountQty(liveLineOf(scanItem), matchedLikeOf(scanItem.matchedItem!), offerForSupplier(scanItem, ref))

    expect(clientResult.qty).toBeCloseTo(serverBase, 5)   // countUom 'each' === base unit 'each'
    expect(clientResult.qty).not.toBeCloseTo(96, 1)        // the item's OWN pack (2 × 48) would be wrong
  })
})
