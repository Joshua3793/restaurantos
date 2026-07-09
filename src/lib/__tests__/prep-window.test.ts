import { describe, it, expect, vi } from 'vitest'

// count-expected imports the Prisma singleton at module level; prepEventCounts
// is pure and never touches it, so stub it out.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { prepEventCounts } from '@/lib/count-expected'

const ITEM = 'item-1'
const d = (iso: string) => new Date(iso)

describe('prepEventCounts (count-owns-its-day, timestamp-precise for prep)', () => {
  it('credits prep recorded AFTER the count was finalized — even same calendar day', () => {
    // Counted this morning at 00:52, prepped this afternoon at 15:05 (the reported bug).
    const finalizedAt = new Map([[ITEM, d('2026-07-09T00:52:54Z')]])
    const cutoff = new Map([[ITEM, d('2026-07-09T00:00:00Z')]]) // lastCountDate (day)
    const created = d('2026-07-09T15:05:13Z')
    const logDate = d('2026-07-09T00:00:00Z')
    expect(prepEventCounts(finalizedAt, cutoff, ITEM, created, logDate)).toBe(true)
  })

  it('ignores prep recorded BEFORE the count finalized (already reflected in the count)', () => {
    const finalizedAt = new Map([[ITEM, d('2026-07-09T17:00:00Z')]])
    const cutoff = new Map([[ITEM, d('2026-07-09T00:00:00Z')]])
    const created = d('2026-07-09T09:00:00Z') // made in the morning, counted at 5pm
    const logDate = d('2026-07-09T00:00:00Z')
    expect(prepEventCounts(finalizedAt, cutoff, ITEM, created, logDate)).toBe(false)
  })

  it('credits prep on a later day than the count', () => {
    const finalizedAt = new Map([[ITEM, d('2026-07-09T00:52:54Z')]])
    const cutoff = new Map([[ITEM, d('2026-07-09T00:00:00Z')]])
    const created = d('2026-07-10T08:00:00Z')
    const logDate = d('2026-07-10T00:00:00Z')
    expect(prepEventCounts(finalizedAt, cutoff, ITEM, created, logDate)).toBe(true)
  })

  it('falls back to the day-granular window when the item has no finalized count', () => {
    // Never counted → no finalizedAt, no cutoff entry → every event counts.
    expect(
      prepEventCounts(new Map(), new Map(), ITEM, d('2026-07-09T15:00:00Z'), d('2026-07-09T00:00:00Z')),
    ).toBe(true)
  })

  it('falls back to the day rule (excludes count-day) when only a day-granular cutoff exists', () => {
    // No precise finalize time known, but the item was counted 2026-07-09 → a log
    // dated the same day is excluded, a log dated the next day is included.
    const cutoff = new Map([[ITEM, d('2026-07-09T00:00:00Z')]])
    expect(prepEventCounts(undefined, cutoff, ITEM, d('2026-07-09T15:00:00Z'), d('2026-07-09T00:00:00Z'))).toBe(false)
    expect(prepEventCounts(undefined, cutoff, ITEM, d('2026-07-10T15:00:00Z'), d('2026-07-10T00:00:00Z'))).toBe(true)
  })
})
