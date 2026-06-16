/**
 * One-time, idempotent: normalize stored token-column unit values to their canonical
 * backbone token (pkg→pack, CS→case, KG→kg, L→l, portions→portion, CT→each …).
 * Only rewrites values that are KNOWN (measurement/container) and differ; reports any
 * unknown values left as-is. Leaves selectedUom / purchaseUnit (display labels) untouched.
 */
import { prisma } from '../src/lib/prisma'
import { canonicalUom, isKnownUnit } from '../src/lib/uom'

async function fixColumn<T extends { id: string }>(
  label: string,
  rows: T[],
  get: (r: T) => string | null,
  update: (id: string, canon: string) => Promise<unknown>,
) {
  let fixed = 0
  const unknown = new Map<string, number>()
  for (const r of rows) {
    const v = (get(r) ?? '').trim()
    if (!v) continue
    if (!isKnownUnit(v)) { unknown.set(v, (unknown.get(v) ?? 0) + 1); continue }
    const canon = canonicalUom(v)
    if (canon !== v) { await update(r.id, canon); fixed++ }
  }
  console.log(`  ${label}: normalized ${fixed}${unknown.size ? `, left ${[...unknown.entries()].map(([u,n])=>`"${u}"×${n}`).join(', ')} unknown (untouched)` : ''}`)
}

async function main() {
  const inv = await prisma.inventoryItem.findMany({ select: { id: true, baseUnit: true, packUOM: true, qtyUOM: true, countUOM: true } })
  await fixColumn('InventoryItem.baseUnit', inv, i => i.baseUnit, (id, c) => prisma.inventoryItem.update({ where: { id }, data: { baseUnit: c } }))
  await fixColumn('InventoryItem.packUOM',  inv, i => i.packUOM,  (id, c) => prisma.inventoryItem.update({ where: { id }, data: { packUOM: c } }))
  await fixColumn('InventoryItem.qtyUOM',   inv, i => i.qtyUOM,   (id, c) => prisma.inventoryItem.update({ where: { id }, data: { qtyUOM: c } }))
  await fixColumn('InventoryItem.countUOM', inv, i => i.countUOM, (id, c) => prisma.inventoryItem.update({ where: { id }, data: { countUOM: c } }))

  const ing = await prisma.recipeIngredient.findMany({ select: { id: true, unit: true } })
  await fixColumn('RecipeIngredient.unit', ing, i => i.unit, (id, c) => prisma.recipeIngredient.update({ where: { id }, data: { unit: c } }))

  const rec = await prisma.recipe.findMany({ select: { id: true, yieldUnit: true, portionUnit: true } })
  await fixColumn('Recipe.yieldUnit',   rec, r => r.yieldUnit,   (id, c) => prisma.recipe.update({ where: { id }, data: { yieldUnit: c } }))
  await fixColumn('Recipe.portionUnit', rec, r => r.portionUnit, (id, c) => prisma.recipe.update({ where: { id }, data: { portionUnit: c } }))

  console.log('Done (idempotent — safe to re-run).')
  await prisma.$disconnect()
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
