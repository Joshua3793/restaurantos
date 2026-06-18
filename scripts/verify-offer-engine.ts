// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/verify-offer-engine.ts
import { buildOffer, reconcileOffer, type OfferInput } from '../src/lib/invoice/offer'
import { asChainItem } from '../src/lib/item-model'

let failures = 0
function check(label: string, pass: boolean, detail?: string) {
  if (pass) {
    console.log(`  PASS  ${label}`)
  } else {
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
    failures++
  }
}

// ─── Fixture 1: ketchup ───────────────────────────────────────────────────────
// Per-case · 12×1L @ $48/cs → newPpb = 48 / (12 × 1000ml) = 0.004 $/ml
console.log('\n[ketchup] Per-case · clean match')
{
  const input: OfferInput = {
    pricingMode: 'per_case',
    qtyShipped: 1, qtyShippedUOM: 'CS',
    packQty: 12, packSize: 1, packUOM: 'L',
    unitPrice: 48.00,
    rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
    isCatchweight: false,
  }
  const matchedRaw = {
    dimension: 'VOLUME', baseUnit: 'ml',
    packChain: [{ unit: 'case', per: 12 }, { unit: 'bottle', per: 1000 }],
    pricing: { mode: 'PACK', purchasePrice: 48 },
    countUnit: undefined, stockOnHand: 9000,
  }
  const offer = buildOffer(input)
  const matched = asChainItem(matchedRaw)
  const result = reconcileOffer(offer, matched)

  check('dimension = VOLUME', offer.dimension === 'VOLUME')
  check('baseUnit = ml', offer.baseUnit === 'ml')
  check('newPpb ≈ 0.004', Math.abs(result.newPpb - 0.004) < 0.0001,
    `got ${result.newPpb}`)
  check('status = MATCH', result.status === 'MATCH', `got ${result.status}`)
  check('|deltaPct| < 1', result.deltaPct != null && Math.abs(result.deltaPct) < 1,
    `got ${result.deltaPct}`)
  check('dimensionConflict = false', result.dimensionConflict === false)
}

// ─── Fixture 2: ribeye ───────────────────────────────────────────────────────
// Per-weight · rate $28.60/kg, totalQty 7.40kg
// newPpb = 28.60 / 1000 = 0.0286 $/g
// oldPpb (matched RATE $27.90/kg) = 27.90 / 1000 = 0.0279 $/g
// deltaPct ≈ +2.508% → MATCH (under 5% threshold)
console.log('\n[ribeye] Per-weight · catchweight')
{
  const input: OfferInput = {
    pricingMode: 'per_weight',
    qtyShipped: 1, qtyShippedUOM: 'CS',
    packQty: 1, packSize: 9, packUOM: 'kg',
    unitPrice: 211.64,
    rate: 28.60, rateUOM: 'kg', totalQty: 7.40, totalQtyUOM: 'kg',
    isCatchweight: true,
  }
  const matchedRaw = {
    dimension: 'MASS', baseUnit: 'g',
    packChain: [{ unit: 'case', per: 9000 }],
    pricing: { mode: 'RATE', rate: 27.90, rateUnit: 'kg' },
    countUnit: undefined, stockOnHand: 4200,
  }
  const offer = buildOffer(input)
  const matched = asChainItem(matchedRaw)
  const result = reconcileOffer(offer, matched)

  check('dimension = MASS', offer.dimension === 'MASS')
  check('isCatchweight = true', offer.isCatchweight === true)
  check('newPpb ≈ 0.0286', Math.abs(result.newPpb - 0.0286) < 0.0001,
    `got ${result.newPpb}`)
  // deltaPct = (0.0286 - 0.0279) / 0.0279 × 100 ≈ +2.508%
  check('deltaPct ≈ +2.5', result.deltaPct != null && Math.abs(result.deltaPct - 2.508) < 0.01,
    `got ${result.deltaPct}`)
  check('status = MATCH', result.status === 'MATCH', `got ${result.status}`)
  check('dimensionConflict = false', result.dimensionConflict === false)
}

// ─── Fixture 3: cola ─────────────────────────────────────────────────────────
// Per-case · 24×355ml @ $30/cs
// newPpb = 30 / (24 × 355ml) = 30 / 8520 ≈ 0.003521 $/ml
// matched: 3-level chain [case→4, sleeve→6, can→355], price $36
//   oldPpb = 36 / (4×6×355) = 36 / 8520 ≈ 0.004225 $/ml
//   deltaPct ≈ −16.6% → PRICE_DELTA
// NOTE: spec says "status MATCH" but the two invoices differ in price by ~16.6%;
// the real assertion the fixture proves is dimensionConflict=false (legacy
// "format mismatch" problem). Status is PRICE_DELTA per the 5% threshold.
console.log('\n[cola] Different pack shape · same item')
{
  const input: OfferInput = {
    pricingMode: 'per_case',
    qtyShipped: 2, qtyShippedUOM: 'CS',
    packQty: 24, packSize: 355, packUOM: 'ml',
    unitPrice: 30.00,
    rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
    isCatchweight: false,
  }
  const matchedRaw = {
    dimension: 'VOLUME', baseUnit: 'ml',
    packChain: [{ unit: 'case', per: 4 }, { unit: 'sleeve', per: 6 }, { unit: 'can', per: 355 }],
    pricing: { mode: 'PACK', purchasePrice: 36 },
    countUnit: undefined, stockOnHand: 17040,
  }
  const offer = buildOffer(input)
  const matched = asChainItem(matchedRaw)
  const result = reconcileOffer(offer, matched)

  check('dimension = VOLUME', offer.dimension === 'VOLUME')
  // newPpb = 30 / 8520 ≈ 0.003521
  check('newPpb ≈ 0.003521', Math.abs(result.newPpb - 0.003521) < 0.00001,
    `got ${result.newPpb}`)
  // The key assertion: no dimension conflict even though pack shapes differ
  check('dimensionConflict = false', result.dimensionConflict === false)
  // Prices differ; status is PRICE_DELTA (not MATCH — spec note adjusted)
  check('status = PRICE_DELTA (prices differ ~16.6%)', result.status === 'PRICE_DELTA',
    `got ${result.status}`)
}

// ─── Fixture 4: arugula ──────────────────────────────────────────────────────
// No match → status NEW
console.log('\n[arugula] No match · new SKU')
{
  const input: OfferInput = {
    pricingMode: 'per_case',
    qtyShipped: 3, qtyShippedUOM: 'CS',
    packQty: 1, packSize: 2, packUOM: 'kg',
    unitPrice: 18.50,
    rate: null, rateUOM: null, totalQty: null, totalQtyUOM: null,
    isCatchweight: false,
  }
  const offer = buildOffer(input)
  const result = reconcileOffer(offer, null)

  check('dimension = MASS', offer.dimension === 'MASS')
  // packChain single link: [{unit:'cs', per: 2 × 1000g}] = [{unit:'cs', per:2000}]
  // newPpb = 18.50 / 2000 = 0.00925 $/g
  check('newPpb ≈ 0.00925', Math.abs(result.newPpb - 0.00925) < 0.0001,
    `got ${result.newPpb}`)
  check('status = NEW', result.status === 'NEW', `got ${result.status}`)
  check('oldPpb = null', result.oldPpb === null)
  check('deltaPct = null', result.deltaPct === null)
  check('dimensionConflict = false', result.dimensionConflict === false)
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
  console.log('All fixtures PASSED')
  process.exit(0)
} else {
  console.log(`${failures} assertion(s) FAILED`)
  process.exit(1)
}
