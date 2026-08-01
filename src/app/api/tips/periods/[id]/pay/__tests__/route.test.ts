import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// The pay route is append-only over TipPeriod.snapshot, so a single
// findUnique/update pair is not enough to test it: the reopen → re-pay cycle
// has to read back what the previous write stored. `stored` is that row.
let stored: Record<string, unknown>
const tipPeriodFindUnique = vi.fn(async () => stored as Record<string, unknown> | null)
const tipPeriodUpdateMany = vi.fn(async (
  { where, data }: { where: Record<string, unknown>; data: Record<string, unknown> },
) => {
  // Mirrors Prisma: the row is only written when the WHERE still matches.
  if (where.status !== undefined && stored.status !== where.status) return { count: 0 }
  stored = { ...stored, ...data }
  return { count: 1 }
})
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true, name: 'Jo Manager', email: 'jo@x.test' }))
const isRcInScope = vi.fn(async () => true)

type Built = {
  split: { people: unknown[]; poolTotal: number; distributedTotal: number }
  audit: { counts: { error: number }; findings: Array<{ severity: string; title: string }> }
  poolBasis: string; poolRatePct: number; roundingStepCents: number
  dayLabels: string[]; basis: number[]; sales: number[]; tips: Array<number | null>
  tipTotal: number; roles: unknown[]
}
const cleanBuild: Built = {
  split: { people: [{ cookId: 'c1', name: 'Ana', roleId: 'r1', roleName: 'Cook', multiplier: 1, dailyHourCap: 8 }], poolTotal: 100, distributedTotal: 100 },
  audit: { counts: { error: 0 }, findings: [] },
  poolBasis: 'NET_SALES', poolRatePct: 5, roundingStepCents: 100,
  dayLabels: ['Sun 12'], basis: [1000], sales: [1000], tips: [50], tipTotal: 50, roles: [],
}
const buildPeriodSplit = vi.fn(async (): Promise<Built | null> => cleanBuild)

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipPeriod: {
      findUnique: (...a: unknown[]) => tipPeriodFindUnique(...(a as [])),
      updateMany: (...a: unknown[]) => tipPeriodUpdateMany(
        ...(a as [{ where: Record<string, unknown>; data: Record<string, unknown> }]),
      ),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/rc-scope', () => ({
  isRcInScope: (...a: unknown[]) => isRcInScope(...(a as [])),
}))
vi.mock('@/lib/tips/build', () => ({
  buildPeriodSplit: (...a: unknown[]) => buildPeriodSplit(...(a as [])),
}))

const { POST } = await import('@/app/api/tips/periods/[id]/pay/route')
const { AuthError } = await import('@/lib/auth')
const { readSnapshot, payoutsInOrder, MAX_PAYOUT_HISTORY } = await import('@/lib/tips/snapshot')

const req = (body: Record<string, unknown>) => ({ json: async () => body }) as unknown as NextRequest
const snapshotOf = () => readSnapshot(stored.snapshot)
const lastData = () => tipPeriodUpdateMany.mock.calls[tipPeriodUpdateMany.mock.calls.length - 1][0].data

beforeEach(() => {
  stored = {
    id: 'p1', revenueCenterId: 'rc1', startDate: '2026-07-12', endDate: '2026-07-14',
    status: 'DRAFT', paidAt: null, paidByName: null, snapshot: null,
  }
  tipPeriodFindUnique.mockClear()
  tipPeriodUpdateMany.mockClear()
  requireSession.mockClear()
  requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true, name: 'Jo Manager', email: 'jo@x.test' })
  isRcInScope.mockClear(); isRcInScope.mockResolvedValue(true)
  buildPeriodSplit.mockClear(); buildPeriodSplit.mockResolvedValue(cleanBuild)
})

