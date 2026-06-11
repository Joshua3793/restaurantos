// Relabel count-based items mislabeled with a weight/volume baseUnit.
// e.g. Granny Smith apple (1×12 each) stored as baseUnit='g' with ppb=$1.83
// (which is actually $/each). The canonical base (deriveBaseUnit) is 'each'.
// These cost correctly only when a recipe references them per-each (cross-group
// convertQty passthrough) and mis-cost if referenced by gram. Fix: set
// baseUnit='each', keep ppb (already $/each). PREP-output items excluded.
//
// Run (dry):   TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/repair-count-baseunit.ts
// Run (apply): APPLY=1 TS_NODE_BASEURL=. npx ts-node ... scripts/repair-count-baseunit.ts
import { prisma } from '../src/lib/prisma'
import { calcPricePerBaseUnit, deriveBaseUnit } from '../src/lib/utils'
import { recalculateRecipeCosts } from '../src/lib/recipe-costs'

const APPLY = process.env.APPLY === '1'

async function main() {
  const prep = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { inventoryItemId: true },
  })
  const prepIds = new Set(prep.map(r => r.inventoryItemId!))

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, purchasePrice: true, pricePerBaseUnit: true,
      qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true,
      packSize: true, packUOM: true, priceType: true, baseUnit: true,
    },
  })

  const fix: { id: string; name: string; baseOld: string; ppb: number; perEach: string }[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const it of items) {
    const base = (it.baseUnit ?? '').toLowerCase()
    if (base !== 'g' && base !== 'ml') continue                  // only weight/vol-labelled
    if (it.priceType === 'UOM') continue                          // per-weight items are genuinely weight
    const canonical = deriveBaseUnit(it.qtyUOM ?? 'each', it.packUOM ?? 'each', Number(it.packSize))
    if (canonical !== 'each') continue                            // app would derive a weight/vol base — leave
    if (prepIds.has(it.id)) { skipped.push({ name: it.itemName, reason: 'PREP-output' }); continue }

    // ppb for a count item is $/each = price / (qty × packSize).
    const ppbEach = calcPricePerBaseUnit(
      Number(it.purchasePrice), Number(it.qtyPerPurchaseUnit), it.qtyUOM ?? 'each',
      it.innerQty != null ? Number(it.innerQty) : null,
      Number(it.packSize), it.packUOM ?? 'each', 'CASE',
    )
    const stored = Number(it.pricePerBaseUnit)
    // Only relabel when the stored value already IS $/each (it should be — both
    // come from the same count formula). Guard against surprises.
    if (ppbEach <= 0 || (stored > 0 && Math.abs(stored - ppbEach) / ppbEach > 0.05)) {
      skipped.push({ name: it.itemName, reason: `stored ppb ${stored.toPrecision(3)} ≠ \$/each ${ppbEach.toPrecision(3)} — NOT touched` })
      continue
    }
    fix.push({ id: it.id, name: it.itemName, baseOld: it.baseUnit ?? '', ppb: ppbEach, perEach: `$${ppbEach.toFixed(2)}/each` })
  }

  console.log(`\n${fix.length} count item(s) to relabel baseUnit→each${APPLY ? ' (APPLYING)' : ' (DRY RUN)'}:\n`)
  for (const f of fix) console.log(`  ${f.name}: baseUnit ${f.baseOld}→each; ppb ${f.ppb.toPrecision(4)} = ${f.perEach}`)
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`)
    for (const s of skipped) console.log(`  ${s.name} — ${s.reason}`)
  }

  if (!APPLY) { console.log('\nDry run. Re-run with APPLY=1 to write.'); return }

  for (const f of fix) {
    await prisma.inventoryItem.update({
      where: { id: f.id },
      data: { baseUnit: 'each', pricePerBaseUnit: f.ppb, lastUpdated: new Date() },
    })
  }
  console.log(`\nApplied ${fix.length} relabels. Re-costing recipes…`)
  if (fix.length > 0) {
    const alerts = await recalculateRecipeCosts(fix.map(f => f.id))
    console.log(`Re-costed recipes: ${alerts.length} cost change(s).`)
  }
  console.log('Done.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
