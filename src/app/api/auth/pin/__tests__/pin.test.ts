import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hashToken, LOCK_WINDOW_MS, pairCode } from '@/lib/pin/rules'
import { PinError } from '@/lib/pin/errors'

// ── Prisma ────────────────────────────────────────────────────────────────
const cookFindFirst = vi.fn()
const deviceFindUnique = vi.fn()
const deviceUpsert = vi.fn()
const deviceUpdate = vi.fn()
const deviceFindMany = vi.fn()
const deviceUpdateMany = vi.fn()
const deviceDeleteMany = vi.fn()
const attemptFindMany = vi.fn()
const attemptCreateMany = vi.fn()
const attemptDeleteMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: { findFirst: (...a: unknown[]) => cookFindFirst(...a) },
    pinDevice: {
      findUnique: (...a: unknown[]) => deviceFindUnique(...a),
      upsert: (...a: unknown[]) => deviceUpsert(...a),
      update: (...a: unknown[]) => deviceUpdate(...a),
      findMany: (...a: unknown[]) => deviceFindMany(...a),
      updateMany: (...a: unknown[]) => deviceUpdateMany(...a),
      deleteMany: (...a: unknown[]) => deviceDeleteMany(...a),
    },
    pinAttempt: {
      findMany: (...a: unknown[]) => attemptFindMany(...a),
      createMany: (...a: unknown[]) => attemptCreateMany(...a),
      deleteMany: (...a: unknown[]) => attemptDeleteMany(...a),
    },
  },
}))

// ── Account (Task 2) ──────────────────────────────────────────────────────
const ensurePinUser = vi.fn()
const mintSession = vi.fn()
const assertPinLoginAllowed = vi.fn()
vi.mock('@/lib/pin/account', () => ({
  ensurePinUser: (...a: unknown[]) => ensurePinUser(...a),
  mintSession: (...a: unknown[]) => mintSession(...a),
  assertPinLoginAllowed: (...a: unknown[]) => assertPinLoginAllowed(...a),
}))

const pinRoute = await import('@/app/api/auth/pin/route')
const statusRoute = await import('@/app/api/auth/pin/status/route')
const { checkLock, recordAttempt, clientIp, confirmKey, limitFor } = await import('@/lib/pin/attempts')

// ── Fixtures ──────────────────────────────────────────────────────────────
const TOKEN = 'a'.repeat(43)
const HASH = hashToken(TOKEN)
const sam = { id: 'c1', name: 'Sam', lastName: 'Lee', userId: 'u1', isActive: true }
const sessionCookies = [
  { name: 'sb-x-auth-token', value: 'session-value', options: { path: '/', sameSite: 'lax' as const, httpOnly: true } },
]

function post(url: string, body: unknown, opts: { cookie?: string; ip?: string; raw?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `${opts.ip ?? '1.2.3.4'}, 10.0.0.1`,
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
  }
  if (opts.cookie) headers.cookie = opts.cookie
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  })
}
const signIn = (body: unknown, opts?: Parameters<typeof post>[2]) =>
  pinRoute.POST(post('/api/auth/pin', body, opts))

const recent = (n: number, key: string) =>
  Array.from({ length: n }, (_, i) => ({ key, createdAt: new Date(Date.now() - (i + 1) * 10_000) }))

