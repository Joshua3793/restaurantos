import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ── Prisma ────────────────────────────────────────────────────────────────
const userFindUnique = vi.fn()
const cookFindUnique = vi.fn()
const cookUpdateMany = vi.fn()
const txUserUpsert = vi.fn()
const txCookUpdateMany = vi.fn()
const transaction = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    cook: {
      findUnique: (...a: unknown[]) => cookFindUnique(...a),
      updateMany: (...a: unknown[]) => cookUpdateMany(...a),
    },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))

// ── Supabase admin ────────────────────────────────────────────────────────
const createUser = vi.fn()
const deleteUser = vi.fn()
const updateUserById = vi.fn()
const generateLink = vi.fn()
const adminClient = { auth: { admin: { createUser, deleteUser, updateUserById, generateLink } } }
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminClient }))

// ── @/lib/users ───────────────────────────────────────────────────────────
const findAuthUserByEmail = vi.fn()
vi.mock('@/lib/users', () => ({
  findAuthUserByEmail: (...a: unknown[]) => findAuthUserByEmail(...a),
  isAlreadyRegisteredError: (e: { code?: string } | null) => e?.code === 'email_exists',
}))

// ── @supabase/ssr ─────────────────────────────────────────────────────────
type SetAll = (c: { name: string; value: string; options: object }[]) => void
let ssrOptions: { cookies: { getAll: () => unknown; setAll: SetAll } } | null = null
const createServerClient = vi.fn()
const verifyOtp = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: (...a: unknown[]) => createServerClient(...a),
}))

const { ensurePinUser, mintSession, assertPinLoginAllowed } = await import('@/lib/pin/account')
const { PinError } = await import('@/lib/pin/errors')

const unlinked = { id: 'c1', name: 'Sam', lastName: 'Lee', userId: null }
const EMAIL = 'pin.c1@crew.controlaos.vercel.app'
const SELECT = { id: true, email: true, name: true, role: true, isActive: true }
const ALREADY = { data: { user: null }, error: { code: 'email_exists', message: 'already registered' } }
const staffRow = (id: string, over: object = {}) =>
  ({ id, email: EMAIL, name: 'Sam Lee', role: 'STAFF', isActive: true, ...over })

/** The full upsert argument — pinned so reactivation can never slip in. */
const upsertArg = (id: string) => ({
  where: { id },
  create: { id, email: EMAIL, name: 'Sam Lee', role: 'STAFF', isActive: true },
  update: {},
  select: SELECT,
})

beforeEach(() => {
  vi.clearAllMocks()
  ssrOptions = null
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ user: { upsert: txUserUpsert }, cook: { updateMany: txCookUpdateMany } }),
  )
  txUserUpsert.mockImplementation(async (args: { create: object }) => ({ ...args.create }))
  txCookUpdateMany.mockResolvedValue({ count: 1 })
  cookUpdateMany.mockResolvedValue({ count: 1 })
  userFindUnique.mockResolvedValue(null)
  createUser.mockResolvedValue({ data: { user: { id: 'auth-new' } }, error: null })
  deleteUser.mockResolvedValue({ data: {}, error: null })
  updateUserById.mockResolvedValue({ data: {}, error: null })
  createServerClient.mockImplementation((_url: string, _key: string, opts: typeof ssrOptions) => {
    ssrOptions = opts
    return { auth: { verifyOtp } }
  })
})

describe('ensurePinUser — already linked', () => {
  it('returns the linked active user and never creates an account', async () => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'sam@x.com', name: 'Sam', role: 'STAFF', isActive: true })
    const out = await ensurePinUser({ ...unlinked, userId: 'u9' })
    expect(out).toEqual({ userId: 'u9', email: 'sam@x.com' })
    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: 'u9' }, select: SELECT })
    expect(createUser).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('lets a LEAD in', async () => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'sam@x.com', name: 'Sam', role: 'LEAD', isActive: true })
    await expect(ensurePinUser({ ...unlinked, userId: 'u9' })).resolves.toEqual({ userId: 'u9', email: 'sam@x.com' })
  })

  it('throws 403 "This login is switched off" for an inactive linked user', async () => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'sam@x.com', name: 'Sam', role: 'STAFF', isActive: false })
    const err = await ensurePinUser({ ...unlinked, userId: 'u9' }).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 403, message: 'This login is switched off' })
    expect(createUser).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('refuses a linked %s (403, managers use email)', async (role) => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'boss@x.com', name: 'Boss', role, isActive: true })
    const err = await ensurePinUser({ ...unlinked, userId: 'u9' }).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 403, message: 'Managers sign in with email and password' })
    expect(createUser).not.toHaveBeenCalled()
  })

  it('treats a dangling link (no User row) as unlinked, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await ensurePinUser({ ...unlinked, userId: 'gone' })
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(warn).toHaveBeenCalled()
    expect(createUser).toHaveBeenCalledTimes(1)
    // compare-and-set on the link that was read
    expect(txCookUpdateMany).toHaveBeenCalledWith({ where: { id: 'c1', userId: 'gone' }, data: { userId: 'auth-new' } })
    warn.mockRestore()
  })
})

