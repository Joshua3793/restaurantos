import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { hashToken, LOCK_WINDOW_MS } from '@/lib/pin/rules'
import { PinError } from '@/lib/pin/errors'

// ── Prisma ────────────────────────────────────────────────────────────────
const cookFindFirst = vi.fn()
const deviceFindUnique = vi.fn()
const deviceUpsert = vi.fn()
const deviceUpdate = vi.fn()
const deviceFindMany = vi.fn()
const deviceUpdateMany = vi.fn()
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
const approveRoute = await import('@/app/api/auth/pin/approve-here/route')
const { checkLock, recordAttempt, clientIp } = await import('@/lib/pin/attempts')

// ── Fixtures ──────────────────────────────────────────────────────────────
const TOKEN = 'a'.repeat(43)
const HASH = hashToken(TOKEN)
const sam = { id: 'c1', name: 'Sam', lastName: 'Lee', userId: 'u1', isActive: true }
const boss = {
  id: 'c9',
  name: 'Bea',
  lastName: 'Boss',
  userId: 'u9',
  isActive: true,
  user: { id: 'u9', name: 'Bea Boss', email: 'bea@fergies.ca', role: 'MANAGER', isActive: true },
}
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
const approveHere = (body: unknown, opts?: Parameters<typeof post>[2]) =>
  approveRoute.POST(post('/api/auth/pin/approve-here', body, opts))

const recent = (n: number, key: string) =>
  Array.from({ length: n }, (_, i) => ({ key, createdAt: new Date(Date.now() - (i + 1) * 60_000) }))

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

  it('ignores rows older than the window even if returned', async () => {
    const old = Array.from({ length: 5 }, () => ({ key: 'ip:1.2.3.4', createdAt: new Date(Date.now() - LOCK_WINDOW_MS - 60_000) }))
    attemptFindMany.mockResolvedValue(old)
    await expect(checkLock(['ip:1.2.3.4'])).resolves.toBeUndefined()
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

  it('5 recent failures for the IP → 429 before the cook lookup', async () => {
    attemptFindMany.mockResolvedValue(recent(5, 'ip:1.2.3.4'))
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

  it('right PIN, no cookie → needsConfirm with the short name, no session, no failure', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Sam L.' })
    expect(mintSession).not.toHaveBeenCalled()
    expect(ensurePinUser).not.toHaveBeenCalled()
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(written().some((r) => !r.ok)).toBe(false)
  })

  it('right PIN + confirm → pending, sets the device cookie, upserts a PENDING device', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pending: true, name: 'Sam L.' })

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
    expect(mintSession).not.toHaveBeenCalled()
  })

  it('confirm reuses the token already on the phone', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.cookies.get('pin_device')?.value).toBe(TOKEN)
    expect(deviceUpsert.mock.calls[0][0].where).toEqual({ tokenHash_cookId: { tokenHash: HASH, cookId: 'c1' } })
  })

  it('confirm on a REVOKED device sends it back to PENDING with a fresh request time', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'REVOKED', cookId: 'c1', tokenHash: HASH })
    const before = Date.now()
    await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    const update = deviceUpsert.mock.calls[0][0].update
    expect(update).toMatchObject({ status: 'PENDING', approvedById: null, approvedByName: null, approvedAt: null })
    expect((update.createdAt as Date).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('confirm on an already PENDING device leaves it as it is', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'PENDING', cookId: 'c1', tokenHash: HASH })
    await signIn({ pin: '1234', confirm: true }, { cookie: `pin_device=${TOKEN}` })
    expect(deviceUpsert.mock.calls[0][0].update).toEqual({})
  })

  it('a malformed cookie is ignored and replaced on confirm', async () => {
    cookFindFirst.mockResolvedValue(sam)
    const res = await signIn({ pin: '1234', confirm: true }, { cookie: 'pin_device=evil' })
    expect(deviceFindUnique).not.toHaveBeenCalled()
    expect(res.cookies.get('pin_device')?.value).not.toBe('evil')
  })

  it('right PIN + APPROVED device → signed in with the minted session cookies', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'APPROVED', cookId: 'c1', tokenHash: HASH })
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ signedIn: true })
    expect(deviceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash_cookId: { tokenHash: HASH, cookId: 'c1' } } }),
    )
    expect(ensurePinUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', userId: 'u1' }))
    expect(mintSession).toHaveBeenCalledTimes(1)
    expect(mintSession.mock.calls[0][1]).toBe('pin.c1@crew.controlaos.vercel.app')
    expect(res.cookies.get('sb-x-auth-token')?.value).toBe('session-value')
    expect(deviceUpdate).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { lastUsedAt: expect.any(Date) } })
    expect(written()).toEqual([
      { key: 'ip:1.2.3.4', ok: true },
      { key: 'cook:c1', ok: true },
    ])
  })

  it('right PIN + REVOKED device, no confirm → needsConfirm, no session', async () => {
    cookFindFirst.mockResolvedValue(sam)
    deviceFindUnique.mockResolvedValue({ id: 'd1', status: 'REVOKED', cookId: 'c1', tokenHash: HASH })
    const res = await signIn({ pin: '1234' }, { cookie: `pin_device=${TOKEN}` })
    expect(await res.json()).toEqual({ needsConfirm: true, name: 'Sam L.' })
    expect(mintSession).not.toHaveBeenCalled()
    expect(deviceUpsert).not.toHaveBeenCalled()
  })

  it("a manager's PIN → 403 before any device is queued, not counted as a failure", async () => {
    cookFindFirst.mockResolvedValue({ ...sam, userId: 'u9' })
    assertPinLoginAllowed.mockRejectedValue(new PinError(403, 'Managers sign in with email and password'))
    for (const confirm of [false, true]) {
      const res = await signIn({ pin: '1234', confirm })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Managers sign in with email and password' })
    }
    expect(assertPinLoginAllowed).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u9' }))
    expect(deviceUpsert).not.toHaveBeenCalled()
    expect(mintSession).not.toHaveBeenCalled()
    expect(written().some((r) => !r.ok)).toBe(false)
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

  it('lists this phone’s requests, newest first, at most 5', async () => {
    deviceFindMany.mockResolvedValue([{ status: 'PENDING', cook: { name: 'Sam', lastName: 'Lee' } }])
    const res = await get(`pin_device=${TOKEN}`)
    expect(await res.json()).toEqual({ devices: [{ cookName: 'Sam L.', status: 'PENDING' }] })
    expect(res.headers.get('cache-control')).toContain('no-store')
    const arg = deviceFindMany.mock.calls[0][0]
    expect(arg.where).toEqual({ tokenHash: HASH })
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.take).toBe(5)
  })
})

