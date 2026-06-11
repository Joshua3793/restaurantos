// ONE-TIME migration: existing PREP recipes and PREP recipe categories were all
// shared (revenueCenterId = null) because the Recipe Book ignored Revenue Centers.
// The RC-dependent Recipe Book makes PREP rows RC-scoped. This assigns every
// existing PREP Recipe and RecipeCategory to the DEFAULT revenue center so the
// default RC's book looks unchanged; other RCs start empty (deliberate).
//
// Idempotent: only touches PREP rows that are still null. Re-running is a no-op.
//
// Dry by default. Run:
//   ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts
//   APPLY=1 ts-node --compiler-options '{"module":"CommonJS"}' -r tsconfig-paths/register scripts/assign-prep-rc.ts
import { prisma } from '../src/lib/prisma'

const APPLY = process.env.APPLY === '1'

async function main() {
  const defaultRc =
    (await prisma.revenueCenter.findFirst({ where: { isDefault: true } })) ??
    (await prisma.revenueCenter.findFirst({ orderBy: { createdAt: 'asc' } }))

  if (!defaultRc) {
    console.error('No RevenueCenter found — create one before running this migration.')
    process.exit(1)
  }
  console.log(`Default RC: ${defaultRc.name} (${defaultRc.id})`)

  const recipeWhere = { type: 'PREP' as const, revenueCenterId: null }
  const catWhere = { type: 'PREP' as const, revenueCenterId: null }

  const recipeCount = await prisma.recipe.count({ where: recipeWhere })
  const catCount = await prisma.recipeCategory.count({ where: catWhere })
  console.log(`PREP recipes to assign:    ${recipeCount}`)
  console.log(`PREP categories to assign: ${catCount}`)

  if (!APPLY) {
    console.log('\nDRY RUN — set APPLY=1 to write.')
    return
  }

  const r = await prisma.recipe.updateMany({ where: recipeWhere, data: { revenueCenterId: defaultRc.id } })
  const c = await prisma.recipeCategory.updateMany({ where: catWhere, data: { revenueCenterId: defaultRc.id } })
  console.log(`\nUpdated ${r.count} recipes, ${c.count} categories → ${defaultRc.name}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
