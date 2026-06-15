/**
 * READ-ONLY: audit every stored UOM value against the canonical backbone (UNIT_FACTORS).
 * Flags values that canonicalUom() can't resolve into UNIT_FACTORS — those silently
 * become factor 1 ("each") in getUnitConv/convertQty.
 */
import { prisma } from '../src/lib/prisma'
import { canonicalUom, unitKind } from '../src/lib/uom'

type Class = 'canonical' | 'alias' | 'container' | 'UNKNOWN' | 'empty'
function classify(val: string | null | undefined): { cls: Class; canon: string } {
  const v = (val ?? '').trim()
  if (!v) return { cls: 'empty', canon: '' }
  const canon = canonicalUom(v)
  const kind = unitKind(v)
  if (kind === 'unknown') return { cls: 'UNKNOWN', canon }
  if (kind === 'container') return { cls: 'container', canon }
  return { cls: canon === v.toLowerCase() ? 'canonical' : 'alias', canon }
}

// column = "feeds conversion" (getUnitConv/convertQty) vs "label only"
async function audit(label: string, rows: (string | null)[], feedsConversion: boolean) {
  const counts = new Map<string, number>()
  for (const r of rows) { const v = (r ?? '').trim(); if (v) counts.set(v, (counts.get(v) ?? 0) + 1) }
  const flagged: string[] = []
  const lines: string[] = []
  for (const [v, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const { cls, canon } = classify(v)
    if (cls === 'UNKNOWN') { flagged.push(`${v} (×${n})`) ; lines.push(`   ⚠ ${String(n).padStart(4)}  "${v}"  → UNKNOWN (not in backbone)`) }
    else if (cls === 'container') lines.push(`     ${String(n).padStart(4)}  "${v}"  → ${canon} [container]`)
    else if (cls === 'alias') lines.push(`     ${String(n).padStart(4)}  "${v}"  → ${canon}`)
    else lines.push(`     ${String(n).padStart(4)}  "${v}"`)
  }
  const tag = feedsConversion ? '[CONVERSION]' : '[label]'
  console.log(`\n── ${label} ${tag} — ${counts.size} distinct${flagged.length ? `  ⚠ ${flagged.length} UNKNOWN` : '  ✓ all known'}`)
  lines.forEach(l => console.log(l))
  return { label, feedsConversion, flagged }
}

async function main() {
  const inv = await prisma.inventoryItem.findMany({ select: { baseUnit: true, countUOM: true, packUOM: true, qtyUOM: true, purchaseUnit: true } })
  const ing = await prisma.recipeIngredient.findMany({ select: { unit: true } })
  const rec = await prisma.recipe.findMany({ select: { yieldUnit: true, portionUnit: true } })
  const cl  = await prisma.countLine.findMany({ select: { selectedUom: true } })
  const wl  = await prisma.wastageLog.findMany({ select: { unit: true } })
  const scan = await prisma.invoiceScanItem.findMany({ select: { rawUnit: true, invoicePackUOM: true, totalQtyUOM: true, rateUOM: true, qtyOrderedUOM: true } })
  const sup = await prisma.inventorySupplierPrice.findMany({ select: { packUOM: true } })
  const prep = await prisma.prepItem.findMany({ select: { unit: true } })

  const results = [] as { label: string; feedsConversion: boolean; flagged: string[] }[]
  results.push(await audit('InventoryItem.baseUnit',    inv.map(i => i.baseUnit),    true))
  results.push(await audit('InventoryItem.countUOM',    inv.map(i => i.countUOM),    true))
  results.push(await audit('InventoryItem.packUOM',     inv.map(i => i.packUOM),     true))
  results.push(await audit('InventoryItem.qtyUOM',      inv.map(i => i.qtyUOM),      true))
  results.push(await audit('InventoryItem.purchaseUnit',inv.map(i => i.purchaseUnit),false))
  results.push(await audit('RecipeIngredient.unit',     ing.map(i => i.unit),        true))
  results.push(await audit('Recipe.yieldUnit',          rec.map(r => r.yieldUnit),   true))
  results.push(await audit('Recipe.portionUnit',        rec.map(r => r.portionUnit), true))
  results.push(await audit('CountLine.selectedUom',     cl.map(c => c.selectedUom),  true))
  results.push(await audit('WastageLog.unit',           wl.map(w => w.unit),         true))
  results.push(await audit('PrepItem.unit',             prep.map(p => p.unit),       true))
  results.push(await audit('InvoiceScanItem.rawUnit',        scan.map(s => s.rawUnit),        true))
  results.push(await audit('InvoiceScanItem.invoicePackUOM', scan.map(s => s.invoicePackUOM), true))
  results.push(await audit('InvoiceScanItem.totalQtyUOM',    scan.map(s => s.totalQtyUOM),    true))
  results.push(await audit('InvoiceScanItem.rateUOM',        scan.map(s => s.rateUOM),        true))
  results.push(await audit('InvoiceScanItem.qtyOrderedUOM',  scan.map(s => s.qtyOrderedUOM),  true))
  results.push(await audit('InventorySupplierPrice.packUOM', sup.map(s => s.packUOM),         true))

  console.log('\n══════════ SUMMARY — UNKNOWN values in CONVERSION columns (real risk) ══════════')
  const risk = results.filter(r => r.feedsConversion && r.flagged.length)
  if (!risk.length) console.log('  ✓ none')
  for (const r of risk) console.log(`  ${r.label}: ${r.flagged.join(', ')}`)
  console.log('\n── label-only columns with non-unit tokens (expected; must never leak into conversion) ──')
  for (const r of results.filter(r => !r.feedsConversion && r.flagged.length)) console.log(`  ${r.label}: ${r.flagged.join(', ')}`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
