import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/sales/__tests__/put-tips.test.ts:
// stub Prisma + auth so the route logic runs with no database. `requireSession`
// is a vi.fn so individual tests can override it to simulate an unauthenticated
// caller.
const tipRoleFindUnique = vi.fn(async () => ({ id: 'r1', name: 'Line Cook', multiplier: 1, sortOrder: 0, isActive: true }))
const tipRoleCount = vi.fn(async () => 1)
type RoleRow = { id: string; name: string; multiplier: number; sortOrder: number; isActive: boolean }
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> }

// Nullable on purpose: the self-referential-fallback test resolves it to null,
// which an inferred non-null return type rejects.
const tipRoleFindFirst = vi.fn<() => Promise<RoleRow | null>>(
  async () => ({ id: 'r2', name: 'Prep', multiplier: 1, sortOrder: 1, isActive: true }),
)
const tipRoleUpdate = vi.fn(async ({ where }: UpdateArgs) => ({ id: where.id, name: 'x', multiplier: 1, sortOrder: 0, isActive: false }))
const cookUpdateMany = vi.fn(async () => ({ count: 3 }))
const transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops))
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'MANAGER', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    tipRole: {
      findUnique: (...a: unknown[]) => tipRoleFindUnique(...(a as [])),
      count: (...a: unknown[]) => tipRoleCount(...(a as [])),
      findFirst: (...a: unknown[]) => tipRoleFindFirst(...(a as [])),
      update: (...a: unknown[]) => tipRoleUpdate(...(a as [UpdateArgs])),
    },
    cook: {
      updateMany: (...a: unknown[]) => cookUpdateMany(...(a as [])),
    },
    $transaction: (...a: unknown[]) => transaction(...(a as [Promise<unknown>[]])),
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { PATCH, DELETE } = await import('@/app/api/tips/roles/[id]/route')
const { AuthError } = await import('@/lib/auth')

const req = (body?: Record<string, unknown>, search?: string) =>
  ({
    json: async () => body ?? {},
    nextUrl: { searchParams: new URLSearchParams(search ?? '') },
  }) as unknown as NextRequest

beforeEach(() => {
  tipRoleFindUnique.mockClear(); tipRoleFindUnique.mockResolvedValue({ id: 'r1', name: 'Line Cook', multiplier: 1, sortOrder: 0, isActive: true })
  tipRoleCount.mockClear(); tipRoleCount.mockResolvedValue(1)
  tipRoleFindFirst.mockClear(); tipRoleFindFirst.mockResolvedValue({ id: 'r2', name: 'Prep', multiplier: 1, sortOrder: 1, isActive: true })
  tipRoleUpdate.mockClear()
  cookUpdateMany.mockClear()
  transaction.mockClear()
  requireSession.mockClear(); requireSession.mockResolvedValue({ id: 'u1', role: 'MANAGER', isActive: true })
})

