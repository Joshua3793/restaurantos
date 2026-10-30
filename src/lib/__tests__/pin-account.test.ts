import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ── Prisma ────────────────────────────────────────────────────────────────
const userFindUnique = vi.fn()
const cookFindUnique = vi.fn()
const txUserUpsert = vi.fn()
const txCookUpdate = vi.fn()
const transaction = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    cook: { findUnique: (...a: unknown[]) => cookFindUnique(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))

// ── Supabase admin ────────────────────────────────────────────────────────
const createUser = vi.fn()
const deleteUser = vi.fn()
const generateLink = vi.fn()
const adminClient = { auth: { admin: { createUser, deleteUser, generateLink } } }
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

const { ensurePinUser, mintSession } = await import('@/lib/pin/account')
const { PinError } = await import('@/lib/pin/errors')

const unlinked = { id: 'c1', name: 'Sam', lastName: 'Lee', userId: null }
const EMAIL = 'pin.c1@crew.controlaos.app'

function runTxForReal() {
  transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ user: { upsert: txUserUpsert }, cook: { update: txCookUpdate } }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  ssrOptions = null
  runTxForReal()
  txUserUpsert.mockImplementation(async (args: { create: unknown }) => args.create)
  txCookUpdate.mockResolvedValue({})
  createUser.mockResolvedValue({ data: { user: { id: 'auth-new' } }, error: null })
  deleteUser.mockResolvedValue({ data: {}, error: null })
  createServerClient.mockImplementation((_url: string, _key: string, opts: typeof ssrOptions) => {
    ssrOptions = opts
    return { auth: { verifyOtp } }
  })
})

describe('ensurePinUser — already linked', () => {
  it('returns the linked active user and never creates an account', async () => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'sam@x.com', isActive: true })
    const out = await ensurePinUser({ ...unlinked, userId: 'u9' })
    expect(out).toEqual({ userId: 'u9', email: 'sam@x.com' })
    expect(userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u9' } }))
    expect(createUser).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('throws 403 "This login is switched off" for an inactive linked user', async () => {
    userFindUnique.mockResolvedValue({ id: 'u9', email: 'sam@x.com', isActive: false })
    const err = await ensurePinUser({ ...unlinked, userId: 'u9' }).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 403, message: 'This login is switched off' })
    expect(createUser).not.toHaveBeenCalled()
  })

  it('treats a dangling link (no User row) as unlinked, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    userFindUnique.mockResolvedValue(null)
    const out = await ensurePinUser({ ...unlinked, userId: 'gone' })
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(warn).toHaveBeenCalled()
    expect(createUser).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('ensurePinUser — not linked', () => {
  it('creates the auth user, then the User row and the cook link in one transaction', async () => {
    const out = await ensurePinUser(unlinked)

    expect(createUser).toHaveBeenCalledWith({
      email: EMAIL,
      email_confirm: true,
      user_metadata: { role: 'STAFF', isActive: true, name: 'Sam Lee' },
    })
    expect(transaction).toHaveBeenCalledTimes(1)
    expect(txUserUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'auth-new' },
      create: { id: 'auth-new', email: EMAIL, name: 'Sam Lee', role: 'STAFF', isActive: true },
    }))
    expect(txCookUpdate).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { userId: 'auth-new' } })
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(deleteUser).not.toHaveBeenCalled()
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

  it('throws (no transaction) when createUser fails for another reason', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'unexpected_failure', message: 'nope' } })
    await expect(ensurePinUser(unlinked)).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
    expect(findAuthUserByEmail).not.toHaveBeenCalled()
  })

  it('reuses the existing auth user when the email is already registered', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'already registered' } })
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL })

    const out = await ensurePinUser(unlinked)

    expect(findAuthUserByEmail).toHaveBeenCalledWith(adminClient, EMAIL)
    expect(txUserUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'auth-old' },
      create: { id: 'auth-old', email: EMAIL, name: 'Sam Lee', role: 'STAFF', isActive: true },
    }))
    expect(txCookUpdate).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { userId: 'auth-old' } })
    expect(out).toEqual({ userId: 'auth-old', email: EMAIL })
  })

  it('does not delete a reused auth user when the transaction fails', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'already registered' } })
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL })
    transaction.mockRejectedValue(new Error('pooler hiccup'))
    await expect(ensurePinUser(unlinked)).rejects.toThrow('pooler hiccup')
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('refuses (403, link rolled back) when a reused User row is switched off', async () => {
    createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'already registered' } })
    findAuthUserByEmail.mockResolvedValue({ id: 'auth-old', email: EMAIL })
    txUserUpsert.mockResolvedValue({ id: 'auth-old', email: EMAIL, isActive: false })
    const err = await ensurePinUser(unlinked).catch((e) => e)
    expect(err).toBeInstanceOf(PinError)
    expect(err).toMatchObject({ status: 403, message: 'This login is switched off' })
    expect(txCookUpdate).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('race: a unique violation with the cook now linked returns the winner and keeps its auth user', async () => {
    transaction.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))
    cookFindUnique.mockResolvedValue({ userId: 'auth-new' })
    userFindUnique.mockResolvedValue({ id: 'auth-new', email: EMAIL, isActive: true })

    const out = await ensurePinUser(unlinked)

    expect(cookFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' } }))
    expect(out).toEqual({ userId: 'auth-new', email: EMAIL })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('race: a unique violation with the cook still unlinked rolls back and rethrows', async () => {
    const dup = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    transaction.mockRejectedValue(dup)
    cookFindUnique.mockResolvedValue({ userId: null })
    await expect(ensurePinUser(unlinked)).rejects.toBe(dup)
    expect(deleteUser).toHaveBeenCalledWith('auth-new')
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
