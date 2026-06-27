/**
 * Toast item → MENU recipe mapping. The GUID link (`ToastItemMap.recipeId`) is
 * the permanent identity; the fuzzy matcher only *suggests* it for unmapped rows
 * during admin review.
 */

import { prisma } from '@/lib/prisma'
import { matchRecipe, type MatchConfidence } from '@/lib/recipe-match'
import { classifyGroup } from '@/lib/toast/food-classify'

export interface ToastItemRow {
  id: string
  toastItemGuid: string
  toastName: string
  toastGroup: string | null
  toastMenu: string | null
  recipeId: string | null
  recipeName: string | null
  /** food | beverage | ignore — from the group classifier. */
  kind: 'food' | 'beverage' | 'ignore'
  /** Suggested recipe for an unmapped row (null if already mapped or no match). */
  suggestion: { id: string; name: string; confidence: MatchConfidence } | null
}

export interface ToastItemsResult {
  items: ToastItemRow[]
  recipes: { id: string; name: string }[]
  stats: { total: number; mapped: number; unmapped: number; foodUnmapped: number }
}

/** List every ToastItemMap row with its current recipe + a suggestion if unmapped. */
export async function listToastItems(): Promise<ToastItemsResult> {
  const [items, recipes] = await Promise.all([
    prisma.toastItemMap.findMany({
      include: { recipe: { select: { id: true, name: true } } },
      orderBy: [{ toastMenu: 'asc' }, { toastGroup: 'asc' }, { toastName: 'asc' }],
    }),
    prisma.recipe.findMany({
      where: { type: 'MENU', isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const rows: ToastItemRow[] = items.map((it) => {
    const cls = classifyGroup(it.toastGroup)
    const kind: ToastItemRow['kind'] = cls.ignore ? 'ignore' : cls.isFood ? 'food' : 'beverage'
    const suggestion = it.recipeId ? null : matchRecipe(it.toastName, recipes)
    return {
      id: it.id,
      toastItemGuid: it.toastItemGuid,
      toastName: it.toastName,
      toastGroup: it.toastGroup,
      toastMenu: it.toastMenu,
      recipeId: it.recipeId,
      recipeName: it.recipe?.name ?? null,
      kind,
      suggestion: suggestion ? { id: suggestion.id, name: suggestion.name, confidence: suggestion.confidence } : null,
    }
  })

  const mapped = rows.filter((r) => r.recipeId).length
  const foodUnmapped = rows.filter((r) => !r.recipeId && r.kind === 'food').length
  return {
    items: rows,
    recipes,
    stats: { total: rows.length, mapped, unmapped: rows.length - mapped, foodUnmapped },
  }
}

/** Bulk set/clear recipe links on ToastItemMap rows (by row id). */
export async function setItemMappings(
  mappings: { id: string; recipeId: string | null }[],
): Promise<number> {
  await prisma.$transaction(
    mappings.map((m) =>
      prisma.toastItemMap.update({
        where: { id: m.id },
        data: { recipeId: m.recipeId },
      }),
    ),
  )
  return mappings.length
}
