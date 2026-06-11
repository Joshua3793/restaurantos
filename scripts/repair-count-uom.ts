// Repair stored InventoryItem.countUOM values that are no longer valid for the
// item's purchase structure — e.g. a stale "each" left on a by-weight item
// (baseUnit g/ml, weight packUOM). The app already tolerates this at read time
// via resolveCountUom() (drawer header, count UI), but the stock-movements
// endpoint historically read the raw value, so "Last count" / "Theoretical
// stock" rendered the wrong unit ("each" instead of "KG"). The endpoint is now
// fixed too; this script cleans the underlying data so every code path agrees.
//
// Pure relabel of an invalid → valid unit. Quantities are unchanged (stockOnHand
// stays in baseUnit); only the display/count unit is corrected.
//
// Dry by default. Run:
//   ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/repair-count-uom.ts
//   APPLY=1 ts-node ... scripts/repair-count-uom.ts   # to write
import { prisma } from '../src/lib/prisma'
import { resolveCountUom } from '../src/lib/count-uom'

const APPLY = process.env.APPLY === '1'

// A safe count-unit token is letters only: 'each', 'kg', 'KG', 'lb', 'l', 'g',
// 'ml', 'CS', 'pkg', 'case'… It excludes the display strings some items wrongly
// carry in purchaseUnit — '10 lb', '138 each', 'case (2×3.78 l)'. We never copy
// those into countUOM; they signal a separate purchaseUnit-corruption problem.
const isCleanToken = (u: string) => /^[A-Za-z]+$/.test(u)

async function main() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      id: true, itemName: true, baseUnit: true, countUOM: true, qtyUOM: true,
      purchaseUnit: true, qtyPerPurchaseUnit: true, innerQty: true,
      packSize: true, packUOM: true,
    },
  })

  // Three buckets:
  //  fixes        — SAFE: stored countUOM is 'each' (meaningless on this item)
  //                 and resolves to a clean unit token. This is the reported bug
  //                 class; the value already shown everywhere via resolveCountUom,
  //                 so persisting it changes no displayed number.
  //  reviewUnit   — stored is a real unit (kg/g/case/…) that resolves to a
  //                 *different* clean unit — often a DOWNGRADE (kg→each) caused by
  //                 incomplete weight structure. Needs a human; not auto-applied.
  //  reviewMessy  — resolves to a non-token display string ('10 lb', 'case (…)') —
  //                 the real problem is a corrupt purchaseUnit, not countUOM.
  const fixes: Array<{ id: string; name: string; from: string; to: string }> = []
  const reviewUnit: Array<{ name: string; from: string; to: string }> = []
  const reviewMessy: Array<{ name: string; from: string; to: string }> = []
  for (const i of items) {
    const stored = i.countUOM || i.baseUnit
    const resolved = resolveCountUom({
      baseUnit:           i.baseUnit,
      purchaseUnit:       i.purchaseUnit,
      qtyPerPurchaseUnit: Number(i.qtyPerPurchaseUnit),
      qtyUOM:             i.qtyUOM ?? 'each',
      innerQty:           i.innerQty != null ? Number(i.innerQty) : null,
      packSize:           Number(i.packSize ?? 1),
      packUOM:            i.packUOM ?? 'each',
      countUOM:           stored,
    })
    if (resolved === stored) continue
    if (!isCleanToken(resolved)) reviewMessy.push({ name: i.itemName, from: stored, to: resolved })
    else if (stored === 'each') fixes.push({ id: i.id, name: i.itemName, from: stored, to: resolved })
    else reviewUnit.push({ name: i.itemName, from: stored, to: resolved })
  }

  console.log(`SAFE countUOM repairs ('each' → clean unit): ${fixes.length} of ${items.length} items`)
  for (const f of fixes) console.log(`  ${f.name}: '${f.from}' → '${f.to}'`)

  if (reviewUnit.length) {
    console.log(`\nREVIEW ${reviewUnit.length} — real unit resolves to a different unit (possible downgrade; NOT applied):`)
    for (const s of reviewUnit) console.log(`  ${s.name}: '${s.from}' → would be '${s.to}'`)
  }
  if (reviewMessy.length) {
    console.log(`\nREVIEW ${reviewMessy.length} — purchaseUnit holds a display string; fix purchaseUnit, not countUOM (NOT applied):`)
    for (const s of reviewMessy) console.log(`  ${s.name}: '${s.from}' → would be '${s.to}'`)
  }

  if (!APPLY) { console.log('\nDry run. APPLY=1 writes the SAFE bucket only.'); return }
  for (const f of fixes) {
    await prisma.inventoryItem.update({ where: { id: f.id }, data: { countUOM: f.to } })
  }
  console.log(`\nApplied ${fixes.length} SAFE countUOM repairs. Review buckets left untouched.`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
