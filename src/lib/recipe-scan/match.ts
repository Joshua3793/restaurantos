// Pure ingredient matcher for Recipe Scan: a scanned ingredient name (+ the raw
// line) → the closest active inventory item or PREP recipe. Scoring stays the
// app's plain word-overlap `similarity`; both sides are only pre-normalised
// (accents folded, simple plurals singularised) so "tomatoes" meets "Tomato"
// and "jalapeños" meets "Jalapeno".

import { normaliseAliasText } from '@/lib/alias-text'
import { similarity } from '@/lib/recipe-match'

export interface Candidate {
  kind: 'item' | 'recipe'
  id: string
  name: string
  active: boolean
  mergedIntoId: string | null
  usedInRecipes: number
  boughtAs: string
  supplier: string | null
}

export interface MatchResult {
  best: Candidate | null
  confidence: 'HIGH' | 'MEDIUM' | 'NONE'
  options: Candidate[] // top 5, best first
}

type Ref = { kind: 'item' | 'recipe'; id: string }

const HIGH_AT = 0.85
const MEDIUM_AT = 0.5
const MAX_OPTIONS = 5

function singular(w: string): string {
  if (w.length <= 3 || !w.endsWith('s')) return w
  if (/(ss|us|is)$/.test(w)) return w
  if (/(o|x|ch|sh|z)es$/.test(w)) return w.slice(0, -2) // tomatoes, peaches
  return w.slice(0, -1) // olives, lentils
}

/** Accent-folded, lower-cased, singularised words joined by single spaces. */
function prep(s: string): string {
  return normaliseAliasText(s).split(' ').filter(Boolean).map(singular).join(' ')
}

const key = (kind: string, id: string) => `${kind}:${id}`

/** Active candidates only; a merged one is swapped for its (active) target. */
export function resolveCandidates(all: Candidate[]): { list: Candidate[]; byKey: Map<string, Candidate> } {
  const raw = new Map<string, Candidate>()
  for (const cand of all) raw.set(key(cand.kind, cand.id), cand)

  const resolve = (cand: Candidate): Candidate | null => {
    let cur: Candidate = cand
    for (let hops = 0; hops < 10; hops++) {
      if (!cur.mergedIntoId) return cur.active ? cur : null
      const next = raw.get(key(cur.kind, cur.mergedIntoId))
      if (!next) return null
      cur = next
    }
    return null
  }

  const list: Candidate[] = []
  const byKey = new Map<string, Candidate>()
  const seen = new Set<string>()
  for (const cand of all) {
    const target = resolve(cand)
    if (!target) continue
    byKey.set(key(cand.kind, cand.id), target)
    const k = key(target.kind, target.id)
    if (seen.has(k)) continue
    seen.add(k)
    list.push(target)
  }
  return { list, byKey }
}

export function matchIngredient(
  name: string,
  raw: string,
  candidates: Candidate[],
  aliases: Map<string, Ref>,
): MatchResult {
  const { list, byKey } = resolveCandidates(candidates)

  const scored = list.map(cand => {
    const exact = prep(cand.name) !== '' && prep(cand.name) === prep(name)
    return { cand, score: exact ? 1 : similarity(prep(name), prep(cand.name)) }
  })
  scored.sort((a, b) =>
    b.score - a.score ||
    b.cand.usedInRecipes - a.cand.usedInRecipes ||
    a.cand.name.localeCompare(b.cand.name))

  // An alias to an id that is not an active candidate (after merges) is ignored.
  let aliased: Candidate | null = null
  for (const text of [name, raw]) {
    const k = normaliseAliasText(text)
    const ref = k ? aliases.get(k) : undefined
    const hit = ref ? byKey.get(key(ref.kind, ref.id)) : undefined
    if (hit) { aliased = hit; break }
  }

  const ordered = scored.map(s => s.cand)
  const options = aliased
    ? [aliased, ...ordered.filter(x => x !== aliased)].slice(0, MAX_OPTIONS)
    : ordered.slice(0, MAX_OPTIONS)

  if (aliased) return { best: aliased, confidence: 'HIGH', options }

  const top = scored[0]
  if (!top || top.score < MEDIUM_AT) return { best: null, confidence: 'NONE', options }
  return { best: top.cand, confidence: top.score >= HIGH_AT ? 'HIGH' : 'MEDIUM', options }
}