describe('ensurePinUser — not linked', () => {
  it('creates the stamped auth user, then the User row and the cook link in one transaction', async () => {
    const out = await ensurePinUser(unlinked)

    expect(createUser).toHaveBeenCalledWith({
      email: EMAIL,
      email_confirm: true,
      user_metadata: { role: 'STAFF', isActive: true, name: 'Sam Lee' },
      app_metadata: { pinCookId: 'c1' },
    })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txUserUpsert).toHaveBeenCalledWith(upsertArg('auth-new'))
    expect(txCookUpdateMany).toHaveBeenCalledWith({ where: { id: 'c1', userId: null }, data: { userId: 'auth-new' } })
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('uses the first name alone when there is no last name', async () => {
    await ensurePinUser({ ...unlinked, lastName: null })
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({
      user_metadata: { role: 'STAFF', isActive: true, name: 'Sam' },
    }))
  })

  it('rolls back the auth user and rethrows when the transaction fails', async () => {
    const boom = new Error('pooler hiccup')
    transaction.mockRejectedValue(boom)
    await expect(ensurePinUser(unlinked)).rejects.toBe(boom)
    expect(deleteUser).toHaveBeenCalledWith('auth-new')
  })

  it('still rethrows the original error when the rollback delete itself fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = new Error('pooler hiccup')
    transaction.mockRejectedValue(boom)
    deleteUser.mockRejectedValue(new Error('supabase down'))
    await expect(ensurePinUser(unlinked)).rejects.toBe(boom)
    deleteUser.mockResolvedValue({ data: {}, error: { message: 'still down' } })
    await expect(ensurePinUser(unlinked)).rejects.toBe(boom)
    expect(deleteUser).toHaveBeenCalledTimes(2)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('throws (no transaction) when createUser fails for another reason', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'unexpected_failure', message: 'nope' } })
    await expect(ensurePinUser(unlinked)).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
    expect(findAuthUserByEmail).not.toHaveBeenCalled()
  })

  it('throws (no transaction, no delete) when the registered email cannot be found', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue(null)
    await expect(ensurePinUser(unlinked)).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })
})

