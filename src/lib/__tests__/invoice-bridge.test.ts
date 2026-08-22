// The unit bridge on an invoice review line: a count↔measured gap is resolved by
// teaching the item what ONE each weighs/holds. The bridge unit therefore always
// belongs to the MEASURED side of the gap — a count unit ('each', 'cs') can never
// express it, and neither can a unit from the wrong measured dimension ('g' on a
// volume gap). Persisting one of those is a silent no-op (the inventory route
// refuses it), which leaves the line stuck on the same issue after Save.
//
// Fixtures below are real REVIEW lines pulled from the live database.

import { describe, it, expect } from 'vitest'
import {
  classifyDimensionRelationship, bridgeUnitOptions, isValidBridgeUnit,
} from '@/lib/invoice/classify'

const line = (over: Record<string, unknown>): any => ({
  id: 'l1', rawDescription: 'x', action: 'UPDATE_PRICE',
  pricingMode: 'per_case', rawQty: '1', rawUnit: 'each',
  invoicePackQty: null, invoicePackSize: null, invoicePackUOM: null,
  totalQty: null, totalQtyUOM: null, rate: null, rateUOM: null,
  qtyOrdered: null, qtyOrderedUOM: null, isCatchweight: false,
  matchConfidence: 'HIGH', matchScore: 100,
  ...over,
})

const item = (over: Record<string, unknown>) => ({
  id: 'i1', itemName: 'x', packChain: [{ unit: 'case', per: 1 }],
  pricing: { mode: 'PACK', purchasePrice: 10 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null,
  ...over,
})

// ── Sysco 444275258 "PAPER PARCHMENT SILICONE CDN" ───────────────────────────
// Billed by the case (COUNT) against an item tracked by weight (MASS).
const countLineOnMassItem = line({
  rawDescription: 'PAPER PARCHMENT SILICONE CDN',
  pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '1', invoicePackUOM: 'each',
  rawUnitPrice: '62.24', rawLineTotal: '62.24',
  matchedItem: item({ itemName: 'Parchment Paper', dimension: 'MASS', baseUnit: 'g', countUnit: 'case' }),
})

// ── Acecard 203872 "Beef Tomahawk Chop" ──────────────────────────────────────
// Billed by weight (MASS) against an item counted by the each — the invoice pack
// itself says what one each weighs, so the bridge can be pre-filled.
const massLineOnCountItem = line({
  rawDescription: 'Beef Tomahawk Chop AAA+ 31lb',
  pricingMode: 'per_weight', invoicePackQty: '1', invoicePackSize: '31', invoicePackUOM: 'lb',
  rate: '30.86', rateUOM: 'kg', totalQty: '31', totalQtyUOM: 'lb',
  matchedItem: item({ itemName: 'Beef Tomahawk', dimension: 'COUNT', baseUnit: 'each', countUnit: 'each' }),
})

describe('bridge unit vocabulary', () => {
  it('offers only units of the measured dimension', () => {
    expect(bridgeUnitOptions('MASS').every(u => isValidBridgeUnit(u, 'MASS'))).toBe(true)
    expect(bridgeUnitOptions('VOLUME').every(u => isValidBridgeUnit(u, 'VOLUME'))).toBe(true)
  })

  it('never offers oz on a volume bridge (oz is weight — fl oz is the volume unit)', () => {
    expect(bridgeUnitOptions('VOLUME')).not.toContain('oz')
    expect(bridgeUnitOptions('VOLUME')).toContain('fl oz')
  })

  it('rejects a count unit and a wrong-dimension unit', () => {
    expect(isValidBridgeUnit('each', 'MASS')).toBe(false)
    expect(isValidBridgeUnit('cs', 'MASS')).toBe(false)
    expect(isValidBridgeUnit('g', 'VOLUME')).toBe(false)
    expect(isValidBridgeUnit('lb', 'MASS')).toBe(true)
  })
})

describe('classifyDimensionRelationship — bridge prefill', () => {
  it('a count-priced line on a measured item does not prefill the count pack unit', () => {
    const rel = classifyDimensionRelationship(countLineOnMassItem)
    expect(rel.verdict).toBe('PACK_BRIDGE')
    // 'each' cannot express how much one each weighs — prefilling it produces a
    // Save that the inventory route silently drops.
    if (rel.verdict === 'PACK_BRIDGE') {
      expect(rel.perEach === null || isValidBridgeUnit(rel.perEach.unit, 'MASS')).toBe(true)
    }
  })

  it('a weight-priced line on a count item still prefills from the invoice pack', () => {
    const rel = classifyDimensionRelationship(massLineOnCountItem)
    expect(rel.verdict).toBe('PACK_BRIDGE')
    if (rel.verdict === 'PACK_BRIDGE') expect(rel.perEach).toEqual({ qty: 31, unit: 'lb' })
  })

  it('a stored bridge from the wrong measured dimension is not offered as the prefill', () => {
    const rel = classifyDimensionRelationship(line({
      pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '3.78', invoicePackUOM: 'l',
      matchedItem: item({
        dimension: 'COUNT', baseUnit: 'each', countUnit: 'each',
        eachMeasureQty: '150', eachMeasureUnit: 'g',   // mass bridge, volume invoice
      }),
    }))
    expect(rel.verdict).toBe('PACK_BRIDGE')
    if (rel.verdict === 'PACK_BRIDGE') {
      expect(rel.perEach === null || isValidBridgeUnit(rel.perEach.unit, 'VOLUME')).toBe(true)
    }
  })
})

// ── Sysco 444277688 "SANITIZER MIKRO KLENE" ──────────────────────────────────
// Billed by the 3.78 l case against an item tracked by weight — same liquid,
// bridged by density rather than by an each-measure.
const volumeLineOnMassItem = line({
  rawDescription: 'SANITIZER MIKRO KLENE CDN',
  pricingMode: 'per_case', invoicePackQty: '1', invoicePackSize: '3.78', invoicePackUOM: 'l',
  matchedItem: item({ itemName: 'Mikro Klene Sanitizer', dimension: 'MASS', baseUnit: 'g', countUnit: 'kg' }),
})

describe('classifyDimensionRelationship — after the bridge is saved', () => {
  it('clears a weight↔volume gap once the density is stored', () => {
    expect(classifyDimensionRelationship(volumeLineOnMassItem).verdict).toBe('DENSITY_BRIDGE')
    const saved = { ...volumeLineOnMassItem, matchedItem: { ...volumeLineOnMassItem.matchedItem, densityGPerMl: '1.02' } }
    expect(classifyDimensionRelationship(saved as any).verdict).toBe('IDENTICAL')
  })

  it('clears the issue in the forward direction (weight invoice on a count item)', () => {
    const saved = { ...massLineOnCountItem, matchedItem: { ...massLineOnCountItem.matchedItem, eachMeasureQty: '31', eachMeasureUnit: 'lb' } }
    expect(classifyDimensionRelationship(saved as any).verdict).toBe('IDENTICAL')
  })

  it('clears the issue in the reverse direction (count invoice on a weight item)', () => {
    const saved = { ...countLineOnMassItem, matchedItem: { ...countLineOnMassItem.matchedItem, eachMeasureQty: '0.9', eachMeasureUnit: 'lb' } }
    expect(classifyDimensionRelationship(saved as any).verdict).toBe('IDENTICAL')
  })
})