// ── POST /api/auth/pin/approve-here ───────────────────────────────────────
describe('POST /api/auth/pin/approve-here', () => {
  it('a STAFF PIN → 403, failures recorded for IP and cook, devices untouched', async () => {
    cookFindFirst.mockResolvedValue({ ...boss, user: { ...boss.user, role: 'STAFF' } })
    const res = await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only a manager can OK a phone' })
    expect(deviceUpdateMany).not.toHaveBeenCalled()
    expect(written()).toEqual([
      { key: 'ip:1.2.3.4', ok: false },
      { key: 'cook:c9', ok: false },
    ])
  })

  it('an unknown PIN → 403 with an IP failure only', async () => {
    const res = await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(403)
    expect(written()).toEqual([{ key: 'ip:1.2.3.4', ok: false }])
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('a switched-off manager or a manager cook with no login → 403', async () => {
    cookFindFirst.mockResolvedValueOnce({ ...boss, user: { ...boss.user, isActive: false } })
    expect((await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })).status).toBe(403)
    cookFindFirst.mockResolvedValueOnce({ ...boss, userId: null, user: null })
    expect((await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })).status).toBe(403)
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('locked IP → 429 before the lookup', async () => {
    attemptFindMany.mockResolvedValue(recent(5, 'ip:1.2.3.4'))
    const res = await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(429)
    expect(cookFindFirst).not.toHaveBeenCalled()
  })

  it('malformed PIN → 400', async () => {
    const res = await approveHere({ managerPin: '12' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(400)
    expect(cookFindFirst).not.toHaveBeenCalled()
  })

  it('a manager with no device cookie → 400 Nothing to approve', async () => {
    cookFindFirst.mockResolvedValue(boss)
    const res = await approveHere({ managerPin: '9999' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Nothing to approve on this phone' })
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('a manager PIN approves every PENDING request on this phone', async () => {
    cookFindFirst.mockResolvedValue(boss)
    deviceUpdateMany.mockResolvedValue({ count: 2 })
    const res = await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approved: 2 })
    expect(deviceUpdateMany).toHaveBeenCalledWith({
      where: { tokenHash: HASH, status: 'PENDING' },
      data: { status: 'APPROVED', approvedById: 'u9', approvedByName: 'Bea Boss', approvedAt: expect.any(Date) },
    })
    expect(written()).toEqual([
      { key: 'ip:1.2.3.4', ok: true },
      { key: 'cook:c9', ok: true },
    ])
  })

  it('falls back to the email local part when the manager has no name', async () => {
    cookFindFirst.mockResolvedValue({ ...boss, user: { ...boss.user, name: null } })
    await approveHere({ managerPin: '9999' }, { cookie: `pin_device=${TOKEN}` })
    expect(deviceUpdateMany.mock.calls[0][0].data.approvedByName).toBe('bea')
  })
})
