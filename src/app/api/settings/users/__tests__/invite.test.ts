import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

// The auth-side lookups are real vi.fn mocks, not fixed stubs: `hasAcceptedInvite`
// selects between the re-invite and the reactivate branch, so a hard-coded `true`
// would leave the whole `!hasAcceptedInvite` path (delete + REINVITE) untested.
type AuthUser = { id: string; email_confirmed_at: string | null }
const ACCEPTED: AuthUser = { id: 'auth-1', email_confirmed_at: '2026-01-01T00:00:00Z' }
const findAuthUserByEmail = vi.fn(async (): Promise<AuthUser | null> => ACCEPTED)
const hasAcceptedInvite = vi.fn((_u: AuthUser) => true)

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

// A vi.fn so a test can make ONE specific transaction throw — the reactivate
// write and the compensating revert are both `prisma.$transaction` calls.
const runTransaction = async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)
const prismaTransaction = vi.fn(runTransaction)

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (...a: unknown[]) => prismaTransaction(...(a as [(t: typeof tx) => Promise<unknown>])),
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
  findAuthUserByEmail: (...a: unknown[]) => findAuthUserByEmail(...(a as [])),
  hasAcceptedInvite: (...a: unknown[]) => hasAcceptedInvite(...(a as [AuthUser])),
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

/** First call errors "already registered", pushing inviteOne down the existing-account path. */
const alreadyRegistered = () =>
  inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered' } })

/** The owner pre-check, then the prior-state snapshot read. */
const priorPrismaUser = (prior: { name: string | null; role: string; isActive: boolean } | null) =>
  userFindUnique.mockResolvedValueOnce({ role: 'STAFF' }).mockResolvedValueOnce(prior)

