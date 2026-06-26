// Pure-logic assertions for the count↔weight bridge. Run: npx tsx scripts/check-bridge-conversions.ts
import { convertQtyBridged, dimensionallyCostable } from '../src/lib/uom'
import { formToChain } from '../src/lib/item-model-form'
import { pricePerBaseUnit } from '../src/lib/item-model'

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
let failures = 0
function check(label: string, got: number | boolean, want: number | boolean) {
  const ok = typeof want === 'number' && typeof got === 'number' ? approx(got, want) : got === want
  if (!ok) { failures++; console.error(`✗ ${label}: got ${got}, want ${want}`) }
  else console.log(`✓ ${label}`)
}

const bridge = { qty: 1100, unit: 'g' }   // 1 each = 1100 g

// measured → count
check('200g → each',  convertQtyBridged(200, 'g', 'each', bridge), 200 / 1100)
check('8.8kg → each', convertQtyBridged(8.8, 'kg', 'each', bridge), 8)
// count → measured
check('2 each → g',   convertQtyBridged(2, 'each', 'g', bridge), 2200)
check('2 each → kg',  convertQtyBridged(2, 'each', 'kg', bridge), 2.2)
// same dimension delegates to convertQty (bridge ignored)
check('1kg → g',      convertQtyBridged(1, 'kg', 'g', bridge), 1000)
check('3 each → each',convertQtyBridged(3, 'each', 'each', bridge), 3)
// no bridge: cross-dimension passes through unchanged (today's behavior)
check('200g → each (no bridge)', convertQtyBridged(200, 'g', 'each', null), 200)
// dimensionallyCostable with bridge
check('costable g↔each +bridge', dimensionallyCostable('g', 'each', bridge), true)
check('costable g↔each no bridge', dimensionallyCostable('g', 'each', null), false)
check('costable g↔ml (unchanged)', dimensionallyCostable('g', 'ml'), true)

// ── Offer-chain ↔ item-spine equivalence (bridged COUNT item) ───────────────
// Guards the approve route's per-supplier offer build. A bridged COUNT item
// (Brioche, base 'each', 1 each = 1100 g) receiving a weight-format line
// (Sysco "8 × 1100 g" @ $X/case) must build its offer chain in COUNT units, so
// the offer's $/base equals the item's headline spine ($/each = casePrice ÷ 8).
// The bug this catches: using the raw 1100 g as the chain leaf → basePerPurchase
// 8800 → offer ppb ~1100× low → corrupts the item spine if the offer becomes
// primary (syncPrimaryOfferToItem copies the offer chain onto the item).
//
// pricePerBaseUnit reads only packChain + pricing — exactly what the production
// offerPricePerBase(offer) delegates to (chainPpb) — so comparing it here is the
// same equality the approve route relies on, with no DB.
const CASE_PRICE = 41.60   // $/case
const PACK_QTY   = 8       // loaves per case (invoicePackQty)
const PER_EACH_G = 1100    // 1 each = 1100 g (the bridge / invoicePackSize)

// Item's OWN stored count chain (8 each per case) → headline spine = casePrice / 8.
const itemSpinePpb = pricePerBaseUnit({
  dimension: 'COUNT', baseUnit: 'each',
  packChain: [{ unit: 'case', per: PACK_QTY }],
  pricing: { mode: 'PACK', purchasePrice: CASE_PRICE },
})
// Offer chain as approve builds it for a bridged item in PACK mode: count-collapsed
// leaf (packSize=1, packUOM='each'); the 1100 g lives only in the provenance triple.
const bridgedOfferPpb = pricePerBaseUnit(formToChain({
  purchaseUnit: 'case', purchasePrice: CASE_PRICE,
  qtyPerPurchaseUnit: PACK_QTY, qtyUOM: 'each', innerQty: null,
  packSize: 1, packUOM: 'each',          // ← bridged: count-collapsed
  priceType: 'CASE', countUOM: 'each', baseUnit: 'each',
}))
// The pre-fix build (raw grams as leaf) — the ÷8800 regression this guards against.
const buggyOfferPpb = pricePerBaseUnit(formToChain({
  purchaseUnit: 'case', purchasePrice: CASE_PRICE,
  qtyPerPurchaseUnit: PACK_QTY, qtyUOM: 'each', innerQty: null,
  packSize: PER_EACH_G, packUOM: 'g',    // ← the bug: gram leaf
  priceType: 'CASE', countUOM: 'each', baseUnit: 'each',
}))

check('bridged offer ppb == casePrice/packQty', bridgedOfferPpb, CASE_PRICE / PACK_QTY)
check('bridged offer ppb == item spine',        bridgedOfferPpb, itemSpinePpb)
check('buggy gram-leaf ppb == casePrice/8800 (≈1100× low)', buggyOfferPpb, CASE_PRICE / (PACK_QTY * PER_EACH_G))
check('fixed offer ppb != buggy build',         approx(bridgedOfferPpb, buggyOfferPpb), false)

if (failures) { console.error(`\n${failures} fail:`); process.exit(1) }
console.log('\nall bridge assertions passed')