/** Every attempt row written, flattened across createMany calls. */
const written = () =>
  attemptCreateMany.mock.calls.flatMap((c) => (c[0] as { data: { key: string; ok: boolean }[] }).data)

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.99) // no opportunistic prune
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  attemptFindMany.mockResolvedValue([])
  attemptCreateMany.mockResolvedValue({ count: 1 })
  attemptDeleteMany.mockResolvedValue({ count: 0 })
  cookFindFirst.mockResolvedValue(null)
  deviceFindUnique.mockResolvedValue(null)
  deviceUpsert.mockImplementation(async (a: { create: object }) => ({ id: 'd1', ...a.create }))
  deviceUpdate.mockResolvedValue({})
  deviceFindMany.mockResolvedValue([])
  deviceUpdateMany.mockResolvedValue({ count: 0 })
  deviceDeleteMany.mockResolvedValue({ count: 0 })
  assertPinLoginAllowed.mockResolvedValue(undefined)
  ensurePinUser.mockResolvedValue({ userId: 'u1', email: 'pin.c1@crew.controlaos.vercel.app' })
  mintSession.mockResolvedValue(sessionCookies)
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ── attempts lib ──────────────────────────────────────────────────────────
describe('clientIp', () => {
  const req = (h: Record<string, string>) => new NextRequest('http://localhost/x', { headers: h })
  it('takes the first x-forwarded-for entry, trimmed', () => {
    expect(clientIp(req({ 'x-forwarded-for': '  9.9.9.9 , 10.0.0.1' }))).toBe('9.9.9.9')
  })
  it('prefers the first x-vercel-forwarded-for entry', () => {
    expect(clientIp(req({ 'x-vercel-forwarded-for': '7.7.7.7, 6.6.6.6', 'x-forwarded-for': '9.9.9.9' }))).toBe('7.7.7.7')
  })
  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(req({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8')
    expect(clientIp(req({}))).toBe('unknown')
  })
})

describe('checkLock', () => {
  it('asks only for failed rows inside the window, for the given keys', async () => {
    const before = Date.now()
    await checkLock(['ip:1.2.3.4', 'cook:c1'])
    const where = attemptFindMany.mock.calls[0][0].where
    expect(where.key).toEqual({ in: ['ip:1.2.3.4', 'cook:c1'] })
    expect(where.ok).toBe(false)
    const since = (where.createdAt.gt as Date).getTime()
    expect(since).toBeGreaterThanOrEqual(before - LOCK_WINDOW_MS - 5)
    expect(since).toBeLessThanOrEqual(Date.now() - LOCK_WINDOW_MS + 5)
  })

  it('locks once any one key has 5 failures in the window', async () => {
    attemptFindMany.mockResolvedValue(recent(5, 'cook:c1'))
    await expect(checkLock(['ip:1.2.3.4', 'cook:c1'])).rejects.toMatchObject({
      status: 429,
      message: 'Too many tries — wait 15 minutes',
    })
  })

  it('does not lock on 4 failures, or on failures spread across keys', async () => {
    attemptFindMany.mockResolvedValue([...recent(4, 'ip:1.2.3.4'), ...recent(4, 'cook:c1')])
    await expect(checkLock(['ip:1.2.3.4', 'cook:c1'])).resolves.toBeUndefined()
  })

  it('an IP key takes 20 failures to lock (shared kitchen Wi-Fi), a cook key 5', async () => {
    attemptFindMany.mockResolvedValue([...recent(19, 'ip:1.2.3.4'), ...recent(4, 'cook:c1')])
    await expect(checkLock(['ip:1.2.3.4', 'cook:c1'])).resolves.toBeUndefined()
    attemptFindMany.mockResolvedValue(recent(20, 'ip:1.2.3.4'))
    await expect(checkLock(['ip:1.2.3.4', 'cook:c1'])).rejects.toMatchObject({ status: 429 })
  })

  it('limitFor gives each key kind its own limit', () => {
    expect(limitFor('ip:1.2.3.4')).toBe(20)
    expect(limitFor('cook:c1')).toBe(5)
    expect(limitFor(confirmKey('1.2.3.4'))).toBe(60)
  })

  it('ignores rows older than the window even if returned', async () => {
    const old = Array.from({ length: 5 }, () => ({ key: 'ip:1.2.3.4', createdAt: new Date(Date.now() - LOCK_WINDOW_MS - 60_000) }))
    attemptFindMany.mockResolvedValue(old)
    await expect(checkLock(['ip:1.2.3.4'])).resolves.toBeUndefined()
  })
})

describe('checkLock — confirm keys', () => {
  it('counts ok=true rows and locks at 60', async () => {
    attemptFindMany.mockResolvedValue(recent(60, confirmKey('1.2.3.4')))
    await expect(checkLock([confirmKey('1.2.3.4')])).rejects.toMatchObject({ status: 429 })
    expect(attemptFindMany.mock.calls[0][0].where).toMatchObject({ key: { in: ['confirm:ip:1.2.3.4'] }, ok: true })
  })

  it('does not lock at 59', async () => {
    attemptFindMany.mockResolvedValue(recent(59, confirmKey('1.2.3.4')))
    await expect(checkLock([confirmKey('1.2.3.4')])).resolves.toBeUndefined()
  })

  it('failure keys still count ok=false rows: a cook locks at 5, an IP at 20', async () => {
    attemptFindMany.mockResolvedValue(recent(5, 'cook:c1'))
    await expect(checkLock(['cook:c1'])).rejects.toMatchObject({ status: 429 })
    expect(attemptFindMany.mock.calls[0][0].where.ok).toBe(false)
    attemptFindMany.mockResolvedValue(recent(20, 'ip:1.2.3.4'))
    await expect(checkLock(['ip:1.2.3.4'])).rejects.toMatchObject({ status: 429 })
  })

  it('refuses to mix confirm and failure keys in one call', async () => {
    await expect(checkLock(['ip:1.2.3.4', confirmKey('1.2.3.4')])).rejects.toThrow(/mix/)
  })
})

describe('recordAttempt', () => {
  it('writes one row per key in one createMany', async () => {
    await recordAttempt(['ip:1.2.3.4', 'cook:c1'], false)
    expect(attemptCreateMany).toHaveBeenCalledTimes(1)
    expect(attemptCreateMany).toHaveBeenCalledWith({
      data: [
        { key: 'ip:1.2.3.4', ok: false },
        { key: 'cook:c1', ok: false },
      ],
    })
    expect(attemptDeleteMany).not.toHaveBeenCalled()
  })

  it('now and then prunes rows older than 24 hours', async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    const before = Date.now()
    await recordAttempt(['ip:1.2.3.4'], true)
    expect(attemptDeleteMany).toHaveBeenCalledTimes(1)
    const lt = (attemptDeleteMany.mock.calls[0][0].where.createdAt.lt as Date).getTime()
    expect(lt).toBeLessThanOrEqual(before - 24 * 3600_000 + 5)
    expect(lt).toBeGreaterThan(before - 24 * 3600_000 - 1000)
  })

  it('a failed prune never fails the attempt', async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    attemptDeleteMany.mockRejectedValue(new Error('db down'))
    await expect(recordAttempt(['ip:1.2.3.4'], false)).resolves.toBeUndefined()
    expect(attemptCreateMany).toHaveBeenCalled()
  })
})