beforeEach(() => {
  vi.clearAllMocks()
  inviteUserByEmail.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  userFindUnique.mockResolvedValue(null)
  userScopeFindMany.mockResolvedValue([])
  userCreate.mockImplementation(async (args) => args.data)
  recordAccessEvent.mockImplementation(async () => undefined)
  prismaTransaction.mockImplementation(runTransaction)
  findAuthUserByEmail.mockResolvedValue(ACCEPTED)
  hasAcceptedInvite.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
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

  it('clears any stale Prisma row in the same transaction — a re-invite mints a new auth UUID, so the old row would collide on email', async () => {
    await inviteOne(opts())
    expect(userDeleteMany).toHaveBeenCalledWith({ where: { email: 'sam@fergies.test' } })
    // Same tx object => same interactive transaction as the create below it.
    expect(userDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(userCreate.mock.invocationCallOrder[0])
  })

  it('records the INVITED audit event inside the invite transaction, not after it', async () => {
    await inviteOne(opts())
    expect(recordAccessEvent).toHaveBeenCalledTimes(1)
    expect(recordAccessEvent).toHaveBeenCalledWith(
      tx, // the transaction client, not the bare prisma singleton
      expect.objectContaining({ action: 'INVITED', target: expect.objectContaining({ id: 'auth-1' }) }),
    )
  })

  it('reports a plain invite failure without touching Prisma', async () => {
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'SMTP down' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('SMTP down')
    expect(userCreate).not.toHaveBeenCalled()
  })

  it('refuses to touch the owner seat', async () => {
    alreadyRegistered()
    userFindUnique.mockResolvedValueOnce({ role: 'OWNER' })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('owner')
    expect(userUpsert).not.toHaveBeenCalled()
  })

  it('fails when the email is registered but no auth user can be resolved', async () => {
    alreadyRegistered()
    findAuthUserByEmail.mockResolvedValueOnce(null)
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('Email already has an unresolvable account.')
    expect(deleteUser).not.toHaveBeenCalled()
    expect(userUpsert).not.toHaveBeenCalled()
    expect(userCreate).not.toHaveBeenCalled()
  })

  it('deletes the never-accepted auth user and re-invites, returning the NEW auth id', async () => {
    alreadyRegistered()
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: { id: 'auth-2' } }, error: null })
    userFindUnique.mockResolvedValueOnce({ role: 'STAFF' }) // owner pre-check
    hasAcceptedInvite.mockReturnValueOnce(false)
    const res = await inviteOne(opts())
    expect(deleteUser).toHaveBeenCalledWith('auth-1')
    expect(res.status).toBe('reinvited')
    expect(res.userId).toBe('auth-2')
    expect(userCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: 'auth-2' }) }))
    expect(recordAccessEvent).toHaveBeenCalledWith(tx, expect.objectContaining({ action: 'REINVITED' }))
    expect(userUpsert).not.toHaveBeenCalled()
  })

  it('reports failure when the re-invite itself fails', async () => {
    alreadyRegistered()
    inviteUserByEmail.mockResolvedValueOnce({ data: { user: null }, error: { message: 'SMTP down' } })
    userFindUnique.mockResolvedValueOnce({ role: 'STAFF' })
    hasAcceptedInvite.mockReturnValueOnce(false)
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('SMTP down')
  })

  it('reactivates an already-accepted account in place and returns its id', async () => {
    alreadyRegistered()
    priorPrismaUser({ name: 'Sam Lee', role: 'STAFF', isActive: false })
    const res = await inviteOne(opts())
    expect(res.status).toBe('reactivated')
    expect(res.userId).toBe('auth-1')
    expect(res.warning).toBeUndefined()
    expect(userUpsert).toHaveBeenCalledTimes(1)
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('reverts Prisma to its PRIOR values when the Supabase metadata write returns an error', async () => {
    alreadyRegistered()
    // Prior state deliberately differs from the invite in all three fields, so a
    // revert that wrote the NEW values back would fail this assertion.
    priorPrismaUser({ name: 'Sam Old', role: 'MANAGER', isActive: false })
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toContain('supabase 503')
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'auth-1' },
      data: { name: 'Sam Old', role: 'MANAGER', isActive: false },
    })
  })

  it('runs the identical revert when the Supabase metadata write THROWS instead of returning an error', async () => {
    alreadyRegistered()
    priorPrismaUser({ name: 'Sam Old', role: 'MANAGER', isActive: false })
    updateUserById.mockRejectedValueOnce(new Error('boom'))
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(res.error).toBe('boom')
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'auth-1' },
      data: { name: 'Sam Old', role: 'MANAGER', isActive: false },
    })
  })

  it('restores the prior scope rows on revert', async () => {
    alreadyRegistered()
    priorPrismaUser({ name: 'Sam Old', role: 'MANAGER', isActive: false })
    userScopeFindMany.mockResolvedValueOnce([
      { locationId: 'loc-old', revenueCenterId: null, clearance: 'MANAGER' },
    ])
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    // First createMany wrote the new assignments; the last one is the restore.
    expect(userScopeCreateMany).toHaveBeenCalledTimes(2)
    expect(userScopeCreateMany).toHaveBeenLastCalledWith({
      data: [{ locationId: 'loc-old', revenueCenterId: null, clearance: 'MANAGER', userId: 'auth-1' }],
    })
  })

  it('deletes the row it just created when there was no prior Prisma user to restore', async () => {
    alreadyRegistered()
    priorPrismaUser(null) // auth user exists, Prisma row does not
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    const res = await inviteOne(opts())
    expect(res.status).toBe('failed')
    expect(userUpdate).not.toHaveBeenCalled()
    expect(userDeleteMany).toHaveBeenCalledWith({ where: { id: 'auth-1' } })
  })

  it('reports `inconsistent` — not `failed` — when the compensating revert transaction itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    alreadyRegistered()
    priorPrismaUser({ name: 'Sam Old', role: 'MANAGER', isActive: false })
    updateUserById.mockResolvedValueOnce({ error: { message: 'supabase 503' } })
    prismaTransaction
      .mockImplementationOnce(runTransaction) // the reactivate write commits
      .mockImplementationOnce(async () => { throw new Error('pooler dropped the connection') })
    const res = await inviteOne(opts())
    expect(res.status).toBe('inconsistent')
    expect(res.error).toContain('inconsistent state')
    expect(consoleError).toHaveBeenCalled()
  })

  it('keeps the reactivation a success, with a warning, when only the audit write fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    alreadyRegistered()
    priorPrismaUser({ name: 'Sam Lee', role: 'STAFF', isActive: false })
    recordAccessEvent.mockRejectedValueOnce(new Error('audit table locked'))
    const res = await inviteOne(opts())
    expect(res.status).toBe('reactivated')
    expect(res.userId).toBe('auth-1')
    expect(res.warning).toBe('Reactivated, but the audit log entry failed to write.')
    expect(res.error).toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
  })
})
