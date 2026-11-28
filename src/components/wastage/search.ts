// Fuzzy score mirroring the server-side matcher in /api/inventory/search — kept
// client-side so the waste picker can search the full loaded list (including PREP
// items, which that endpoint deliberately excludes). Shared by the phone sheet and
// the desktop picker.
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim()
  const t = target.toLowerCase().trim()
  if (!q) return 100
  if (t === q) return 100
  if (t.includes(q)) return 90
  const qWords = q.split(/\s+/).filter(Boolean)
  const tWords = t.split(/[\s\-/]+/).filter(Boolean)
  const allMatch = qWords.every(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  if (allMatch) return 80
  const matched = qWords.filter(qw => tWords.some(tw => tw.startsWith(qw) || tw.includes(qw)))
  const ratio = matched.length / qWords.length
  return ratio >= 0.5 ? Math.round(40 + ratio * 40) : 0
}

/** Best `limit` matches for the query; the first `limit` items when it is blank. */
export function rankItems<T extends { itemName: string }>(items: T[], query: string, limit = 8): T[] {
  const q = query.trim()
  if (!q) return items.slice(0, limit)
  return items
    .map(item => ({ item, score: fuzzyScore(q, item.itemName) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.item)
}
