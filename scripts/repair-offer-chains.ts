/**
 * Repair supplier-offer chains whose derived ppb diverges from the item spine.
 *
 * Two classes of divergence exist (see investigation):
 *   A. BROKEN OFFER CHAIN — the offer's packChain is degenerate (never captured
 *      the real pack content), so offerPpb collapses to ~the whole case price.
 *      The item's own chain is correct. SAFE to repair: rebuild the offer chain
 *      the sanctioned way (the offer's pack triple if complete, else REUSE the
 *      item chain) — exactly what approve/route.ts does in the no-line-pack branch.
 *   B. SUSPECT ITEM SPINE — the offer chain is structurally fine; the divergence
 *      is a price/spine disagreement (often the ITEM's stored price is stale or
 *      its chain mis-handles dimension). NOT safe to auto-touch — needs a human.
 *
 * Classification is self-validating: we only AUTO-REPAIR when the rebuilt offer
 * ppb reconciles to the spine (within RECONCILE_TOL). If the rebuild does NOT
 * reconcile, the spine is the suspect side → FLAG, write nothing.
 *
 * Usage:
 *   ts-node scripts/repair-offer-chains.ts            # dry run (default)
 *   ts-node scripts/repair-offer-chains.ts --apply    # write the AUTO repairs
 */
import { prisma } from '../src/lib/prisma'
import { offerPricePerBase } from '../src/lib/supplier-offers'
import { pricePerBaseUnit as chainPpb, type PackLink, type Pricing } from '../src/lib/item-model'
import { formToChain } from '../src/lib/item-model-form'

const APPLY = process.argv.includes('--apply')
const DIVERGE_TOL = 0.15   // >15% from spine = the alert-triggering divergence
const RECONCILE_TOL = 0.05 // rebuilt within 5% of spine = safely reconciled

const pctDiff = (a: number, b: number) => (b > 0 ? Math.abs((a - b) / b) : Infinity)

function buildRepairChain(item: any, offer: any): { packChain: PackLink[]; pricing: Pricing } {
  const itemChain = (item.packChain as PackLink[]) ?? []
  const itemPricing = item.pricing as Pricing | null
  const lastPrice = Number(offer.lastPrice)
  const isRate = itemPricing?.mode === 'RATE'
  const hasTriple = offer.packQty != null && offer.packSize != null

  if (hasTriple) {
    // Rebuild from THIS supplier's pack triple — mirrors approve/route.ts.
    const built = formToChain({
      purchaseUnit:       itemChain[0]?.unit ?? 'case',
      purchasePrice:      lastPrice,
      qtyPerPurchaseUnit: Number(offer.packQty),
      qtyUOM:             'each',
      innerQty:           null,
      packSize:           Number(offer.packSize),
      packUOM:            isRate ? (itemPricing as any).rateUnit : (offer.packUOM ?? 'each'),
      priceType:          isRate ? 'UOM' : 'CASE',
      countUOM:           item.countUnit ?? 'each',
      baseUnit:           item.baseUnit ?? undefined,
    })
    return { packChain: built.packChain, pricing: built.pricing }
  }
  // No triple → reuse the item's stored chain, pricing follows item mode at the
  // offer's own last price (the sanctioned no-line-pack offer shape).
  return {
    packChain: itemChain,
    pricing: isRate
      ? { mode: 'RATE', rate: lastPrice, rateUnit: (itemPricing as any).rateUnit }
      : { mode: 'PACK', purchasePrice: lastPrice },
  }
}

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { supplierPrices: { some: {} } },
    include: { supplierPrices: true },
  })

  const auto: any[] = []
  const flag: any[] = []

  for (const item of items) {
    let spine = 0
    try { spine = chainPpb({ packChain: (item.packChain as PackLink[]) ?? [], pricing: item.pricing as any } as any) } catch { spine = NaN }
    if (!Number.isFinite(spine) || spine <= 0) continue

    for (const offer of item.supplierPrices) {
      const cur = offerPricePerBase(offer)
      if (!Number.isFinite(cur) || cur <= 0) continue
      if (pctDiff(cur, spine) <= DIVERGE_TOL) continue // agrees → nothing to do

      const repair = buildRepairChain(item, offer)
      let repaired = 0
      try { repaired = chainPpb({ packChain: repair.packChain, pricing: repair.pricing } as any) } catch { repaired = NaN }

      const row = { item: item.itemName, supplier: offer.supplierName, primary: offer.isPrimary, offerId: offer.id, spine, cur, repaired, repair }
      if (Number.isFinite(repaired) && repaired > 0 && pctDiff(repaired, spine) <= RECONCILE_TOL) {
        auto.push(row)
      } else {
        flag.push(row)
      }
    }
  }

  const f = (n: number) => Number(n.toPrecision(4))
  console.log(`\nScanned ${items.length} items with offers. ${auto.length} auto-repairable, ${flag.length} flagged.`)

  console.log(`\n── AUTO-REPAIR (broken offer chain → reconciles to spine) ──`)
  for (const r of auto) {
    console.log(`  ${r.primary ? '★' : ' '} ${r.item} / ${r.supplier}`)
    console.log(`      offer ppb ${f(r.cur)} → ${f(r.repaired)}  (spine ${f(r.spine)})`)
    console.log(`      new chain ${JSON.stringify(r.repair.packChain)}  pricing ${JSON.stringify(r.repair.pricing)}`)
  }

  console.log(`\n── FLAGGED (rebuild does NOT reconcile → item spine is suspect, NOT touched) ──`)
  for (const r of flag) {
    console.log(`  ${r.primary ? '★' : ' '} ${r.item} / ${r.supplier}`)
    console.log(`      offer ppb ${f(r.cur)}  rebuilt ${f(r.repaired)}  spine ${f(r.spine)}  — needs human review`)
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — no writes. Re-run with --apply to write the ${auto.length} AUTO repair(s).`)
    return
  }

  for (const r of auto) {
    await prisma.inventorySupplierPrice.update({
      where: { id: r.offerId },
      data: { packChain: r.repair.packChain as any, pricing: r.repair.pricing as any, lastUpdated: new Date() },
    })
    console.log(`  ✓ repaired ${r.item} / ${r.supplier}`)
  }
  console.log(`\nApplied ${auto.length} offer-chain repair(s). ${flag.length} still flagged for review.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
