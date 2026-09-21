// Turns a MergeSummary (see src/lib/item-merge.ts) into UI copy. PURE — no
// fetch, no DOM — so it is the one testable part of the merge sheet (Task 10
// addendum). Keep every sentence here in sync with MergeSummary's own field
// comments; nothing here re-derives a number the planner didn't already count.

import type { MergeSummary } from '@/lib/item-merge'

export interface MergeSummaryLine { label: string; value: string }

/** The routine, always-shown facts about what moved. Order matches the brief's
 *  original sketch (invoice → recipe → count/snapshots → offers). */
export function mergeSummaryLines(summary: MergeSummary): MergeSummaryLine[] {
  const offerParts = [`${summary.offersMoved} moved`]
  if (summary.absorbedOffersDroppedStale > 0) offerParts.push(`${summary.absorbedOffersDroppedStale} older duplicate dropped`)
  if (summary.survivorOffersReplaced > 0) offerParts.push(`${summary.survivorOffersReplaced} replaced`)

  return [
    { label: 'Invoice lines moved', value: String(summary.invoiceLines) },
    { label: 'Recipe lines moved', value: String(summary.recipeLines) },
    { label: 'Count lines / snapshots', value: `${summary.countLines} / ${summary.snapshots}` },
    { label: 'Supplier offers', value: offerParts.join(', ') },
  ]
}

export const UNDO_DISABLED_NOTE =
  "Setting the combined on-hand records a count, so this merge can't be undone afterwards."

/** The exceptional, plain-English call-outs — only present when the
 *  corresponding summary field is non-zero/non-null (or, for the last one,
 *  when the caller says the confirm request will disable undo). */
export function mergeNotes(summary: MergeSummary, willDisableUndo: boolean): string[] {
  const notes: string[] = []

  if (summary.primaryPromoted) {
    notes.push(
      `${summary.primaryPromoted.supplierName} becomes this item's primary supplier. ` +
      `Your costing price doesn't change now; it will follow that supplier's next invoice.`,
    )
  }

  if (summary.absorbedOffersDroppedForSurvivorPrimary > 0) {
    const n = summary.absorbedOffersDroppedForSurvivorPrimary
    const priceWord = n === 1 ? 'price' : 'prices'
    const wasWord = n === 1 ? 'was' : 'were'
    notes.push(
      `${n} newer ${priceWord} from the duplicate ${wasWord} not kept, ` +
      `because this item's primary supplier offer is protected.`,
    )
  }

  if (summary.countLinesUnfrozen > 0) {
    const n = summary.countLinesUnfrozen
    const lineWord = n === 1 ? 'line' : 'lines'
    const useWord = n === 1 ? 'uses' : 'use'
    const wasWord = n === 1 ? 'was' : 'were'
    const itWord = n === 1 ? 'it is' : 'they are'
    notes.push(
      `${n} old count ${lineWord} ${useWord} a unit that couldn't be resolved and ${wasWord} left as ${itWord}.`,
    )
  }

  if (summary.offerSynthesized) {
    notes.push(`The duplicate's pack and price were saved as a supplier offer.`)
  }

  if (willDisableUndo) {
    notes.push(UNDO_DISABLED_NOTE)
  }

  return notes
}
