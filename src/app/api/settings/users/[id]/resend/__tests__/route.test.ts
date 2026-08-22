import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/settings/users/__tests__/invite.test.ts.
//
// What these tests exist for: a resend DELETES the Supabase auth user and
// re-invites, minting a NEW auth UUID, then re-keys the Prisma User row onto
// it. `Cook.userId` is `onDelete: SetNull` (prisma/schema.prisma), so without
// an explicit re-point the roster row is silently unlinked — losing a payroll
// link that is only ever set by deliberate admin action, while the Identity
// tab's copy promises it is kept.

const CALLS: string[] = []

const userFindUnique = vi.fn(async () => ({
  id: 'user-old', email: 'sam@fergies.test', name: 'Sam Lee',
  role: 'STAFF', isActive: false,
}) as { id: string; email: string; name: string | null; role: string; isActive: boolean } | null)
const userScopeFindMany = vi.fn(async () => [
  { locationId: 'loc1', revenueCenterId: null, clearance: null },
] as unknown[])
const userDeleteMany = vi.fn(async () => { CALLS.push('user.deleteMany'); return { count: 1 } })
const userCreate = vi.fn(async () => { CALLS.push('user.create'); return { id: 'user-new' } })
const userScopeCreateMany = vi.fn(async () => { CALLS.push('userScope.createMany'); return { count: 1 } })

// Returns the linked roster row by default; a test flips it to null for the
// (much more common) unlinked case.
const cookFindUnique = vi.fn(async () => {
  CALLS.push('cook.findUnique')
  return { id: 'cook-1' } as { id: string } | null
})
const cookUpdate = vi.fn(async () => { CALLS.push('cook.update'); return { id: 'cook-1' } })

const tx = {
  user: {
    deleteMany: (...a: unknown[]) => userDeleteMany(...(a as [])),
    create: (...a: unknown[]) => userCreate(...(a as [])),
  },
  userScope: { createMany: (...a: unknown[]) => userScopeCreateMany(...(a as [])) },
  cook: {
    findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])),
    update: (...a: unknown[]) => cookUpdate(...(a as [])),
  },
}
const prismaTransaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx))

const requireSession = vi.fn(async () => ({
  id: 'admin1', email: 'admin@fergies.test', name: 'Admin', role: 'ADMIN', isActive: true,
}))
class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message); this.name = 'AuthError'
  }
}

const deleteUser = vi.fn(async () => { CALLS.push('supabase.deleteUser'); return { error: null } })
const inviteUserByEmail = vi.fn(async () => ({
  data: { user: { id: 'user-new' } as { id: string } | null },
  error: null as { message: string } | null,
}))

type AuthUser = { id: string; email_confirmed_at: string | null }
const PENDING: AuthUser = { id: 'user-old', email_confirmed_at: null }
const findAuthUserByEmail = vi.fn(async (): Promise<AuthUser | null> => PENDING)
// A real vi.fn, not a fixed stub: it selects between the re-invite path and
// the "already accepted" refusal, and both are asserted below.
const hasAcceptedInvite = vi.fn((u: AuthUser) => !!u.email_confirmed_at)
const recordAccessEvent = vi.fn(async () => undefined)

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) => prismaTransaction(...(a as [(t: typeof tx) => Promise<unknown>])),
    user: { findUnique: (...a: unknown[]) => userFindUnique(...(a as [])) },
    userScope: { findMany: (...a: unknown[]) => userScopeFindMany(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { deleteUser, inviteUserByEmail } } }),
}))
vi.mock('@/lib/users', () => ({
  findAuthUserByEmail: (...a: unknown[]) => findAuthUserByEmail(...(a as [])),
  hasAcceptedInvite: (...a: unknown[]) => hasAcceptedInvite(...(a as [AuthUser])),
}))
vi.mock('@/lib/access-audit', () => ({
  recordAccessEvent: (...a: unknown[]) => recordAccessEvent(...(a as [])),
}))

const { POST } = await import('@/app/api/settings/users/[id]/resend/route')

const req = () =>
  ({ url: 'http://localhost:3000/api/settings/users/user-old/resend' }) as unknown as NextRequest
const params = { params: { id: 'user-old' } }

beforeEach(() => {
  CALLS.length = 0
  vi.clearAllMocks()
  userFindUnique.mockResolvedValue({
    id: 'user-old', email: 'sam@fergies.test', name: 'Sam Lee',
    role: 'STAFF', isActive: false,
  })
  userScopeFindMany.mockResolvedValue([{ locationId: 'loc1', revenueCenterId: null, clearance: null }])
  findAuthUserByEmail.mockResolvedValue(PENDING)
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'user-new' } }, error: null })
  cookFindUnique.mockImplementation(async () => { CALLS.push('cook.findUnique'); return { id: 'cook-1' } })
})

describe('POST /api/settings/users/[id]/resend', () => {
  it('re-points the linked roster row onto the new auth UUID', async () => {
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })

    // The whole point: the Cook follows the re-key instead of being nulled.
    expect(cookUpdate).toHaveBeenCalledWith({
      where: { id: 'cook-1' }, data: { userId: 'user-new' },
    })
  })

  it('reads the roster link BEFORE the delete and re-points it AFTER the new user exists', async () => {
    await POST(req(), params)
    // Reading after `user.deleteMany` would find nothing (SetNull already
    // fired); updating before `user.create` would violate the FK.
    expect(CALLS.indexOf('cook.findUnique')).toBeLessThan(CALLS.indexOf('user.deleteMany'))
    expect(CALLS.indexOf('cook.update')).toBeGreaterThan(CALLS.indexOf('user.create'))
  })

  it('does the delete, the re-create and the re-link inside ONE interactive transaction', async () => {
    // Under the pgBouncer transaction-mode pooler, loose auto-commit
    // statements can interleave such that the delete is not visible to the
    // insert. Everything must ride inside the one $transaction callback.
    await POST(req(), params)
    expect(prismaTransaction).toHaveBeenCalledTimes(1)
    for (const call of ['cook.findUnique', 'user.deleteMany', 'user.create', 'cook.update']) {
      expect(CALLS).toContain(call)
    }
  })

  it('does nothing to the roster when this login has no linked roster row', async () => {
    cookFindUnique.mockImplementation(async () => { CALLS.push('cook.findUnique'); return null })
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    expect(cookUpdate).not.toHaveBeenCalled()
  })

  it('refuses an account that already accepted, without deleting anything', async () => {
    // The reason widening the Identity tab gate to `!isActive` is safe: a
    // deactivated (but accepted) colleague is turned away here, so their
    // roster link is never at risk.
    findAuthUserByEmail.mockResolvedValue({ id: 'user-old', email_confirmed_at: '2026-01-01T00:00:00Z' })
    const res = await POST(req(), params)
    expect(res.status).toBe(400)
    expect(deleteUser).not.toHaveBeenCalled()
    expect(inviteUserByEmail).not.toHaveBeenCalled()
    expect(prismaTransaction).not.toHaveBeenCalled()
  })

  it('propagates a 403 from requireSession without touching either store', async () => {
    requireSession.mockRejectedValueOnce(new MockAuthError(403, 'Forbidden'))
    const res = await POST(req(), params)
    expect(res.status).toBe(403)
    expect(userFindUnique).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })
})
