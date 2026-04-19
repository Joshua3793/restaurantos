import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Fuzzy score: how well does `query` match `target`?
// Returns 0–100. Handles case, partial words, abbreviations.
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase().trim()

  if (!q) return 100
  if (t === q) return 100

  // Exact substring match
  if (t.includes(q)) return 90

  // All query words appear somewhere in target
  const qWords = q.split(/\s+/).filter(Boolean)
  const tWords = t.split(/[\s\-/]+/).filter(Boolean)

  const allQWordsInTarget = qWords.every(qw =>
    tWords.some(tw => tw.startsWith(qw) || tw.includes(qw))
  )
  if (allQWordsInTarget) return 80

  // Most query words match (handles typos / partial input)
  const matchedWords = qWords.filter(qw =>
    tWords.some(tw => tw.startsWith(qw) || tw.includes(qw))
  )
  const ratio = matchedWords.length / qWords.length
  if (ratio >= 0.5) return Math.round(40 + ratio * 40)

  // First-letter abbreviation match (e.g. "bf" → "beef")
  const initials = tWords.map(w => w[0]).join('')
  if (initials.includes(q)) return 50

  return 0
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim()

  const [invItems, prepRecipes] = await Promise.all([
    // Fetch with case-insensitive DB filter — broad net, fuzzy ranking done in JS
    prisma.inventoryItem.findMany({
      where: {
        isActive: true,
        // Exclude items auto-created by PREP recipes — those appear as recipe results
        // (the green "PREPD" entries). Showing them twice would confuse users.
        recipe: null,
        ...(q ? {
          OR: [
            { itemName:     { contains: q, mode: 'insensitive' } },
            { abbreviation: { contains: q, mode: 'insensitive' } },
            // Also catch any word in the name matching any word in the query
            ...q.split(/\s+/).filter(w => w.length > 1).map(word => ({
              itemName: { contains: word, mode: 'insensitive' as const },
            })),
          ],
        } : {}),
      },
      select: { id: true, itemName: true, baseUnit: true, pricePerBaseUnit: true, category: true, abbreviation: true },
      orderBy: { itemName: 'asc' },
      take: 100, // fetch more, re-rank in JS
    }),
    prisma.recipe.findMany({
      where: {
        type: 'PREP',
        isActive: true,
        ...(q ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            ...q.split(/\s+/).filter(w => w.length > 1).map(word => ({
              name: { contains: word, mode: 'insensitive' as const },
            })),
          ],
        } : {}),
      },
      include: {
        ingredients: {
          include: { inventoryItem: { select: { pricePerBaseUnit: true } } },
        },
      },
      orderBy: { name: 'asc' },
      take: 50,
    }),
  ])

  const invResults = invItems.map(item => ({
    type: 'inventory' as const,
    id: item.id,
    name: item.itemName,
    unit: item.baseUnit,
    pricePerBaseUnit: Number(item.pricePerBaseUnit),
    category: item.category,
    _score: q
      ? Math.max(
          fuzzyScore(q, item.itemName),
          item.abbreviation ? fuzzyScore(q, item.abbreviation) : 0
        )
      : 100,
  }))

  const recipeResults = prepRecipes.map(recipe => {
    const totalCost = recipe.ingredients.reduce(
      (s, ing) => s + Number(ing.qtyBase) * Number(ing.inventoryItem?.pricePerBaseUnit ?? 0),
      0
    )
    const yieldQty = Number(recipe.baseYieldQty)
    const pricePerBaseUnit = yieldQty > 0 ? totalCost / yieldQty : 0
    return {
      type: 'recipe' as const,
      id: recipe.id,
      name: recipe.name,
      unit: recipe.yieldUnit,
      pricePerBaseUnit,
      category: 'PREPD',
      _score: q ? fuzzyScore(q, recipe.name) : 100,
    }
  })

  // Sort by score descending, filter out zero-score, return top 20
  const combined = [...invResults, ...recipeResults]
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 20)
    // Strip internal _score field
    .map(({ _score, ...rest }) => rest)

  return NextResponse.json(combined)
}
