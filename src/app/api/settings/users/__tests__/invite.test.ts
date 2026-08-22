import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
const userDeleteMany = vi.fn(async () => ({ count: 0 }))
const userCreate = vi.fn(async (args: { data: { id: string; email: string } }) => args.data)
const userFindUnique = vi.fn(async () => null as { role?: string; name?: string | null; isActive?: boolean } | null)
const userUpsert = vi.fn(async () => ({ id: 'auth-1' }))
const userUpdate = vi.fn(async () => ({ id: 'auth-1' }))
const userScopeCreateMany = vi.fn(async () => ({ count: 0 }))
const userScopeDeleteMany = vi.fn(async () => ({ count: 0 }))
const userScopeFindMany = vi.fn(async () => [] as unknown[])
const recordAccessEvent = vi.fn(async () => undefined)

// `user` is widened to nullable here (type-only — `as` erases at runtime) so the
// failure cases below can mock `{ data: { user: null } }` without a TS2322.
const inviteUserByEmail = vi.fn(async () => ({ data: { user: { id: 'auth-1' } as { id: string } | null }, error: null as { message: string } | null }))
const updateUserById = vi.fn(async () => ({ error: null as { message: string } | null }))
const deleteUser = vi.fn(async () => ({ error: null }))

const tx = {
  user: {
    deleteMany: (...a: unknown[]) => userDeleteMany(...(a as [])),
    create: (...a: unknown[]) => userCreate(...(a as [{ data: { id: string; email: string } }])),
    upsert: (...a: unknown[]) => userUpsert(...(a as [])),
    update: (...a: unknown[]) => userUpdate(...(a as [])),
  },
  userScope: {
    createMany: (...a: unknown[]) => userScopeCreateMany(...(a as [])),
    deleteMany: (...a: unknown[]) => userScopeDeleteMany(...(a as [])),
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...(a as [])),
    },
    userScope: {
      findMany: (...a: unknown[]) => userScopeFindMany(...(a as [])),
    },
  },
}))
vi.mock('@/lib/access-audit', () => ({
  recordAccessEvent: (...a: unknown[]) => recordAccessEvent(...(a as [])),
}))
vi.mock('@/lib/users', () => ({
  isAlreadyRegisteredError: (e: { message?: string } | null) => !!e && /already registered/i.test(e.message ?? ''),
  findAuthUserByEmail: async () => ({ id: 'auth-1', email_confirmed_at: '2026-01-01T00:00:00Z' }),
  hasAcceptedInvite: (u: { email_confirmed_at?: string | null }) => !!u.email_confirmed_at,
}))

const { inviteOne } = await import('@/lib/user-invite')

const supabaseAdmin = {
  auth: { admin: { inviteUserByEmail, updateUserById, deleteUser } },
} as unknown as Parameters<typeof inviteOne>[0]['supabaseAdmin']

const opts = () => ({
  email: 'sam@fergies.test',
  role: 'STAFF' as const,
  name: 'Sam Lee',
  assignments: [{ locationId: 'loc1', revenueCenterId: null, clearance: null }],
  actor: { id: 'u9', email: 'admin@fergies.test', name: 'Admin' },
  appUrl: 'https://app.test',
  supabaseAdmin,
})

beforeEach(() => {
  vi.clearAllMocks()
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  userFindUnique.mockResolvedValue(null)
  userScopeFindMany.mockResolvedValue([])
  userCreate.mockImplementation(async (args) => args.data)
})

describe('inviteOne', () => {
  it('sends a fresh invite and returns the new auth user id', async () => {
    const res = await inviteOne(opts())
    expect(res.status).toBe('invited')
    expect(res.userId).toBe('auth-1')
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1)
  })

  it('creates the Prisma row inactive — it is activated by /auth/callback on accept', async () => {
    await inviteOne(opts())
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }),
    )
  })

  it('writes the scope rows in the same transaction as the user row', async () => {
    await inviteOne(opts())
    expect(userScopeCreateMany).toHaveBeenCalledTimes(1)
  })

  it('reports a plain invite failure without touching Prisma', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'SMTP down' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('SMTP down')
    expect(userCreate).not.toHaveBeenCalled()
  })

  it('refuses to touch the owner seat', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique.mockResolvedValueOnce({ role: 'OWNER' })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('owner')
    expect(userUpsert).not.toHaveBeenCalled()
  })

  it('reactivates an already-accepted account in place and returns its id', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique
      .mockResolvedValueOnce({ role: 'STAFF' })                                   // owner pre-check
      .mockResolvedValueOnce({ name: 'Sam Lee', role: 'STAFF', isActive: false }) // prior snapshot
    const res = await inviteOne(opts())
    expect(res.status).toBe('reactivated')
    expect(res.userId).toBe('auth-1')
    expect(userUpsert).toHaveBeenCalledTimes(1)
  })

  it('reverts Prisma when the Supabase metadata write fails, so the two stores cannot diverge', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })
    userFindUnique
      .mockResolvedValueOnce({ role: 'STAFF' })
      .mockResolvedValueOnce({ name: 'Sam Lee', role: 'STAFF', isActive: false })
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('supabase 503')
    expect(userUpdate).toHaveBeenCalled() // the compensating revert
  })
})