describe('POST /api/tips/periods/[id]/pay', () => {
  it('rejects an unauthenticated caller with 401 and never reaches the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(401)
    expect(tipPeriodUpdateMany).not.toHaveBeenCalled()
    expect(buildPeriodSplit).not.toHaveBeenCalled()
  })

  it('rejects an out-of-scope period with 403', async () => {
    isRcInScope.mockResolvedValueOnce(false)
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(403)
    expect(tipPeriodUpdateMany).not.toHaveBeenCalled()
  })

  it('refuses to pay a period that has an unresolved error finding', async () => {
    buildPeriodSplit.mockResolvedValueOnce({
      ...cleanBuild,
      audit: { counts: { error: 2 }, findings: [{ severity: 'error', title: 'Two people are not on the roster' }, { severity: 'warn', title: 'noise' }] },
    })
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.findings).toEqual(['Two people are not on the roster'])
    expect(tipPeriodUpdateMany).not.toHaveBeenCalled()
  })

  it('refuses to pay a period that is already PAID', async () => {
    stored.status = 'PAID'
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(buildPeriodSplit).not.toHaveBeenCalled()
    expect(tipPeriodUpdateMany).not.toHaveBeenCalled()
  })

  it('freezes a clean period, writing status PAID and a snapshot with the resolved per-person split', async () => {
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('PAID')
    expect(tipPeriodUpdateMany).toHaveBeenCalledTimes(1)
    const data = lastData()
    expect(data.status).toBe('PAID')
    expect(data.paidByName).toBe('Jo Manager')

    const payout = snapshotOf()!.current!
    expect(payout.seq).toBe(1)
    expect(payout.split.people).toEqual(cleanBuild.split.people)
    // Per-person resolved cap + role must be reconstructable from the frozen split.
    expect(payout.split.people[0] as unknown as Record<string, unknown>)
      .toMatchObject({ dailyHourCap: 8, roleName: 'Cook', multiplier: 1 })
    expect(payout.audit).toEqual(cleanBuild.audit)
  })

  it('captures paidByName INSIDE the snapshot, not only on the mutable column that reopen nulls', async () => {
    await POST(req({}), { params: { id: 'p1' } })
    expect(snapshotOf()!.current!.paidByName).toBe('Jo Manager')
  })

  it('takes the optimistic-concurrency lock on status DRAFT so a second concurrent pay cannot overwrite the first', async () => {
    await POST(req({}), { params: { id: 'p1' } })
    expect(tipPeriodUpdateMany.mock.calls[0][0].where).toMatchObject({ id: 'p1', status: 'DRAFT' })
  })

  it('409s the loser of a pay race instead of silently replacing the winner\'s payout', async () => {
    // Both callers read DRAFT and both build; the row is PAID by the time the
    // second one writes, so its updateMany matches zero rows.
    tipPeriodUpdateMany.mockImplementationOnce(async () => ({ count: 0 }))
    const res = await POST(req({}), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already paid/)
  })

  it('refuses to reopen a period that is not PAID', async () => {
    const res = await POST(req({ reopen: true }), { params: { id: 'p1' } })
    expect(res.status).toBe(409)
    expect(tipPeriodUpdateMany).not.toHaveBeenCalled()
  })

  it('reopens a PAID period back to DRAFT', async () => {
    await POST(req({}), { params: { id: 'p1' } })
    const res = await POST(req({ reopen: true }), { params: { id: 'p1' } })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('DRAFT')
    expect(stored.status).toBe('DRAFT')
    expect(stored.paidAt).toBeNull()
  })

  it('does not leave a reopened DRAFT period looking paid — the payout moves to history, current goes null', async () => {
    await POST(req({}), { params: { id: 'p1' } })
    await POST(req({ reopen: true }), { params: { id: 'p1' } })
    const snap = snapshotOf()!
    // The record survives...
    expect(snap.history).toHaveLength(1)
    expect(snap.history[0].paidByName).toBe('Jo Manager')
    // ...but nothing can read a live frozen payout off a DRAFT period.
    expect(snap.current).toBeNull()
  })

  it('preserves payout #1 with its OWN paidAt and paidByName across a reopen → edit → re-pay cycle', async () => {
    // Pinned clock: two pays in the same millisecond would make the
    // distinct-timestamp assertion below flaky rather than meaningful.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-20T18:00:00.000Z'))
      await POST(req({}), { params: { id: 'p1' } })
      const firstPaidAt = snapshotOf()!.current!.paidAt
      expect(firstPaidAt).toBe('2026-07-20T18:00:00.000Z')

      await POST(req({ reopen: true }), { params: { id: 'p1' } })

      // A different manager re-pays after an edit; the numbers changed too.
      vi.setSystemTime(new Date('2026-07-21T09:30:00.000Z'))
      requireSession.mockResolvedValueOnce({ id: 'u2', role: 'MANAGER', isActive: true, name: 'Sam Second', email: 'sam@x.test' })
      buildPeriodSplit.mockResolvedValueOnce({ ...cleanBuild, tipTotal: 77 })
      await POST(req({}), { params: { id: 'p1' } })

      const all = payoutsInOrder(snapshotOf())
      expect(all).toHaveLength(2)
      expect(all.map(p => p.seq)).toEqual([1, 2])
      expect(all[0].paidByName).toBe('Jo Manager')
      expect(all[0].paidAt).toBe('2026-07-20T18:00:00.000Z')
      expect(all[0].tipTotal).toBe(50) // what was actually handed out the first time
      expect(all[1].paidByName).toBe('Sam Second')
      expect(all[1].tipTotal).toBe(77)
      expect(all[1].paidAt).toBe('2026-07-21T09:30:00.000Z')
      expect(snapshotOf()!.current!.seq).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the history, counting what fell off rather than pretending it never happened', async () => {
    for (let i = 0; i < MAX_PAYOUT_HISTORY + 2; i++) {
      await POST(req({}), { params: { id: 'p1' } })
      await POST(req({ reopen: true }), { params: { id: 'p1' } })
    }
    await POST(req({}), { params: { id: 'p1' } })
    const snap = snapshotOf()!
    expect(payoutsInOrder(snap)).toHaveLength(MAX_PAYOUT_HISTORY)
    expect(snap.trimmed).toBe(3)
    // seq keeps counting, so the gap at the front of history is visible.
    expect(snap.current!.seq).toBe(MAX_PAYOUT_HISTORY + 3)
  })
})
