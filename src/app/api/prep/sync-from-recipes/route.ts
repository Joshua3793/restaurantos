import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES } from '@/lib/prep-utils'

/**
 * POST /api/prep/sync-from-recipes
 *
 * 1. Creates a PrepItem for every active PREP recipe that doesn't have one yet.
 * 2. Updates the category on existing PrepItems whose category doesn't match
 *    their linked recipe's category (backfill / keeps them in sync).
 * 3. Merges all recipe category names into PrepSettings.categories so they
 *    appear in all prep UI dropdowns.
 *
 * Fully idempotent — safe to run repeatedly.
 */
export async function POST() {
  // Fetch all active PREP recipes with their category name
  const prepRecipes = await prisma.recipe.findMany({
    where: { type: 'PREP', isActive: true },
    select: {
      id:              true,
      name:            true,
      yieldUnit:       true,
      inventoryItemId: true,
      category:        { select: { name: true } },
      prepItems:       { select: { id: true, category: true }, take: 1 },
    },
  })

  const toCreate   = prepRecipes.filter(r => r.prepItems.length === 0)
  const toUpdate   = prepRecipes.filter(r =>
    r.prepItems.length > 0 &&
    r.prepItems[0].category !== r.category.name
  )

  // Collect all category names that will be in use after this sync
  const allCatNames = [...new Set(prepRecipes.map(r => r.category.name))]

  // Merge into PrepSettings.categories
  const settings     = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
  const existingCats = settings?.categories ?? PREP_CATEGORIES
  const mergedCats   = [...new Set([...existingCats, ...allCatNames])].sort()

  await prisma.$transaction([
    // Sync PrepSettings categories
    prisma.prepSettings.upsert({
      where:  { id: 'singleton' },
      update: { categories: mergedCats },
      create: { id: 'singleton', categories: mergedCats, stations: [] },
    }),

    // Create new prep items
    prisma.prepItem.createMany({
      data: toCreate.map(r => ({
        name:                  r.name,
        linkedRecipeId:        r.id,
        linkedInventoryItemId: r.inventoryItemId ?? null,
        unit:                  r.yieldUnit,
        category:              r.category.name,
        parLevel:              0,
        minThreshold:          0,
        isActive:              true,
      })),
    }),

    // Backfill categories on existing linked prep items
    ...toUpdate.map(r =>
      prisma.prepItem.update({
        where: { id: r.prepItems[0].id },
        data:  { category: r.category.name },
      })
    ),
  ])

  return NextResponse.json({
    created: toCreate.length,
    updated: toUpdate.length,
    skipped: prepRecipes.length - toCreate.length - toUpdate.length,
  })
}
