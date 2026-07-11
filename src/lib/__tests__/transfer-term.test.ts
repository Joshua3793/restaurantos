import { describe, it, expect, vi } from 'vitest'

// count-expected imports the Prisma singleton at module level; computeExpected is
// pure and never touches it, so stub it out.
vi.mock('@/lib/prisma', () => ({ prisma: {} }))

import { computeExpected } from '@/lib/count-expected'

const ITEM = 'item-1'
const m = (v?: number) => new Map<string, number>(v === undefined ? [] : [[ITEM, v]])

describe('computeExpected — theoretical RC transfer term', () => {
  it('adds a net-positive transfer (stock moved INTO this RC) to the baseline', () => {
    // baseline 0, no other movement, +5 transferred in.
    const got = computeExpected(ITEM, 0, m(), m(), m(), m(), m(), m(5))
    expect(got).toBe(5)
  })

  it('subtracts a net-negative transfer (stock moved OUT of this RC)', () => {
    // main pool with baseline 10, pulled 4 out to another RC → theoretical 6.
    const got = computeExpected(ITEM, 10, m(), m(), m(), m(), m(), m(-4))
    expect(got).toBe(6)
  })

  it('floors at 0 when transfers-out exceed the baseline', () => {
    const got = computeExpected(ITEM, 3, m(), m(), m(), m(), m(), m(-10))
    expect(got).toBe(0)
  })

  it('composes with the other movement terms', () => {
    // baseline 10 + purchases 5 + prepOut 2 + transfersIn 3 − consumption 4 − wastage 1 − prepCons 2
    const got = computeExpected(ITEM, 10, m(4), m(5), m(1), m(2), m(2), m(3))
    expect(got).toBe(10 + 5 + 2 + 3 - 4 - 1 - 2)
  })

  it('is a no-op when no transfer map is passed (back-compat)', () => {
    const got = computeExpected(ITEM, 7, m(), m(), m())
    expect(got).toBe(7)
  })

  it('an equal-and-opposite pair nets to zero across two RCs (ALL = ΣRC preserved)', () => {
    // Source RC loses 5, destination RC gains 5; summed effect on total on-hand is 0.
    const source = computeExpected(ITEM, 5, m(), m(), m(), m(), m(), m(-5))
    const dest   = computeExpected(ITEM, 0, m(), m(), m(), m(), m(), m(5))
    expect(source + dest).toBe(5) // == the original total baseline (5 + 0)
  })
})
