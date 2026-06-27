/**
 * Lightweight name-similarity matcher for suggesting a Recipe for a raw POS item
 * name. Used as a one-time *suggestion* engine — the authoritative link is the
 * Toast item GUID (`ToastItemMap.recipeId`), set once and permanent. Shared by
 * the Toast item-mapping UI and the legacy Excel sales import.
 */

export type MatchConfidence = 'exact' | 'fuzzy' | 'none'

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Very simple word-overlap similarity 0–1. */
export function similarity(a: string, b: string): number {
  const na = normalize(a).split(' ').filter(Boolean)
  const nb = normalize(b).split(' ').filter(Boolean)
  if (!na.length || !nb.length) return 0
  const setB = new Set(nb)
  const uniqueA = na.filter((v, i, arr) => arr.indexOf(v) === i)
  let overlap = 0
  for (const w of uniqueA) if (setB.has(w)) overlap++
  return overlap / Math.max(uniqueA.length, setB.size)
}

export interface RecipeMatch {
  id: string
  name: string
  confidence: MatchConfidence
}

/** Find the best recipe match for a raw item name, or null below threshold. */
export function matchRecipe(
  rawName: string,
  recipes: { id: string; name: string }[],
): RecipeMatch | null {
  const nRaw = normalize(rawName)

  // 1. Exact (case-insensitive)
  const exact = recipes.find((r) => normalize(r.name) === nRaw)
  if (exact) return { id: exact.id, name: exact.name, confidence: 'exact' }

  // 2. One contains the other
  const contains = recipes.find((r) => {
    const nr = normalize(r.name)
    return nr.includes(nRaw) || nRaw.includes(nr)
  })
  if (contains) return { id: contains.id, name: contains.name, confidence: 'fuzzy' }

  // 3. Word-overlap ≥ 0.5
  let best: { id: string; name: string } | null = null
  let bestScore = 0
  for (const r of recipes) {
    const score = similarity(rawName, r.name)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  if (best && bestScore >= 0.5) return { id: best.id, name: best.name, confidence: 'fuzzy' }

  return null
}