// ── POST /api/auth/pin ────────────────────────────────────────────────────
describe('POST /api/auth/pin', () => {
  it('rejects a malformed PIN with 400 and never looks up a cook', async () => {
    for (const pin of ['12', '123456789', '12a4', 1234, '']) {
      const res = await signIn({ pin })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Enter your PIN' })
    }
    const bad = await pinRoute.POST(post('/api/auth/pin', null, { raw: 'not json' }))
    expect(bad.status).toBe(400)
    expect(cookFindFirst).not.toHaveBeenCalled()
  })

  it('looks the cook up by the PIN exactly as typed (never padded), active only', async () => {
    await signIn({ pin: '007' })
    expect(cookFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clockId: '007', isActive: true } }),
    )
  })

  it('unknown PIN → 401 and a failed attempt for the IP only', async () => {
    const res = await signIn({ pin: '1234' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'PIN not recognised' })
    expect(written()).toEqual([{ key: 'ip:1.2.3.4', ok: false }])
  })

  it('19 recent failures for the IP still let a cook try (shared kitchen Wi-Fi)', async () => {
    attemptFindMany.mockResolvedValue(recent(19, 'ip:1.2.3.4'))
    const res = await signIn({ pin: '1234' })
    expect(res.status).toBe(401)
    expect(cookFindFirst).toHaveBeenCalled()
  })

  it('20 recent failures for the IP → 429 before the cook lookup', async () => {
    attemptFindMany.mockResolvedValue(recent(20, 'ip:1.2.3.4'))
    const res = await signIn({ pin: '1234' })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too many tries — wait 15 minutes' })
    expect(cookFindFirst).not.toHaveBeenCalled()
    expect(attemptCreateMany).not.toHaveBeenCalled()
  })

  it('5 recent failures for the cook → 429 even from a fresh IP', async () => {
    cookFindFirst.mockResolvedValue(sam)
    attemptFindMany.mockImplementation(async (a: { where: { key: { in: string[] } } }) =>
      a.where.key.in.includes('cook:c1') ? recent(5, 'cook:c1') : [],
    )
    const res = await signIn({ pin: '1234' }, { ip: '5.5.5.5' })
    expect(res.status).toBe(429)
    expect(deviceFindUnique).not.toHaveBeenCalled()
    expect(mintSession).not.toHaveBeenCalled()
  })

  const OK_BOTH = [
    { key: 'ip:1.2.3.4', ok: true },
    { key: 'cook:c1', ok: true },
  ]
  const OK_CONFIRM = [...OK_BOTH, { key: 'confirm:ip:1.2.3.4', ok: true }]

  it('right PIN, no cookie → needsConfirm with the short name, no session, ok rows only', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Sam L.' })
    expect(mintSession).not.toHaveBeenCalled()
    expect(ensurePinUser).not.toHaveBeenCalled()
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(written()).toEqual(OK_BOTH)
  })

  it('right PIN + confirm → pending, sets the device cookie, creates a PENDING device', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ pending: true, name: 'Sam L.', id: 'd1' })
    // The row id lets the waiting screen find its own request; the hash never leaves.
    expect(body.id).toBe('d1')
    expect(body).not.toHaveProperty('tokenHash')

    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('pin_device=')
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=lax/i)
    expect(setCookie).toMatch(/Path=\//)
    expect(setCookie).toContain(`Max-Age=${400 * 24 * 3600}`)
    expect(setCookie).not.toMatch(/Secure/i) // NODE_ENV is 'test'

    const token = res.cookies.get('pin_device')!.value
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(deviceUpsert).toHaveBeenCalledTimes(1)
    const arg = deviceUpsert.mock.calls[0][0]
    expect(arg.where).toEqual({ tokenHash_cookId: { tokenHash: hashToken(token), cookId: 'c1' } })
    expect(arg.create).toEqual({ tokenHash: hashToken(token), cookId: 'c1', status: 'PENDING', label: 'iPhone' })
    expect(arg.update).toEqual({})
    expect(arg.select).toEqual({ id: true })
    expect(JSON.stringify(body)).not.toContain(hashToken(token))
    expect(mintSession).not.toHaveBeenCalled()
    expect(written()).toEqual(OK_CONFIRM)
  })

  it('the device cookie is Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      cookFindFirst.mockResolvedValue(sam)
      const res = await signIn({ pin: '1234', confirm: true })
      expect(res.headers.get('set-cookie') ?? '').toMatch(/;\s*Secure/i)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('confirm reuses the token already on the phone', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.cookies.get('pin_device')?.value).toBe(TOKEN)
    expect(deviceUpsert.mock.calls[0][0].where).toEqual({ tokenHash_cookId: { tokenHash: HASH, cookId: 'c1' } })
  })

  it('confirm on a REVOKED device reopens it only while it is still REVOKED', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'REVOKED' })
    deviceUpdateMany.mockResolvedValue({ count: 1 })
    const before = Date.now()
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ pending: true, name: 'Sam L.', id: 'd1' })
    const arg = deviceUpdateMany.mock.calls[0][0]
    expect(arg.where).toEqual({ tokenHash: HASH, cookId: 'c1', status: 'REVOKED' })
    expect(arg.data).toMatchObject({ status: 'PENDING', approvedById: null, approvedByName: null, approvedAt: null })
    expect((arg.data.createdAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect(deviceUpsert).not.toHaveBeenCalled()
  })

  it('confirm on a REJECTED device is sticky → { rejected }, nothing reopened or created', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'REJECTED' })
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rejected: true, name: 'Sam L.' })
    expect(deviceUpdateMany).not.toHaveBeenCalled()
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(deviceDeleteMany).not.toHaveBeenCalled()
    expect(res.cookies.get('pin_device')).toBeUndefined()
    expect(written()).toEqual(OK_BOTH)
  })

  it('confirm again on a fresh PENDING request: no write, no confirm budget spent', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'PENDING', createdAt: new Date(Date.now() - 23 * 3600_000) })
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ pending: true, name: 'Sam L.', id: 'd1' })
    expect(res.cookies.get('pin_device')?.value).toBe(TOKEN)
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(deviceUpdateMany).not.toHaveBeenCalled()
    expect(deviceDeleteMany).not.toHaveBeenCalled()
    expect(deviceFindMany).not.toHaveBeenCalled()
    const lockKeys = attemptFindMany.mock.calls.flatMap((c) => (c[0] as { where: { key: { in: string[] } } }).where.key.in)
    expect(lockKeys.some((k) => k.startsWith('confirm:'))).toBe(false)
    expect(written()).toEqual(OK_BOTH)
  })

  it('a fresh repeat confirm still answers pending even when the confirm budget is used up', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'PENDING', createdAt: new Date() })
    attemptFindMany.mockImplementation(async (a: { where: { key: { in: string[] } } }) =>
      a.where.key.in.includes('confirm:ip:1.2.3.4') ? recent(60, 'confirm:ip:1.2.3.4') : [],
    )
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pending: true, name: 'Sam L.', id: 'd1' })
  })

  it('confirm on a stale PENDING request (over 24 h) restarts its clock and runs the cap', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'PENDING', createdAt: new Date(Date.now() - 25 * 3600_000) })
    deviceUpdateMany.mockResolvedValue({ count: 1 })
    const before = Date.now()
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ pending: true, name: 'Sam L.', id: 'd1' })
    const arg = deviceUpdateMany.mock.calls[0][0]
    expect(arg.where).toMatchObject({ tokenHash: HASH, cookId: 'c1', status: 'PENDING' })
    const lt = (arg.where.createdAt.lt as Date).getTime()
    expect(Math.abs(lt - (before - 24 * 3600_000))).toBeLessThan(5_000)
    expect(arg.data).toEqual({ createdAt: expect.any(Date) })
    expect((arg.data.createdAt as Date).getTime()).toBeGreaterThanOrEqual(before)
    expect(deviceFindMany).toHaveBeenCalled() // cap ran
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(written()).toEqual(OK_CONFIRM)
  })

  it('a stale PENDING row that changed meanwhile is not capped (nothing reopened)', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'PENDING', createdAt: new Date(Date.now() - 25 * 3600_000) })
    deviceUpdateMany.mockResolvedValue({ count: 0 })
    await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(deviceFindMany).not.toHaveBeenCalled()
  })

  it('keeps at most 3 PENDING requests per cook, dropping the oldest', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindMany.mockResolvedValue([{ id: 'old4' }, { id: 'old5' }])
    await signIn({ pin: '1234', confirm: true })
    expect(deviceFindMany).toHaveBeenCalledWith({
      where: { cookId: 'c1', status: 'PENDING' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 3,
      select: { id: true },
    })
    expect(deviceDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['old4', 'old5'] }, status: 'PENDING' } })
  })

  it('does not delete anything while a cook has 3 or fewer PENDING requests', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindMany.mockResolvedValue([])
    await signIn({ pin: '1234', confirm: true })
    expect(deviceFindMany).toHaveBeenCalled()
    expect(deviceDeleteMany).not.toHaveBeenCalled()
  })

  it('60 confirms from one IP in the window → 429, nothing queued', async () => {
    cookFindFirst.mockResolvedValue(sam)
    attemptFindMany.mockImplementation(async (a: { where: { key: { in: string[] }; ok: boolean } }) =>
      a.where.key.in.includes('confirm:ip:1.2.3.4') && a.where.ok === true ? recent(60, 'confirm:ip:1.2.3.4') : [],
    )
    const res = await signIn({ pin: '1234', confirm: true })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too many tries — wait 15 minutes' })
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(written().some((r) => r.key.startsWith('confirm:'))).toBe(false)
  })

  it('59 confirms is still allowed', async () => {
    cookFindFirst.mockResolvedValue(sam)
    attemptFindMany.mockImplementation(async (a: { where: { key: { in: string[] } } }) =>
      a.where.key.in.includes('confirm:ip:1.2.3.4') ? recent(59, 'confirm:ip:1.2.3.4') : [],
    )
    const res = await signIn({ pin: '1234', confirm: true })
    expect(res.status).toBe(200)
  })

  it('a malformed cookie is ignored and replaced on confirm', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: 'pin_device=evil' })
    expect(deviceFindUnique).not.toHaveBeenCalled()
    expect(res.cookies.get('pin_device')?.value).not.toBe('evil')
  })

  it('right PIN + APPROVED device → signed in with the minted session cookies', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED' })
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ signedIn: true })
    expect(deviceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash_cookId: { tokenHash: HASH, cookId: 'c1' } } }),
    )
    expect(ensurePinUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', userId: 'u1' }))
    expect(mintSession).toHaveBeenCalledTimes(1)
    expect(mintSession.mock.calls[0][1]).toBe('pin.c1@crew.controlaos.vercel.app')
    // The session must be for the login ensurePinUser picked.
    expect(mintSession.mock.calls[0][2]).toBe('u1')
    expect(res.cookies.get('sb-x-auth-token')?.value).toBe('session-value')
    expect(deviceUpdate).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { lastUsedAt: expect.any(Date) } })
    expect(written()).toEqual(OK_BOTH)
  })

  it('an approved sign-in refreshes the phone cookie: same token, full 400 days', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED' })
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ signedIn: true })
    expect(res.cookies.get('pin_device')?.value).toBe(TOKEN)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`pin_device=${TOKEN}`)
    expect(setCookie).toContain(`Max-Age=${400 * 24 * 3600}`)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=lax/i)
    // The session cookies still ride along.
    expect(res.cookies.get('sb-x-auth-token')?.value).toBe('session-value')
  })

  it("a phone OK'd for cook A, used with cook B's PIN → needsConfirm, no session", async () => {
    const kim = { id: 'c2', name: 'Kim', lastName: 'Ng', userId: null, isActive: true }
    cookFindFirst.mockResolvedValue(kim)
    deviceFindUnique.mockImplementation(async (a: { where: { tokenHash_cookId: { cookId: string } } }) =>
      a.where.tokenHash_cookId.cookId === 'c1' ? { id: 'd1', status: 'APPROVED' } : null,
    )
    const res = await signIn({ pin: '5678' }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Kim N.' })
    expect(deviceFindUnique.mock.calls[0][0].where).toEqual({ tokenHash_cookId: { tokenHash: HASH, cookId: 'c2' } })
    expect(ensurePinUser).not.toHaveBeenCalled()
    expect(mintSession).not.toHaveBeenCalled()
  })

  it.each(['PENDING', 'REVOKED', 'REJECTED'])('right PIN + %s device, no confirm → needsConfirm, no session', async (status) => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status })
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Sam L.' })
    expect(mintSession).not.toHaveBeenCalled()
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it("a manager's PIN → 403 before any device is queued; recorded ok, never a failure", async () => {
    cookFindFirst.mockResolvedValue({ ...sam, userId: 'u9' })
    assertPinLoginAllowed.mockRejectedValue(new PinError(403, 'Managers sign in with email and password'))
    for (const confirm of [false, true]) {
      const res = await signIn({ pin: '1234', confirm })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Managers sign in with email and password' })
    }
    expect(assertPinLoginAllowed).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9' }))
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(deviceUpdateMany).not.toHaveBeenCalled()
    expect(mintSession).not.toHaveBeenCalled()
    expect(written()).toEqual([...OK_BOTH, ...OK_BOTH])
  })

  it('a 403 from ensurePinUser on an approved phone is passed through, not a failed PIN', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED', cookId: 'c1', tokenHash: HASH })
    ensurePinUser.mockRejectedValue(new PinError(403, 'This login is switched off'))
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'This login is switched off' })
    expect(mintSession).not.toHaveBeenCalled()
    expect(written().some((r) => !r.ok)).toBe(false)
  })

  it('a session that cannot be minted → 503 with its message, not a wrong-PIN 401', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED' })
    mintSession.mockRejectedValue(new PinError(503, 'Could not sign in — try again'))
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Could not sign in — try again' })
    expect(written().some((r) => !r.ok)).toBe(false)
    expect(res.cookies.get('sb-x-auth-token')).toBeUndefined()
  })

  it('a body not sent as application/json → 415, nothing looked up or recorded', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const headers: Record<string, string> = { 'x-forwarded-for': '1.2.3.4' }
      if (type) headers['content-type'] = type
      const res = await pinRoute.POST(
        new NextRequest('http://localhost/api/auth/pin', { method: 'POST', headers, body: JSON.stringify({ pin: '1234' }) }),
      )
      expect(res.status).toBe(415)
      expect(await res.json()).toEqual({ error: 'Bad request' })
    }
    expect(attemptFindMany).not.toHaveBeenCalled()
    expect(cookFindFirst).not.toHaveBeenCalled()
    expect(attemptCreateMany).not.toHaveBeenCalled()
  })

  it('accepts application/json with a charset', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await pinRoute.POST(
      new NextRequest('http://localhost/api/auth/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ pin: '1234' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Sam L.' })
  })

  it('an unexpected error → 500 generic message, logged without the PIN or token', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED', cookId: 'c1', tokenHash: HASH })
    ensurePinUser.mockRejectedValue(new Error(`supabase exploded near 4821 and ${TOKEN}`))
    const res = await signIn({ pin: '4821' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not sign in — try again' })
    const logged = JSON.stringify(errorSpy.mock.calls)
    expect(logged).toContain('POST /api/auth/pin')
    expect(logged).not.toContain('4821')
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('exploded near 4821') // message never echoed raw
  })
})

