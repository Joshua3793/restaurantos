import { prisma } from '@/lib/prisma'
import { PREP_CATEGORIES } from '@/lib/prep-utils'
import { assertKnownUnit, getUnitGroup, UnitError } from '@/lib/uom'

/**
 * Resolve the canonical unit to persist on a PrepItem write (POST/PUT).
 * Recipe-linked items inherit the recipe's yield unit (the same value
 * syncPrepItemFromRecipe enforces) so a client can never store a unit whose
 * dimension diverges from the recipe — the root cause of biased stock math.
 * Free-standing items must pass a known canonical token (throws UnitError otherwise).
 */
export async function resolvePrepUnit(
  linkedRecipeId: string | null | undefined,
  fallbackUnit: string | null | undefined,
): Promise<string> {
  if (linkedRecipeId) {
    const rec = await prisma.recipe.findUnique({
      where: { id: linkedRecipeId },
      select: { yieldUnit: true },
    })
    if (rec?.yieldUnit) return rec.yieldUnit
  }
  const canonical = assertKnownUnit(fallbackUnit || 'batch', 'prep unit')
  // Container units (pack/case/tray…) have no fixed conversion factor — they resolve
  // only through an inventory item's pack chain. As a prep yield unit they'd make every
  // baseUnit↔unit conversion silently pass through, so reject them here.
  if (!getUnitGroup(canonical)) {
    throw new UnitError(canonical, 'prep unit')
  }
  return canonical
}

/**
 * Ensure the PrepItem for a PREP recipe exists and matches the recipe
 * (name / category / unit / linked inventory item / active state), and that the recipe's
 * category is present in PrepSettings.categories (the recipe-managed category list).
 * Single entry point for prep task-row sync — reused by the recipe-mutation hooks and the
 * headless bulk endpoint.
 *
 * The recipe is the source of truth for its prep task row's active state: a recipe that
 * is inactive or no longer a PREP must not leave an active prep item behind, and
 * re-activating the recipe re-activates its prep item. (Deletion is handled by the recipe
 * DELETE route, which can't reach here once the row is gone.)
 */
export async function syncPrepItemFromRecipe(recipeId: string): Promise<void> {
  const recipe = await prisma.recipe.findUnique({
    where: { id: recipeId },
    select: {
      id: true, name: true, type: true, isActive: true, yieldUnit: true,
      inventoryItemId: true,
      category: { select: { name: true } },
      prepItems: { select: { id: true }, take: 1 },
    },
  })
  if (!recipe) return

  // No longer an active PREP → deactivate any linked task row(s) and stop.
  if (recipe.type !== 'PREP' || !recipe.isActive) {
    await prisma.prepItem.updateMany({
      where: { linkedRecipeId: recipe.id, isActive: true },
      data: { isActive: false },
    })
    return
  }
  const categoryName = recipe.category?.name ?? 'MISC'

  // Upsert the PrepItem keyed by its linked recipe.
  const existing = recipe.prepItems[0]
  if (existing) {
    await prisma.prepItem.update({
      where: { id: existing.id },
      data: {
        name: recipe.name,
        category: categoryName,
        unit: recipe.yieldUnit,
        linkedInventoryItemId: recipe.inventoryItemId ?? null,
        isActive: true,
      },
    })
  } else {
    await prisma.prepItem.create({
      data: {
        name: recipe.name,
        linkedRecipeId: recipe.id,
        linkedInventoryItemId: recipe.inventoryItemId ?? null,
        unit: recipe.yieldUnit,
        category: categoryName,
        parLevel: 0,
        minThreshold: 0,
        isActive: true,
      },
    })
  }

  // Ensure the category is present in PrepSettings.categories (recipe-managed list).
  // ORM upsert with a text[] value — the same proven path the bulk route uses
  // (NOT $executeRaw tagged templates; see CLAUDE.md pgBouncer note). Gated on a miss
  // so we only write the array when it actually changes.
  const settings = await prisma.prepSettings.findUnique({ where: { id: 'singleton' } })
  const existingCats = settings?.categories ?? PREP_CATEGORIES
  if (!existingCats.includes(categoryName)) {
    const mergedCats = [...new Set([...existingCats, categoryName])].sort()
    await prisma.prepSettings.upsert({
      where: { id: 'singleton' },
      update: { categories: mergedCats },
      create: { id: 'singleton', categories: mergedCats, stations: [] },
    })
  }
}
