// Recipe Scan: build the review draft from what the reader found, and re-run
// matching on a saved draft when the chef comes back to it. Pure: the loader
// supplies everything in `DraftContext`.
import { similarity } from '@/lib/recipe-match'
import { matchIngredient, resolveCandidates, type Candidate } from './match'
import { parseQty, resolveAmount, singular, type AmountItem } from './amount'
import { toMethod } from './method'
import type { DraftData, DraftLine, ExtractedIngredient, ExtractedRecipe } from './types'

export interface DraftContext {
  candidates: Candidate[]
  aliases: Map<string, { kind: 'item' | 'recipe'; id: string }>
  /** key `${itemId}:${singularWord}` */
  measures: Map<string, { word: string; qty: number; unit: string }>
  /** Per item/recipe id: what its amounts convert into. */
  items: Map<string, AmountItem>
  categories: { id: string; name: string }[]
  revenueCenterId: string | null
  siblingTitles: string[]
}

const SIBLING_AT = 0.85

/** "3 clove" when the page gave a number; otherwise the words left once the name is taken out ("to taste"). */
function qtyTextFor(ing: ExtractedIngredient): string {
  if (typeof ing.qty === 'number' && Number.isFinite(ing.qty)) {
    return `${ing.qty} ${ing.unit ?? ''}`.trim()
  }
  const raw = (ing.raw ?? '').trim()
  const name = (ing.name ?? '').trim()
  if (name) {
    const at = raw.toLowerCase().indexOf(name.toLowerCase())
    if (at >= 0) {
      const rest = (raw.slice(0, at) + ' ' + raw.slice(at + name.length))
        .replace(/^[\s,;:()\-–—]+|[\s,;:()\-–—]+$/g, '')
        .replace(/\s+/g, ' ')
      if (rest) return rest
    }
  }
  return raw
}

const NUM = '[\\d\\s.,/\\-–—½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]'
const LEADING_AMOUNT = new RegExp(`^\\s*(?:\\d|\\.\\d|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])${NUM}*(?:\\bto\\s+${NUM}+)?`, 'i')

/** The number and unit word back out of the text a line was saved with ("3 cloves", "1 1/2 cup"). */
function readQtyText(qtyText: string): { qty: number | null; unit: string | null } {
  const m = LEADING_AMOUNT.exec(qtyText)
  if (!m) return { qty: null, unit: null }
  const qty = parseQty(qtyText)
  const unit = qtyText.slice(m[0].length).trim()
  return { qty, unit: unit || null }
}

interface Outcome {
  link: DraftLine['link']
  qty: number | null
  unit: string | null
  status: DraftLine['status']
  reason: string | null
  matched: boolean
}

function resolveLine(
  ing: ExtractedIngredient, ctx: DraftContext,
): Outcome {
  const m = matchIngredient(ing.name, ing.raw, ctx.candidates, ctx.aliases)
  if (!m.best || m.confidence === 'NONE') {
    return { link: null, qty: null, unit: null, status: 'NO_MATCH', reason: null, matched: false }
  }
  const best = m.best
  const link = { kind: best.kind, id: best.id, name: best.name }
  const item = ctx.items.get(best.id)
  if (!item) {
    return { link, qty: null, unit: null, status: 'CHECK', reason: 'Unit unknown — check', matched: true }
  }
  const word = ing.unit ? singular(ing.unit) : ''
  const learned = word ? ctx.measures.get(`${best.id}:${word}`) ?? null : null
  const r = resolveAmount(ing, item, learned)
  if (m.confidence === 'MEDIUM') {
    return { link, qty: r.qty, unit: r.unit, status: 'CHECK', reason: r.reason ?? 'Close guess — check', matched: true }
  }
  return { link, qty: r.qty, unit: r.unit, status: r.status, reason: r.reason, matched: true }
}

function siblingFor(name: string, titles: string[]): string | null {
  let best: string | null = null
  let bestScore = SIBLING_AT
  for (const t of titles) {
    const s = similarity(name, t)
    if (s >= bestScore) { best = t; bestScore = s }
  }
  return best
}

export function buildDraft(r: ExtractedRecipe, ctx: DraftContext): DraftData {
  const lines: DraftLine[] = []
  const siblingHints: Record<string, string> = {}

  r.ingredients.forEach((ing, i) => {
    const key = `l${i + 1}`
    const o = resolveLine(ing, ctx)
    lines.push({
      key, raw: ing.raw, name: ing.name, qtyText: qtyTextFor(ing),
      qty: o.qty, unit: o.unit, link: o.link, status: o.status, reason: o.reason,
      allergens: null,
    })
    if (!o.matched) {
      const hint = siblingFor(ing.name, ctx.siblingTitles)
      if (hint) siblingHints[key] = hint
    }
  })

  const { method, guessed } = toMethod(r.steps)
  const hasYield = typeof r.yieldQty === 'number' && Number.isFinite(r.yieldQty) && r.yieldQty > 0
  const hint = (r.categoryHint ?? '').trim().toLowerCase()
  const category = hint ? ctx.categories.find(c => c.name.trim().toLowerCase() === hint) : undefined

  return {
    name: r.name,
    yieldQty: hasYield ? r.yieldQty : null,
    yieldUnit: r.yieldUnit ?? null,
    yieldGuessed: !hasYield,
    categoryId: category?.id ?? null,
    revenueCenterId: ctx.revenueCenterId,
    lines,
    method,
    guessed,
    siblingHints,
  }
}

/**
 * Re-open a saved draft: a link to something that is no longer an active item
 * or recipe (deleted, deactivated, merged away) is dropped, then every
 * unmatched line the chef has not decided on (no allergens chosen) gets another
 * go, and so does one waiting on a sibling recipe, so a sibling saved since
 * last time is linked now. A line the chef linked, or kept unlinked on purpose
 * (allergens chosen), is never touched.
 */
export function rematchDraft(d: DraftData, ctx: DraftContext): DraftData {
  const live = new Set(resolveCandidates(ctx.candidates).list.map(c => `${c.kind}:${c.id}`))
  const siblingHints = { ...d.siblingHints }

  const lines = d.lines.map((line): DraftLine => {
    let cur = line
    if (cur.link && !live.has(`${cur.link.kind}:${cur.link.id}`)) {
      cur = { ...cur, link: null, qty: null, unit: null, status: 'NO_MATCH', reason: null, allergens: null }
      delete cur.createdItem
    }
    if (cur.link || cur.status !== 'NO_MATCH') return cur
    // The chef already decided about this line (allergens chosen = "keep it
    // uncosted"): leave it alone, unless it is waiting on a sibling recipe.
    if (cur.allergens !== null && !siblingHints[cur.key]) return cur

    const { qty, unit } = readQtyText(cur.qtyText)
    const o = resolveLine({ raw: cur.raw, name: cur.name, qty, unit }, ctx)
    if (!o.matched) return cur
    delete siblingHints[cur.key]
    return { ...cur, link: o.link, qty: o.qty, unit: o.unit, status: o.status, reason: o.reason, allergens: null }
  })

  return { ...d, lines, siblingHints }
}