// ── GET /api/auth/pin/status ──────────────────────────────────────────────
describe('GET /api/auth/pin/status', () => {
  const get = (cookie?: string) =>
    statusRoute.GET(new NextRequest('http://localhost/api/auth/pin/status', { headers: cookie ? { cookie } : {} }))

  it('no cookie → no devices, no query', async () => {
    const res = await get()
    expect(await res.json()).toEqual({ devices: [] })
    expect(deviceFindMany).not.toHaveBeenCalled()
  })

  it('a cookie with no requests → no devices and no pair code', async () => {
    deviceFindMany.mockResolvedValue([])
    const res = await get(`pin_device=${TOKEN}`)
    expect(await res.json()).toEqual({ devices: [] })
  })

  it('never returns the token or its hash', async () => {
    deviceFindMany.mockResolvedValue([{ id: 'd1', status: 'PENDING', cook: { name: 'Sam', lastName: 'Lee' } }])
    const text = JSON.stringify(await (await get(`pin_device=${TOKEN}`)).json())
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(HASH)
    // The row id is selected; the hash never is.
    expect(deviceFindMany.mock.calls[0][0].select).not.toHaveProperty('tokenHash')
  })

  it('lists this phone’s requests with their row ids, newest first, at most 10', async () => {
    deviceFindMany.mockResolvedValue([{ id: 'd1', status: 'PENDING', cook: { name: 'Sam', lastName: 'Lee' } }])
    const res = await get(`pin_device=${TOKEN}`)
    const body = await res.json()
    expect(body).toEqual({
      devices: [{ id: 'd1', cookName: 'Sam L.', status: 'PENDING' }],
      pairCode: pairCode(HASH),
    })
    expect(body.devices[0].id).toBe('d1')
    expect(body.devices[0]).not.toHaveProperty('tokenHash')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const arg = deviceFindMany.mock.calls[0][0]
    expect(arg.where).toEqual({ tokenHash: HASH })
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.take).toBe(10)
    expect(arg.select).toMatchObject({ id: true })
  })
})
