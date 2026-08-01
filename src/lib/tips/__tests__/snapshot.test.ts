import { describe, it, expect } from 'vitest'
import {
  MAX_PAYOUT_HISTORY, appendPayout, nextSeq, payoutsInOrder, readSnapshot,
} from '@/lib/tips/snapshot'
import type { TipPayoutRecord } from '@/lib/tips/types'
import { reopenSnapshot } from '@/lib/tips/snapshot'

const payout = (over: Partial<TipPayoutRecord> = {}) => ({
  paidAt: '2026-07-20T18:00:00.000Z',
  paidByName: 'Jo Manager',
  poolBasis: 'NET_SALES' as const,
  poolRatePct: 5,
  roundingStepCents: 100,
  dayLabels: ['Sun 12'],
  basis: [1000],
  sales: [1000],
  tips: [50] as Array<number | null>,
  tipTotal: 50,
  roles: [],
  split: { people: [] } as unknown as TipPayoutRecord['split'],
  audit: { counts: { error: 0 } } as unknown as TipPayoutRecord['audit'],
  ...over,
})

describe('readSnapshot', () => {
  it('reads null / a non-object as no snapshot', () => {
    expect(readSnapshot(null)).toBeNull()
    expect(readSnapshot(undefined)).toBeNull()
    expect(readSnapshot('nope')).toBeNull()
    expect(readSnapshot([1, 2])).toBeNull()
  })

  it('migrates a LEGACY flat snapshot — periods paid before the history existed — into payout #1', () => {
    const legacy = { paidAt: '2026-07-01T12:00:00.000Z', split: { people: [] }, audit: {} }
    const snap = readSnapshot(legacy)!
    expect(snap.version).toBe(1)
    expect(snap.current!.seq).toBe(1)
    expect(snap.current!.paidAt).toBe('2026-07-01T12:00:00.000Z')
    // The old shape never captured the authoriser. Report unknown, never invent.
    expect(snap.current!.paidByName).toBeNull()
    expect(snap.history).toEqual([])
  })

  it('refuses to present an unrecognisable blob as a payout', () => {
    expect(readSnapshot({ hello: 'world' })).toBeNull()
  })
})

describe('appendPayout', () => {
  it('records the first payout as current, seq 1, with its authoriser inside the record', () => {
    const snap = appendPayout(null, payout())
    expect(snap.current!.seq).toBe(1)
    expect(snap.current!.paidByName).toBe('Jo Manager')
    expect(snap.history).toEqual([])
  })

  it('never destroys an earlier payout — the previous current is pushed onto history', () => {
    const first = appendPayout(null, payout({ paidByName: 'Jo Manager', tipTotal: 50 }))
    const reopened = reopenSnapshot(first)
    const second = appendPayout(reopened, payout({ paidByName: 'Sam Second', tipTotal: 77, paidAt: '2026-07-21T18:00:00.000Z' }))

    const all = payoutsInOrder(second)
    expect(all.map(p => [p.seq, p.paidByName, p.tipTotal])).toEqual([
      [1, 'Jo Manager', 50],
      [2, 'Sam Second', 77],
    ])
  })

  it('appends correctly even when the previous snapshot is a legacy flat one', () => {
    const legacy = { paidAt: '2026-07-01T12:00:00.000Z', split: { people: [] }, audit: {} }
    const next = appendPayout(legacy, payout({ paidByName: 'Sam Second' }))
    expect(payoutsInOrder(next).map(p => p.seq)).toEqual([1, 2])
    expect(next.history[0].paidByName).toBeNull()
  })

  it('bounds the history and counts what fell off, so seq gaps stay explainable', () => {
    let snap = appendPayout(null, payout())
    for (let i = 0; i < MAX_PAYOUT_HISTORY + 2; i++) {
      snap = appendPayout(reopenSnapshot(snap), payout())
    }
    expect(payoutsInOrder(snap)).toHaveLength(MAX_PAYOUT_HISTORY)
    expect(snap.trimmed).toBe(3)
    expect(snap.current!.seq).toBe(MAX_PAYOUT_HISTORY + 3)
    // seq is never reused, even after trimming.
    expect(nextSeq(snap)).toBe(MAX_PAYOUT_HISTORY + 4)
  })
})

describe('reopenSnapshot', () => {
  it('retains the payout as history and leaves current null, so the period stops looking paid', () => {
    const snap = reopenSnapshot(appendPayout(null, payout()))!
    expect(snap.current).toBeNull()
    expect(snap.history).toHaveLength(1)
    expect(snap.history[0].paidByName).toBe('Jo Manager')
  })

  it('is idempotent — reopening an already-reopened period does not duplicate the payout', () => {
    const once = reopenSnapshot(appendPayout(null, payout()))!
    const twice = reopenSnapshot(once)!
    expect(twice.history).toHaveLength(1)
    expect(twice.current).toBeNull()
  })

  it('reads through as null when there was never a snapshot', () => {
    expect(reopenSnapshot(null)).toBeNull()
  })
})
