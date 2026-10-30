import { describe, it, expect, vi, beforeEach } from 'vitest'
import { hashToken } from '@/lib/pin/rules'

// requireSession and PIN accounts (RULING P9): a PIN-stamped login needs the
// cookie of a phone APPROVED for that cook, and is never more than a LEAD.

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))

let cookieJar: Record<string, string> = {}
vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (name in cookieJar ? { name, value: cookieJar[name] } : undefined),
    getAll: () => Object.entries(cookieJar).map(([name, value]) => ({ name, value })),
  }),
}))

const userFindUnique = vi.fn()
const userFindFirst = vi.fn()
const deviceFindUnique = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      findFirst: (...a: unknown[]) => userFindFirst(...a),
    },
    pinDevice: { findUnique: (...a: unknown[]) => deviceFindUnique(...a) },
  },
}))

const { requireSession, AuthError } = await import('@/lib/auth')

const TOKEN = 'a'.repeat(43)
const HASH = hashToken(TOKEN)
const PHONE_NEEDED = 'Sign in again with your PIN on an OK’d phone'

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'x@y.z', name: 'Sam', role: 'STAFF', isActive: true, ...over,
})
const authAs = (appMeta: Record<string, unknown> = {}) =>
  getUser.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: appMeta } } })

beforeEach(() => {
  vi.clearAllMocks()
  cookieJar = {}
  userFindUnique.mockResolvedValue(row())
  deviceFindUnique.mockResolvedValue(null)
})

describe('requireSession — ordinary (email) logins', () => {
  it('is unaffected and never looks for a PIN phone', async () => {
    authAs({ provider: 'email' })
    userFindUnique.mockResolvedValue(row({ role: 'MANAGER' }))
    const u = await requireSession('MANAGER')
    expect(u.role).toBe('MANAGER')
    expect(deviceFindUnique).not.toHaveBeenCalled()
  })

  it('ignores a stray pin_device cookie', async () => {
    authAs()
    cookieJar.pin_device = TOKEN
    await expect(requireSession()).resolves.toMatchObject({ id: 'u1' })
    expect(deviceFindUnique).not.toHaveBeenCalled()
  })

  it('no session → 401', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    await expect(requireSession()).rejects.toMatchObject({ status: 401 })
  })
})

describe('requireSession — PIN accounts', () => {
  it('no device cookie → 401, no lookup', async () => {
    authAs({ pinCookId: 'c1' })
    const err = await requireSession().catch((e) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect(err).toMatchObject({ status: 401, message: PHONE_NEEDED })
    expect(deviceFindUnique).not.toHaveBeenCalled()
  })

  it('a malformed cookie → 401, no lookup', async () => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = 'evil'
    await expect(requireSession()).rejects.toMatchObject({ status: 401, message: PHONE_NEEDED })
    expect(deviceFindUnique).not.toHaveBeenCalled()
  })

  it('looks the phone up by (token hash, this cook) in one indexed findUnique', async () => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = TOKEN
    deviceFindUnique.mockResolvedValue({ status: 'APPROVED' })
    await requireSession()
    expect(deviceFindUnique).toHaveBeenCalledTimes(1)
    expect(deviceFindUnique).toHaveBeenCalledWith({
      where: { tokenHash_cookId: { tokenHash: HASH, cookId: 'c1' } },
      select: { status: true },
    })
  })

  it('a cookie approved only for another cook → 401', async () => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = TOKEN
    deviceFindUnique.mockImplementation(async (a: { where: { tokenHash_cookId: { cookId: string } } }) =>
      a.where.tokenHash_cookId.cookId === 'c2' ? { status: 'APPROVED' } : null,
    )
    await expect(requireSession()).rejects.toMatchObject({ status: 401, message: PHONE_NEEDED })
  })

  it.each(['REVOKED', 'PENDING', 'REJECTED'])('a %s phone → 401 (Remove phone takes effect at once)', async (status) => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = TOKEN
    deviceFindUnique.mockResolvedValue({ status })
    await expect(requireSession()).rejects.toMatchObject({ status: 401, message: PHONE_NEEDED })
  })

  it('an APPROVED phone → the user, unchanged', async () => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = TOKEN
    deviceFindUnique.mockResolvedValue({ status: 'APPROVED' })
    userFindUnique.mockResolvedValue(row({ role: 'LEAD' }))
    await expect(requireSession('LEAD')).resolves.toEqual(row({ role: 'LEAD' }))
  })

  it.each(['MANAGER', 'ADMIN', 'OWNER'])('a PIN login promoted to %s is returned as LEAD, nothing written', async (role) => {
    authAs({ pinCookId: 'c1' })
    cookieJar.pin_device = TOKEN
    deviceFindUnique.mockResolvedValue({ status: 'APPROVED' })
    userFindUnique.mockResolvedValue(row({ role }))
    const u = await requireSession()
    expect(u).toEqual(row({ role: 'LEAD' }))
    await expect(requireSession('LEAD')).resolves.toMatchObject({ role: 'LEAD' })
    await expect(requireSession('MANAGER')).rejects.toMatchObject({ status: 403 })
  })

  it('a non-string stamp fails closed (401)', async () => {
    authAs({ pinCookId: 42 })
    cookieJar.pin_device = TOKEN
    await expect(requireSession()).rejects.toMatchObject({ status: 401 })
    expect(deviceFindUnique).not.toHaveBeenCalled()
  })

  it('an inactive PIN login is still 403 (checked before the phone)', async () => {
    authAs({ pinCookId: 'c1' })
    userFindUnique.mockResolvedValue(row({ isActive: false }))
    await expect(requireSession()).rejects.toMatchObject({ status: 403 })
  })
})
