/**
 * The plain sentences of "Change how it's measured" (item backbone Stage 2c).
 * Pure + client-safe — the sheet in the item drawer reads these; the server's
 * summary (`RemeasureSummary`) supplies the numbers.
 */

import type { Dimension } from '@/lib/item-model'
import type { RemeasureSummary } from '@/lib/remeasure-plan'
import { canonicalUom } from '@/lib/uom'

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** weight / volume / pieces — the only words the UI uses for a measure. */
export function measureWord(d: Dimension): 'weight' | 'volume' | 'pieces' {
  return d === 'MASS' ? 'weight' : d === 'VOLUME' ? 'volume' : 'pieces'
}

const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb']
const VOLUME_UNITS = ['ml', 'l']

/** The units the item can be measured in, per measure (the sheet's Unit select). */
export const TARGET_UNITS: Record<Dimension, string[]> = {
  MASS: ['g', 'kg', 'lb', 'oz'],
  VOLUME: ['ml', 'l'],
  COUNT: ['each'],
}

/** The unit the sheet starts the new measure in: the bridge's own unit when it
 *  is a unit of the new measure ("one piece weighs 120 g" → measured in g),
 *  else kg / l. Pieces are always `each`. */
export function defaultTargetUnit(to: Dimension, bridgeUnit: string | null | undefined): string {
  if (to === 'COUNT') return 'each'
  const u = bridgeUnit ? canonicalUom(bridgeUnit) : ''
  if (TARGET_UNITS[to].includes(u)) return u
  return to === 'MASS' ? 'kg' : 'l'
}

/** What the sheet must ask before it can change `from` into `to`: how much one
 *  piece weighs/holds (pieces ↔ weight/volume), or the density (weight ↔ volume). */
export function bridgePrompt(
  from: Dimension, to: Dimension,
): { label: string; unitOptions: string[]; kind: 'each' | 'density' } {
  if (from === 'COUNT' || to === 'COUNT') {
    const measured = from === 'COUNT' ? to : from
    return measured === 'VOLUME'
      ? { label: 'One piece holds', unitOptions: [...VOLUME_UNITS], kind: 'each' }
      : { label: 'One piece weighs', unitOptions: [...WEIGHT_UNITS], kind: 'each' }
  }
  return { label: '1 ml weighs (g)', unitOptions: ['g'], kind: 'density' }
}

/** One bullet per kind of record the change touches. A kind with nothing to
 *  touch is left out — except recipes, which always say where they stand. Then
 *  the planner's warnings, verbatim. */
export function changeLines(s: RemeasureSummary): string[] {
  const out: string[] = []
  const n = (v: unknown) => Math.max(0, Number(v) || 0)

  const counts = n(s.counts?.n)
  if (counts > 0) out.push(`${counts} ${plural(counts, 'count', 'counts')} will be restated.`)

  const receipts = n(s.receipts?.n)
  if (receipts > 0) out.push(`${receipts} ${plural(receipts, 'delivery', 'deliveries')} will be restated.`)

  const boxes = s.boxes?.length ?? 0
  if (boxes > 0) out.push(`${boxes} supplier ${plural(boxes, 'box', 'boxes')} will be re-expressed.`)

  const transfers = n(s.transfers)
  if (transfers > 0) out.push(`${transfers} stock ${plural(transfers, 'transfer', 'transfers')} will be restated.`)

  const recipes = n(s.recipes)
  out.push(recipes > 0
    ? `${recipes} ${plural(recipes, 'recipe keeps', 'recipes keep')} costing through the bridge.`
    : 'No recipe uses it.')

  const wastage = n(s.wastage)
  if (wastage > 0) out.push(`${wastage} wastage ${plural(wastage, 'entry stays', 'entries stay')} as typed.`)

  for (const w of s.warnings ?? []) out.push(w)
  return out
}

/** "5 min ago" · "3 h ago" · "yesterday" · "4 days ago" · "Sep 12" — when a
 *  measure change happened, for the undo row. Empty for an unreadable date. */
export function changedAgo(when: string | Date, now: Date = new Date()): string {
  const t = new Date(when).getTime()
  if (!Number.isFinite(t)) return ''
  const mins = Math.floor((now.getTime() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** The toast once the change is applied. */
export function appliedToast(to: Dimension): string {
  return `Now measured by ${measureWord(to)}. Counts, deliveries and boxes were restated.`
}