describe('DELETE /api/tips/roles/[id]', () => {
  it('rejects a self-referential fallbackRoleId with 400 and makes no write', async () => {
    // Explicit fallback resolves via findFirst — simulate the buggy pre-fix
    // behaviour NOT happening: since we exclude id: params.id, a self-referential
    // fallbackRoleId must resolve to nothing.
    tipRoleFindFirst.mockResolvedValueOnce(null)
    const res = await DELETE(req(undefined, 'fallbackRoleId=r1'), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleFindFirst).toHaveBeenCalledWith({ where: { id: 'r1', isActive: true, NOT: { id: 'r1' } } })
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('reassigns cooks and deactivates the role inside one transaction, given a valid distinct fallback', async () => {
    const res = await DELETE(req(undefined, 'fallbackRoleId=r2'), { params: { id: 'r1' } })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.movedTo).toBe('r2')
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(cookUpdateMany).toHaveBeenCalledWith({ where: { tipRoleId: 'r1' }, data: { tipRoleId: 'r2' } })
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { isActive: false } })
  })

  it('rejects deleting the last live role with 400', async () => {
    tipRoleCount.mockResolvedValueOnce(0)
    const res = await DELETE(req(undefined, ''), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated caller with 401 and never reaches a write', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await DELETE(req(undefined, 'fallbackRoleId=r2'), { params: { id: 'r1' } })
    expect(res.status).toBe(401)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
    expect(cookUpdateMany).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/tips/roles/[id]', () => {
  it('rejects a non-numeric sortOrder with 400 rather than coercing to 0', async () => {
    const res = await PATCH(req({ sortOrder: 'abc' }), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
  })

  it('accepts a valid integer sortOrder', async () => {
    const res = await PATCH(req({ sortOrder: 3 }), { params: { id: 'r1' } })
    expect(res.status).toBe(200)
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { sortOrder: 3 } })
  })

  it('rejects an unauthenticated caller with 401 and never reaches the update', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await PATCH(req({ sortOrder: 3 }), { params: { id: 'r1' } })
    expect(res.status).toBe(401)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
  })

  // ── a cleared multiplier box must not zero the role ────────────────────────
  // The UI sent parseFloat('') = NaN, which JSON.stringify turns into `null`.
  // `Number(null)` is 0, so `isFinite(v) && v >= 0` passed and everybody on the
  // role was weighted at ×0 and paid nothing — with no audit finding anywhere,
  // because a ×0 role is arithmetically valid.
  it('rejects a null multiplier rather than coercing it to ×0', async () => {
    const res = await PATCH(req({ multiplier: null }), { params: { id: 'r1' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/multiplier/)
    expect(tipRoleUpdate).not.toHaveBeenCalled()
  })

  it('rejects an empty-string, NaN-ish or non-numeric multiplier the same way', async () => {
    for (const multiplier of ['', '   ', 'abc', {}, [], true]) {
      tipRoleUpdate.mockClear()
      const res = await PATCH(req({ multiplier }), { params: { id: 'r1' } })
      expect(res.status).toBe(400)
      expect(tipRoleUpdate).not.toHaveBeenCalled()
    }
  })

  it('still accepts a deliberate ×0, and a numeric string', async () => {
    // ×0 typed on purpose is a legitimate (if unusual) house rule — only a
    // value that is not a number at all is rejected.
    const zero = await PATCH(req({ multiplier: 0 }), { params: { id: 'r1' } })
    expect(zero.status).toBe(200)
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { multiplier: 0 } })

    tipRoleUpdate.mockClear()
    const str = await PATCH(req({ multiplier: '1.25' }), { params: { id: 'r1' } })
    expect(str.status).toBe(200)
    expect(tipRoleUpdate).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { multiplier: 1.25 } })
  })

  it('still rejects a multiplier out of the 0–5 range', async () => {
    expect((await PATCH(req({ multiplier: 6 }), { params: { id: 'r1' } })).status).toBe(400)
    expect((await PATCH(req({ multiplier: -1 }), { params: { id: 'r1' } })).status).toBe(400)
  })
})

/**
 * Roles are HOUSE CONFIGURATION, not part of any one period's split. Paying a
 * period freezes that period's payout snapshot — which already carries every
 * person's resolved role name and multiplier as of payment — so the roles
 * themselves must stay editable. The /tips page used to freeze the whole
 * Settings tab on a PAID period, which (with only one period ever openable)
 * left the payout page permanently dead after the first fortnight was paid.
 *
 * This handler proves the server half: it never consults TipPeriod at all, so
 * there is nothing for a period's status to gate. Adding such a gate here would
 * fail this test.
 */
describe('a paid period does not freeze the roles', () => {
  it('never reads TipPeriod on either verb', async () => {
    const ok = await PATCH(req({ multiplier: 1.5 }), { params: { id: 'r1' } })
    expect(ok.status).toBe(200)
    const del = await DELETE(req(undefined, 'fallbackRoleId=r2'), { params: { id: 'r1' } })
    expect(del.status).toBe(200)
    // The Prisma mock exposes no `tipPeriod` delegate: touching one would throw
    // and surface as a 500 rather than the 200s asserted above.
    expect(tipRoleUpdate).toHaveBeenCalled()
  })
})