describe('ensurePinUser — email already registered', () => {
  it('(a) adopts an auth user stamped for this cook and re-syncs its metadata to the User row', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL, app_metadata: { pinCookId: 'c1' } })
    txUserUpsert.mockResolvedValue(staffRow('auth-old', { role: 'LEAD', name: 'Samuel Lee' }))

    const out = await ensurePinUser(unlinked)

    expect(findAuthUserByEmail).toHaveBeenCalledWith(adminClient, EMAIL)
    expect(txUserUpsert).toHaveBeenCalledWith(upsertArg('auth-old'))
    expect(txCookUpdateMany).toHaveBeenCalledWith({ where: { id: 'c1', userId: null }, data: { userId: 'auth-old' } })
    expect(updateUserById).toHaveBeenCalledWith('auth-old', {
      user_metadata: { role: 'LEAD', isActive: true, name: 'Samuel Lee' },
    })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(out).toEqual({ userId: 'auth-old', email: EMAIL })
  })

  it('(a) unlinks again and throws when the metadata sync fails', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL, app_metadata: { pinCookId: 'c1' } })
    updateUserById.mockResolvedValue({ data: null, error: { message: 'nope' } })
    await expect(ensurePinUser(unlinked)).rejects.toThrow()
    expect(cookUpdateMany).toHaveBeenCalledWith({ where: { id: 'c1', userId: 'auth-old' }, data: { userId: null } })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('(a) refuses (403) when the adopted User row is a manager, without linking', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL, app_metadata: { pinCookId: 'c1' } })
    txUserUpsert.mockResolvedValue(staffRow('auth-old', { role: 'MANAGER' }))
    const err = await ensurePinUser(unlinked).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 403, message: 'Managers sign in with email and password' })
    expect(txCookUpdateMany).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('(a) refuses (403) when the adopted User row is switched off, without linking', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL, app_metadata: { pinCookId: 'c1' } })
    txUserUpsert.mockResolvedValue(staffRow('auth-old', { isActive: false }))
    const err = await ensurePinUser(unlinked).catch((e) => e)
    expect(err).toMatchObject({ status: 403, message: 'This login is switched off' })
    expect(txCookUpdateMany).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('(a) keeps an adopted auth user when the transaction fails', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL, app_metadata: { pinCookId: 'c1' } })
    transaction.mockRejectedValue(new Error('pooler hiccup'))
    await expect(ensurePinUser(unlinked)).rejects.toThrow('pooler hiccup')
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('(b) deletes an unstamped, unconfirmed, app-unknown user (planted signup) and creates fresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createUser
      .mockResolvedValueOnce(ALREADY)
      .mockResolvedValueOnce({ data: { user: { id: 'auth-fresh' } }, error: null })
    findAuthUserByEmail.mockResolvedValue({
      id: 'planted', email: EMAIL, app_metadata: { provider: 'email' }, email_confirmed_at: null,
      user_metadata: { role: 'OWNER', isActive: true },
    })
    userFindUnique.mockResolvedValue(null)

    const out = await ensurePinUser(unlinked)

    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: 'planted' }, select: { id: true } })
    expect(deleteUser).toHaveBeenCalledWith('planted')
    expect(createUser).toHaveBeenCalledTimes(2)
    expect(createUser).toHaveBeenLastCalledWith(expect.objectContaining({ app_metadata: { pinCookId: 'c1' } }))
    expect(txUserUpsert).toHaveBeenCalledWith(upsertArg('auth-fresh'))
    expect(updateUserById).not.toHaveBeenCalled()
    expect(out).toEqual({ userId: 'auth-fresh', email: EMAIL })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(EMAIL)
    warn.mockRestore()
  })

  it('(c) throws 409 for a confirmed auth user it did not stamp, touching nothing', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({
      id: 'someone', email: EMAIL, app_metadata: {}, email_confirmed_at: '2026-10-01T00:00:00Z',
    })
    const err = await ensurePinUser(unlinked).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 409, message: 'This PIN account needs a manager to fix it' })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('(c) throws 409 for an unconfirmed unstamped auth user that already has a User row', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({ id: 'someone', email: EMAIL, app_metadata: {}, email_confirmed_at: null })
    userFindUnique.mockResolvedValue({ id: 'someone' })
    await expect(ensurePinUser(unlinked)).rejects.toMatchObject({ status: 409 })
    expect(deleteUser).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('(c) throws 409 for an auth user stamped for a different cook', async () => {
    createUser.mockResolvedValue(ALREADY)
    findAuthUserByEmail.mockResolvedValue({
      id: 'other', email: EMAIL, app_metadata: { pinCookId: 'c2' }, email_confirmed_at: '2026-10-01T00:00:00Z',
    })
    await expect(ensurePinUser(unlinked)).rejects.toMatchObject({ status: 409 })
  })
})

