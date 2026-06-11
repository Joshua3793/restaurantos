// One-shot repair for the 2026-06-11 pricing corruption.
// Recomputes purchasePrice + pricePerBaseUnit for items hit by the three bugs,
// then re-costs affected recipes. Idempotent. Prints a plan; pass APPLY=1 to write.
//
// Run (dry):   TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/repair-pricing-corruption.ts
// Run (apply): APPLY=1 TS_NODE_BASEURL=. npx ts-node ... scripts/repair-pricing-corruption.ts
import { prisma } from '../src/lib/prisma'
import { calcPricePerBaseUnit, getUnitConv } from '../src/lib/utils'
import { recalculateRecipeCosts } from '../src/lib/recipe-costs'

const APPLY = process.env.APPLY === '1'
const WV = ['g', 'mg', 'kg', 'lb', 'oz', 'ml', 'cl', 'dl', 'l', 'lt']
const isWV = (u: string | null | undefined) => !!u && WV.includes(u.toLowerCase())

async function main() {
  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, purchasePrice: true, pricePerBaseUnit: true,
      qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true,
      packSize: true, packUOM: true, priceType: true, baseUnit: true,
    },
  })

  // Latest approved scan line per matched item → the supplier's TRUE price.
  const lines = await prisma.invoiceScanItem.findMany({
    where: {
      approved: true, matchedItemId: { not: null },
      action: { in: ['UPDATE_PRICE', 'ADD_SUPPLIER', 'CREATE_NEW'] },
      session: { status: 'APPROVED' },
    },
    select: {
      matchedItemId: true, rate: true, rawUnitPrice: true, pricingMode: true,
      session: { select: { approvedAt: true } },
    },
  })
  const truePrice = new Map<string, number>()
  const seenAt = new Map<string, number>()
  for (const l of lines) {
    const id = l.matchedItemId!
    const t = l.session?.approvedAt ? new Date(l.session.approvedAt).getTime() : 0
    if ((seenAt.get(id) ?? -1) >= t) continue
    const tp = l.pricingMode === 'per_weight'
      ? (l.rate != null ? Number(l.rate) : null)
      : (l.rawUnitPrice != null ? Number(l.rawUnitPrice) : null)
    if (tp != null && tp > 0) { truePrice.set(id, tp); seenAt.set(id, t) }
  }

  const changes: { id: string; name: string; note: string[]; price: number; qtyUOM: string; ppbOld: number; ppbNew: number }[] = []

  for (const it of items) {
    const note: string[] = []
    let qtyUOM = it.qtyUOM ?? 'each'
    let price = Number(it.purchasePrice)
    const ppbOld = Number(it.pricePerBaseUnit)

    // Only repair items matching one of the THREE recent-wave bug signatures.
    // (A separate pre-existing class — non-SI baseUnit with ppb in $/g — is left
    // for its own pass; it is not part of this corruption.)
    const bugA = it.priceType === 'UOM' && !isWV(it.packUOM) // rate ÷ count unit (1000×)
    const tp = truePrice.get(it.id)
    const bugB = tp != null && price / tp > 1.2              // purchasePrice inflated by format round-trip
    const bugC = isWV(qtyUOM) && isWV(it.packUOM)            // carton-of-weight: qtyUOM dropped packSize
      && qtyUOM.toLowerCase() === (it.packUOM ?? '').toLowerCase() && Number(it.packSize) > 1
    if (!bugA && !bugB && !bugC) continue

    if (bugC) {
      qtyUOM = 'each'
      note.push(`qtyUOM ${it.qtyUOM}→each (carton-of-weight)`)
    }
    if (bugB) {
      note.push(`price $${price.toFixed(2)}→$${tp!.toFixed(2)} (de-inflated ${(price / tp!).toFixed(1)}×)`)
      price = tp!
    }
    if (bugA) note.push('UOM rate denominator (catch-weight packUOM)')

    // ── Recompute ppb with the FIXED engine (also fixes Bug A: UOM rate÷count).
    // calcPricePerBaseUnit returns $/SI-base (g, ml, each). Express it in the
    // item's OWN baseUnit — many items (esp. PREP-synced) store baseUnit as
    // kg/L/lb with ppb in $/that-unit, which is already correct; multiplying by
    // getUnitConv(baseUnit) makes those recompute to their existing value (no
    // change) while still fixing the truly-corrupt SI-base items.
    const ppbSI = calcPricePerBaseUnit(
      price, Number(it.qtyPerPurchaseUnit), qtyUOM,
      it.innerQty != null ? Number(it.innerQty) : null,
      Number(it.packSize), it.packUOM ?? 'each',
      it.priceType === 'UOM' ? 'UOM' : 'CASE',
    )
    const ppbNew = ppbSI * getUnitConv(it.baseUnit ?? 'each')
    const ppbChanged = ppbOld <= 0 ? ppbNew > 0 : Math.abs(ppbNew - ppbOld) / ppbOld > 0.01
    if (ppbChanged && note.length === 0) note.push(`ppb-only recompute`)

    if (note.length > 0 && (ppbChanged || qtyUOM !== (it.qtyUOM ?? 'each') || price !== Number(it.purchasePrice))) {
      changes.push({ id: it.id, name: it.itemName, note, price, qtyUOM, ppbOld, ppbNew })
    }
  }

  changes.sort((a, b) => (b.ppbOld / (b.ppbNew || 1)) - (a.ppbOld / (a.ppbNew || 1)))
  console.log(`\n${changes.length} item(s) to repair${APPLY ? ' (APPLYING)' : ' (DRY RUN — set APPLY=1 to write)'}:\n`)
  for (const c of changes) {
    console.log(`  ${c.name}`)
    console.log(`    ${c.note.join(' · ')}`)
    console.log(`    ppb ${c.ppbOld.toPrecision(4)} → ${c.ppbNew.toPrecision(4)}  (${(c.ppbOld / (c.ppbNew || 1)).toFixed(1)}× change)`)
  }

  if (!APPLY) { console.log('\nDry run complete. Re-run with APPLY=1 to write.'); return }

  for (const c of changes) {
    await prisma.inventoryItem.update({
      where: { id: c.id },
      data: { purchasePrice: c.price, qtyUOM: c.qtyUOM, pricePerBaseUnit: c.ppbNew, lastUpdated: new Date() },
    })
  }
  console.log(`\nApplied ${changes.length} item fixes. Re-costing affected recipes…`)
  if (changes.length > 0) {
    const alerts = await recalculateRecipeCosts(changes.map(c => c.id))
    console.log(`Re-costed recipes: ${alerts.length} cost change(s) propagated.`)
  }
  console.log('Repair complete.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
