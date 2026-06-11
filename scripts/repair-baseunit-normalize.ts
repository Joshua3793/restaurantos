// Normalize items whose baseUnit is a NON-SI weight/volume unit (kg/lb/L…) but
// whose pricePerBaseUnit is actually stored in $/SI-base (g/ml). These produce
// recipe costs that are too LOW (1000×/453×) because computeRecipeCost does
// convertQty(qty, unit, baseUnit) × ppb. Fix: set baseUnit to its SI base and
// keep ppb (already $/g). PREP-output items are EXCLUDED — syncPrepToInventory
// keeps them consistent with baseUnit=yieldUnit on purpose.
//
// Run (dry):   TS_NODE_BASEURL=. npx ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/repair-baseunit-normalize.ts
// Run (apply): APPLY=1 TS_NODE_BASEURL=. npx ts-node ... scripts/repair-baseunit-normalize.ts
import { prisma } from '../src/lib/prisma'
import { calcPricePerBaseUnit, getUnitConv } from '../src/lib/utils'
import { recalculateRecipeCosts } from '../src/lib/recipe-costs'

const APPLY = process.env.APPLY === '1'
const WEIGHT = ['kg', 'lb', 'oz', 'mg']
const VOLUME = ['l', 'lt', 'cl', 'dl']
const nonSiToSi = (u: string): string | null => {
  const l = u.toLowerCase()
  if (WEIGHT.includes(l)) return 'g'
  if (VOLUME.includes(l)) return 'ml'
  return null // already SI (g/ml/each) or unknown — not in scope
}

async function main() {
  // Item ids that are the output of a PREP recipe — leave these alone.
  const prepItems = await prisma.recipe.findMany({
    where: { type: 'PREP', inventoryItemId: { not: null } },
    select: { inventoryItemId: true },
  })
  const prepIds = new Set(prepItems.map(r => r.inventoryItemId!))

  const items = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true, itemName: true, purchasePrice: true, pricePerBaseUnit: true,
      qtyPerPurchaseUnit: true, qtyUOM: true, innerQty: true,
      packSize: true, packUOM: true, priceType: true, baseUnit: true,
    },
  })

  const fix: { id: string; name: string; baseOld: string; baseNew: string; ppbOld: number; ppbNew: number; perUnit: string }[] = []
  const skipped: { name: string; baseUnit: string; reason: string }[] = []

  for (const it of items) {
    const base = it.baseUnit ?? ''
    const si = nonSiToSi(base)
    if (!si) continue                       // already SI / count — not in scope
    if (prepIds.has(it.id)) { skipped.push({ name: it.itemName, baseUnit: base, reason: 'PREP-output (sync-managed)' }); continue }

    const ppbStored = Number(it.pricePerBaseUnit)
    const ppbSI = calcPricePerBaseUnit(
      Number(it.purchasePrice), Number(it.qtyPerPurchaseUnit), it.qtyUOM ?? 'each',
      it.innerQty != null ? Number(it.innerQty) : null,
      Number(it.packSize), it.packUOM ?? 'each',
      it.priceType === 'UOM' ? 'UOM' : 'CASE',
    )
    const ppbBase = ppbSI * getUnitConv(base) // what ppb would be if stored in $/baseUnit

    const near = (a: number, b: number) => b > 0 && Math.abs(a - b) / b < 0.05
    if (near(ppbStored, ppbSI) && ppbSI > 0) {
      // Stored value is in $/g but baseUnit says non-SI → relabel base to SI.
      const perUnit = `$${(ppbSI * getUnitConv(si === 'g' ? 'kg' : 'l')).toFixed(2)}/${si === 'g' ? 'kg' : 'L'}`
      fix.push({ id: it.id, name: it.itemName, baseOld: base, baseNew: si, ppbOld: ppbStored, ppbNew: ppbSI, perUnit })
    } else if (near(ppbStored, ppbBase)) {
      skipped.push({ name: it.itemName, baseUnit: base, reason: 'consistent ($/baseUnit) — left as-is' })
    } else {
      skipped.push({ name: it.itemName, baseUnit: base, reason: `ambiguous (stored ${ppbStored.toPrecision(3)}, $/g ${ppbSI.toPrecision(3)}, $/base ${ppbBase.toPrecision(3)}) — NOT touched` })
    }
  }

  console.log(`\n${fix.length} item(s) to relabel to SI base${APPLY ? ' (APPLYING)' : ' (DRY RUN)'}:\n`)
  for (const f of fix) {
    console.log(`  ${f.name}`)
    console.log(`    baseUnit ${f.baseOld}→${f.baseNew}; ppb ${f.ppbOld.toPrecision(4)} (kept) = ${f.perUnit}`)
  }
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} non-SI item(s):`)
    for (const s of skipped) console.log(`  ${s.name} [${s.baseUnit}] — ${s.reason}`)
  }

  if (!APPLY) { console.log('\nDry run. Re-run with APPLY=1 to write.'); return }

  for (const f of fix) {
    await prisma.inventoryItem.update({
      where: { id: f.id },
      data: { baseUnit: f.baseNew, pricePerBaseUnit: f.ppbNew, lastUpdated: new Date() },
    })
  }
  console.log(`\nApplied ${fix.length} base-unit relabels. Re-costing recipes…`)
  if (fix.length > 0) {
    const alerts = await recalculateRecipeCosts(fix.map(f => f.id))
    console.log(`Re-costed recipes: ${alerts.length} cost change(s).`)
  }
  console.log('Done.')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