describe('ensurePinUser — two first sign-ins at once', () => {
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

  it('a unique violation with the cook now linked returns the winner and keeps its auth user', async () => {
    transaction.mockRejectedValue(p2002())
    cookFindUnique.mockResolvedValue({ userId: 'auth-new' })
    userFindUnique.mockResolvedValue(staffRow('auth-new'))

    const out = await ensurePinUser(unlinked)

    expect(cookFindUnique).toHaveBeenCalledWith({ where: { id: 'c1' }, select: { userId: true } })
    expect(userFindUnique).toHaveBeenCalledWith({ where: { id: 'auth-new' }, select: SELECT })
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('a lost compare-and-set (count 0) returns a different winner and deletes only our own auth user', async () => {
    txCookUpdateMany.mockResolvedValue({ count: 0 })
    cookFindUnique.mockResolvedValue({ userId: 'winner' })
    userFindUnique.mockResolvedValue({ id: 'winner', email: 'w@x.com', name: 'W', role: 'STAFF', isActive: true })

    const out = await ensurePinUser(unlinked)

    expect(out).toEqual({ userId: 'winner', email: 'w@x.com' })
    expect(deleteUser).toHaveBeenCalledWith('auth-new')
    expect(deleteUser).not.toHaveBeenCalledWith('winner')
  })

  it('refuses a race winner who is a manager', async () => {
    txCookUpdateMany.mockResolvedValue({ count: 0 })
    cookFindUnique.mockResolvedValue({ userId: 'winner' })
    userFindUnique.mockResolvedValue({ id: 'winner', email: 'w@x.com', name: 'W', role: 'ADMIN', isActive: true })
    await expect(ensurePinUser(unlinked)).rejects.toMatchObject({
      status: 403, message: 'Managers sign in with email and password',
    })
  })

  it('refuses a race winner who is switched off', async () => {
    transaction.mockRejectedValue(p2002())
    cookFindUnique.mockResolvedValue({ userId: 'winner' })
    userFindUnique.mockResolvedValue({ id: 'winner', email: 'w@x.com', name: 'W', role: 'STAFF', isActive: false })
    await expect(ensurePinUser(unlinked)).rejects.toMatchObject({ status: 403, message: 'This login is switched off' })
  })

  it('a unique violation with the cook still unlinked rolls back and rethrows', async () => {
    const dup = p2002()
    transaction.mockRejectedValue(dup)
    cookFindUnique.mockResolvedValue({ userId: null })
    await expect(ensurePinUser(unlinked)).rejects.toBe(dup)
    expect(deleteUser).toHaveBeenCalledWith('auth-new')
  })
})

describe('assertPinLoginAllowed', () => {
  it('passes a cook with no login yet without reading the user table', async () => {
    await expect(assertPinLoginAllowed({ userId: null })).resolves.toBeUndefined()
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it('passes a dangling link (ensurePinUser makes a fresh login later)', async () => {
    userFindUnique.mockResolvedValue(null)
    await expect(assertPinLoginAllowed({ userId: 'gone' })).resolves.toBeUndefined()
  })

  it('passes an active STAFF or LEAD login', async () => {
    userFindUnique.mockResolvedValue(staffRow('u9', { role: 'LEAD' }))
    await expect(assertPinLoginAllowed({ userId: 'u9' })).resolves.toBeUndefined()
    expect(createUser).not.toHaveBeenCalled()
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('refuses a linked %s with 403', async (role) => {
    userFindUnique.mockResolvedValue(staffRow('u9', { role }))
    await expect(assertPinLoginAllowed({ userId: 'u9' })).rejects.toMatchObject({
      status: 403,
      message: 'Managers sign in with email and password',
    })
  })

  it('refuses a switched-off login with 403', async () => {
    userFindUnique.mockResolvedValue(staffRow('u9', { isActive: false }))
    await expect(assertPinLoginAllowed({ userId: 'u9' })).rejects.toMatchObject({
      status: 403,
      message: 'This login is switched off',
    })
  })
})

describe('mintSession', () => {
  const req = { cookies: { getAll: () => [{ name: 'old', value: '1' }] } } as unknown as NextRequest
  const minted = [
    { name: 'sb-access', value: 'a', options: { path: '/' } },
    { name: 'sb-refresh', value: 'r', options: { path: '/' } },
  ]

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key'
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'hashed-xyz' } }, error: null })
    verifyOtp.mockImplementation(async () => {
      ssrOptions!.cookies.setAll(minted)
      return { data: {}, error: null }
    })
  })

  it('generates a magic link, verifies it server-side and returns the buffered cookies', async () => {
    const out = await mintSession(req, 'sam@x.com')

    expect(generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'sam@x.com' })
    expect(createServerClient).toHaveBeenCalledWith(
      'https://proj.supabase.co', 'anon-key', expect.anything(),
    )
    expect(ssrOptions!.cookies.getAll()).toEqual([{ name: 'old', value: '1' }])
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: 'hashed-xyz' })
    expect(out).toEqual(minted)
  })

  it('throws 401 when generateLink errors, without verifying', async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const err = await mintSession(req, 'sam@x.com').catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 401, message: 'Could not sign in — try again' })
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('throws 401 when the link has no hashed token', async () => {
    generateLink.mockResolvedValue({ data: { properties: {} }, error: null })
    await expect(mintSession(req, 'sam@x.com')).rejects.toMatchObject({ status: 401 })
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('throws 401 when verifyOtp errors', async () => {
    verifyOtp.mockResolvedValue({ data: {}, error: { message: 'expired' } })
    await expect(mintSession(req, 'sam@x.com')).rejects.toMatchObject({
      status: 401, message: 'Could not sign in — try again',
    })
  })

  it('throws 401 when a Supabase call throws', async () => {
    verifyOtp.mockRejectedValue(new Error('network'))
    await expect(mintSession(req, 'sam@x.com')).rejects.toMatchObject({ status: 401 })
  })

  it('never logs the hashed token', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    )
    verifyOtp.mockResolvedValue({ data: {}, error: { message: 'expired' } })
    await mintSession(req, 'sam@x.com').catch(() => {})
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain('hashed-xyz')
      s.mockRestore()
    }
  })
})
