import { describe, it, expect } from 'vitest'
import { mergeSummaryLines, mergeNotes, UNDO_DISABLED_NOTE, combineMergeSummaries } from '@/lib/item-merge-copy'
import type { MergeSummary } from '@/lib/item-merge'

const summary = (over: Partial<MergeSummary> = {}): MergeSummary => ({
  invoiceLines: 0, recipeLines: 0, countLines: 0, snapshots: 0,
  offersMoved: 0, absorbedOffersDroppedStale: 0, absorbedOffersDroppedForSurvivorPrimary: 0,
  survivorOffersReplaced: 0, offerSynthesized: false, primaryPromoted: null,
  countLinesUnfrozen: 0, absorbedOnHand: 0, survivorOnHand: 0,
  ...over,
})

describe('mergeSummaryLines', () => {
  it('renders the four base rows', () => {
    const rows = mergeSummaryLines(summary({ invoiceLines: 10, recipeLines: 2, countLines: 3, snapshots: 4, offersMoved: 1 }))
    expect(rows).toEqual([
      { label: 'Invoice lines moved', value: '10' },
      { label: 'Recipe lines moved', value: '2' },
      { label: 'Count lines / snapshots', value: '3 / 4' },
      { label: 'Supplier offers', value: '1 moved' },
    ])
  })

  it('notes an older duplicate offer dropped, on the offers row', () => {
    const rows = mergeSummaryLines(summary({ offersMoved: 1, absorbedOffersDroppedStale: 1 }))
    expect(rows.find(r => r.label === 'Supplier offers')!.value).toBe('1 moved, 1 older duplicate dropped')
  })

  it('notes a survivor offer replaced, on the offers row', () => {
    const rows = mergeSummaryLines(summary({ offersMoved: 1, survivorOffersReplaced: 1 }))
    expect(rows.find(r => r.label === 'Supplier offers')!.value).toBe('1 moved, 1 replaced')
  })

  it('combines stale-dropped and replaced when both are non-zero', () => {
    const rows = mergeSummaryLines(summary({ offersMoved: 2, absorbedOffersDroppedStale: 1, survivorOffersReplaced: 1 }))
    expect(rows.find(r => r.label === 'Supplier offers')!.value).toBe('2 moved, 1 older duplicate dropped, 1 replaced')
  })

  it('zero offers moved still renders the row', () => {
    const rows = mergeSummaryLines(summary())
    expect(rows.find(r => r.label === 'Supplier offers')!.value).toBe('0 moved')
  })
})

describe('mergeNotes', () => {
  it('is empty when nothing noteworthy happened and undo stays enabled', () => {
    expect(mergeNotes(summary(), false)).toEqual([])
  })

  it('explains a promoted primary supplier', () => {
    const notes = mergeNotes(summary({ primaryPromoted: { supplierName: 'Sysco' } }), false)
    expect(notes).toEqual([
      "Sysco becomes this item's primary supplier. Your costing price doesn't change now; it will follow that supplier's next invoice.",
    ])
  })

  it('explains a dropped price protected by the survivor primary, singular', () => {
    const notes = mergeNotes(summary({ absorbedOffersDroppedForSurvivorPrimary: 1 }), false)
    expect(notes).toEqual([
      "1 newer price from the duplicate was not kept, because this item's primary supplier offer is protected.",
    ])
  })

  it('explains a dropped price protected by the survivor primary, plural', () => {
    const notes = mergeNotes(summary({ absorbedOffersDroppedForSurvivorPrimary: 2 }), false)
    expect(notes).toEqual([
      "2 newer prices from the duplicate were not kept, because this item's primary supplier offer is protected.",
    ])
  })

  it('explains unfrozen count lines, singular', () => {
    const notes = mergeNotes(summary({ countLinesUnfrozen: 1 }), false)
    expect(notes).toEqual([
      "1 old count line uses a unit that couldn't be resolved and was left as it is.",
    ])
  })

  it('explains unfrozen count lines, plural', () => {
    const notes = mergeNotes(summary({ countLinesUnfrozen: 3 }), false)
    expect(notes).toEqual([
      "3 old count lines use a unit that couldn't be resolved and were left as they are.",
    ])
  })

  it('explains a synthesized offer', () => {
    const notes = mergeNotes(summary({ offerSynthesized: true }), false)
    expect(notes).toEqual([
      "The duplicate's pack and price were saved as a supplier offer.",
    ])
  })

  it('appends the undo-disabled note when willDisableUndo is true', () => {
    const notes = mergeNotes(summary(), true)
    expect(notes).toEqual([UNDO_DISABLED_NOTE])
  })

  it('combines every applicable note, in a stable order, undo-disabled last', () => {
    const notes = mergeNotes(summary({
      primaryPromoted: { supplierName: 'Sysco' },
      absorbedOffersDroppedForSurvivorPrimary: 1,
      countLinesUnfrozen: 1,
      offerSynthesized: true,
    }), true)
    expect(notes).toEqual([
      "Sysco becomes this item's primary supplier. Your costing price doesn't change now; it will follow that supplier's next invoice.",
      "1 newer price from the duplicate was not kept, because this item's primary supplier offer is protected.",
      "1 old count line uses a unit that couldn't be resolved and was left as it is.",
      "The duplicate's pack and price were saved as a supplier offer.",
      UNDO_DISABLED_NOTE,
    ])
  })
})

describe('combineMergeSummaries', () => {
  const s = (o: Partial<MergeSummary>): MergeSummary => ({
    invoiceLines: 0, recipeLines: 0, countLines: 0, snapshots: 0, offersMoved: 0,
    absorbedOffersDroppedStale: 0, absorbedOffersDroppedForSurvivorPrimary: 0, survivorOffersReplaced: 0,
    offerSynthesized: false, primaryPromoted: null, countLinesUnfrozen: 0,
    absorbedOnHand: 0, survivorOnHand: 0, ...o,
  })

  it('adds counts, ORs flags, keeps the first promotion and the survivor’s own on-hand', () => {
    const c = combineMergeSummaries([
      s({ invoiceLines: 7, offersMoved: 1, absorbedOnHand: 12, survivorOnHand: 10 }),
      s({ invoiceLines: 3, recipeLines: 2, offerSynthesized: true, primaryPromoted: { supplierName: 'Sysco' }, absorbedOnHand: 5, survivorOnHand: 22 }),
      s({ primaryPromoted: { supplierName: 'GFS' } }),
    ])
    expect(c.invoiceLines).toBe(10)
    expect(c.recipeLines).toBe(2)
    expect(c.offersMoved).toBe(1)
    expect(c.offerSynthesized).toBe(true)
    expect(c.primaryPromoted).toEqual({ supplierName: 'Sysco' })
    expect(c.absorbedOnHand).toBe(17)
    expect(c.survivorOnHand).toBe(10)
  })

  it('one summary comes back unchanged', () => {
    const one = s({ invoiceLines: 4, countLines: 2, snapshots: 1 })
    expect(combineMergeSummaries([one])).toEqual(one)
  })
})
