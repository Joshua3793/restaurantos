import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const requireSession = vi.fn(async (_min?: string) => ({ id: 'm1', name: 'Leo', email: 'leo@x.ca', role: 'MANAGER' }))
const deviceFindUnique = vi.fn()
const deviceUpdateMany = vi.fn()
const cookFindMany = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: {
    pinDevice: {
      findUnique: (...a: unknown[]) => deviceFindUnique(...a),
      updateMany: (...a: unknown[]) => deviceUpdateMany(...a),
    },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [string?])),
  AuthError: MockAuthError,
}))

const { PATCH } = await import('@/app/api/pin-devices/[id]/route')
const { GET } = await import('@/app/api/pin-devices/route')
const { pairCode } = await import('@/lib/pin/rules')

const patch = (body: unknown, id = 'd1') =>
  PATCH({ json: async () => body } as unknown as NextRequest, { params: { id } })

const pendingDevice = (over: Record<string, unknown> = {}, cookOver: Record<string, unknown> = {}) => ({
  id: 'd1',
  status: 'PENDING',
  createdAt: new Date(Date.now() - 60_000),
  cook: { isActive: true, user: { role: 'STAFF', isActive: true }, ...cookOver },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'm1', name: 'Leo', email: 'leo@x.ca', role: 'MANAGER' })
  deviceFindUnique.mockResolvedValue(pendingDevice())
  deviceUpdateMany.mockResolvedValue({ count: 1 })
})

describe('PATCH /api/pin-devices/[id]', () => {
  it('approves a PENDING phone with the approver recorded', async () => {
    const res = await patch({ action: 'approve' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    expect(deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'PENDING' },
      data: { status: 'APPROVED', approvedById: 'm1', approvedByName: 'Leo', approvedAt: expect.any(Date) },
    })
  })

  it('falls back to the email name when the manager has no name', async () => {
    requireSession.mockResolvedValue({ id: 'm1', name: '  ', email: 'leo.k@x.ca', role: 'MANAGER' })
    await patch({ action: 'approve' })
    expect(deviceUpdateMany.mock.calls[0][0].data.approvedByName).toBe('leo.k')
  })

  it('approve on an already APPROVED phone → 409', async () => {
    deviceUpdateMany.mockResolvedValue({ count: 0 })
    const res = await patch({ action: 'approve' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Already handled' })
    expect(deviceUpdateMany.mock.calls[0][0].where).toEqual({ id: 'd1', status: 'PENDING' })
  })

  it('approving a phone with no linked login is allowed (the PIN flow creates it)', async () => {
    deviceFindUnique.mockResolvedValue(pendingDevice({}, { user: null }))
    expect((await patch({ action: 'approve' })).status).toBe(200)
  })

  it.each([
    ['a manager', pendingDevice({}, { user: { role: 'MANAGER', isActive: true } }), 'Managers sign in with email and password'],
    ['an owner', pendingDevice({}, { user: { role: 'OWNER', isActive: true } }), 'Managers sign in with email and password'],
    ['a switched-off login', pendingDevice({}, { user: { role: 'STAFF', isActive: false } }), 'This login is switched off'],
    ['a switched-off cook', pendingDevice({}, { isActive: false }), 'This cook is switched off'],
    [
      'a request over 24 h old',
      pendingDevice({ createdAt: new Date(Date.now() - 25 * 3_600_000) }),
      'This request is too old — ask them to try again on their phone',
    ],
  ])('approve refuses %s with 409 and writes nothing', async (_n, device, message) => {
    deviceFindUnique.mockResolvedValue(device)
    const res = await patch({ action: 'approve' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: message })
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('approves a request just under 24 h old', async () => {
    deviceFindUnique.mockResolvedValue(pendingDevice({ createdAt: new Date(Date.now() - 23 * 3_600_000) }))
    expect((await patch({ action: 'approve' })).status).toBe(200)
  })

  it('reject and revoke are not blocked by those checks', async () => {
    deviceFindUnique.mockResolvedValue(
      pendingDevice({ createdAt: new Date(Date.now() - 48 * 3_600_000) }, { isActive: false, user: { role: 'MANAGER', isActive: false } }),
    )
    expect((await patch({ action: 'reject' })).status).toBe(200)
    expect((await patch({ action: 'revoke' })).status).toBe(200)
  })

  it('reject moves PENDING → REJECTED and leaves the approver fields alone', async () => {
    const res = await patch({ action: 'reject' })
    expect(res.status).toBe(200)
    expect(deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'PENDING' },
      data: { status: 'REJECTED' },
    })
  })

  it('revoke moves APPROVED → REVOKED and leaves the approver fields alone', async () => {
    const res = await patch({ action: 'revoke' })
    expect(res.status).toBe(200)
    expect(deviceUpdateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'APPROVED' },
      data: { status: 'REVOKED' },
    })
  })

  it('revoke on a PENDING phone → 409', async () => {
    deviceUpdateMany.mockResolvedValue({ count: 0 })
    expect((await patch({ action: 'revoke' })).status).toBe(409)
  })

  it('unknown or missing action → 400 and nothing is written', async () => {
    for (const body of [{ action: 'delete' }, { action: 'toString' }, {}, null, { action: 5 }]) {
      const res = await patch(body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Unknown action' })
    }
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('missing device → 404', async () => {
    deviceFindUnique.mockResolvedValue(null)
    const res = await patch({ action: 'approve' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('a LEAD caller → 403 and nothing is written', async () => {
    requireSession.mockRejectedValue(new MockAuthError(403, 'Forbidden'))
    const res = await patch({ action: 'approve' })
    expect(res.status).toBe(403)
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('unexpected failure → 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deviceUpdateMany.mockRejectedValue(new Error('db down'))
    expect((await patch({ action: 'approve' })).status).toBe(500)
  })
})

const NOW = Date.now()
const dev = (id: string, status: string, ageDays: number, extra: Record<string, unknown> = {}) => ({
  id, status, label: 'iPhone', createdAt: new Date(NOW - ageDays * 86_400_000), lastUsedAt: null, approvedByName: null,
  tokenHash: `hash-${id}`, ...extra,
})
const cook = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, lastName: null, homeStation: null, clockId: '1111', sortOrder: 0, user: null, pinDevices: [], ...over,
})

describe('GET /api/pin-devices', () => {
  it('requires MANAGER and a LEAD gets 403', async () => {
    requireSession.mockRejectedValue(new MockAuthError(403, 'Forbidden'))
    expect((await GET()).status).toBe(403)
    expect(requireSession).toHaveBeenCalledWith('MANAGER')
    expect(cookFindMany).not.toHaveBeenCalled()
  })

  it('never returns tokenHash (it is read only to derive the pair code)', async () => {
    cookFindMany.mockResolvedValue([
      cook('c1', 'Sam', { pinDevices: [dev('d1', 'APPROVED', 1, { tokenHash: 'SECRET' }), dev('d2', 'PENDING', 0, { tokenHash: 'SECRET2' })] }),
    ])
    const res = await GET()
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('tokenHash')
    expect(text).not.toContain('SECRET')
    const args = cookFindMany.mock.calls[0][0]
    expect(args.select.pinDevices.select.tokenHash).toBe(true)
    expect(args.where).toEqual({ isActive: true })
  })

  it('carries the pair code on each pending item and each crew device', async () => {
    cookFindMany.mockResolvedValue([
      cook('c1', 'Sam', { pinDevices: [dev('d1', 'APPROVED', 2, { tokenHash: 'h-one' }), dev('d2', 'PENDING', 1, { tokenHash: 'h-two' })] }),
    ])
    const body = await (await GET()).json()
    expect(body.pending).toEqual([expect.objectContaining({ id: 'd2', pairCode: pairCode('h-two') })])
    expect(body.crew[0].devices).toEqual([
      expect.objectContaining({ id: 'd2', pairCode: pairCode('h-two') }),
      expect.objectContaining({ id: 'd1', pairCode: pairCode('h-one') }),
    ])
  })

  it('builds pending (full name, newest first) and crew ordered by status then sortOrder then name', async () => {
    cookFindMany.mockResolvedValue([
      cook('a', 'Ann', { sortOrder: 1, pinDevices: [dev('da', 'APPROVED', 5)] }), // SET UP
      cook('b', 'Bo', { sortOrder: 2, lastName: 'Lee', pinDevices: [dev('db1', 'PENDING', 2), dev('db0', 'APPROVED', 9)] }), // WAITING
      cook('c', 'Cy', { sortOrder: 3, clockId: null }), // NO PIN
      cook('d', 'Di', { sortOrder: 4 }), // NOT YET
      cook('e', 'Ed', { sortOrder: 0, pinDevices: [dev('de', 'PENDING', 1)] }), // WAITING, earlier sortOrder
    ])
    const body = await (await GET()).json()
    expect(body.pending.map((p: { id: string }) => p.id)).toEqual(['de', 'db1'])
    expect(body.pending[1]).toMatchObject({ cookName: 'Bo Lee', label: 'iPhone' })
    expect(body.crew.map((c: { cookId: string }) => c.cookId)).toEqual(['e', 'b', 'd', 'c', 'a'])
    expect(body.crew[1]).toMatchObject({
      name: 'Bo Lee', station: null, status: { label: 'WAITING', tone: 'gold', phones: 1 },
    })
    expect(body.crew[1].devices.map((x: { id: string }) => x.id)).toEqual(['db1', 'db0'])
  })

  it('asks only for REJECTED phones from the last 30 days, newest device first', async () => {
    cookFindMany.mockResolvedValue([])
    await GET()
    const sel = cookFindMany.mock.calls[0][0].select.pinDevices
    expect(sel.orderBy).toEqual({ createdAt: 'desc' })
    expect(sel.where.NOT.status).toBe('REJECTED')
    const cutoff = sel.where.NOT.createdAt.lt as Date
    expect(Math.abs(NOW - 30 * 86_400_000 - cutoff.getTime())).toBeLessThan(60_000)
  })

  it('sorts devices newest first even if the rows arrive in another order', async () => {
    cookFindMany.mockResolvedValue([
      cook('a', 'Ann', { pinDevices: [dev('old', 'REVOKED', 9), dev('new', 'APPROVED', 1)] }),
    ])
    const body = await (await GET()).json()
    expect(body.crew[0].devices.map((x: { id: string }) => x.id)).toEqual(['new', 'old'])
  })

  it('marks managers and switched-off logins as blocked and keeps their phones out of pending', async () => {
    cookFindMany.mockResolvedValue([
      cook('m', 'Mia', { user: { role: 'MANAGER', isActive: true }, pinDevices: [dev('dm', 'PENDING', 1)] }),
      cook('s', 'Sid', { user: { role: 'STAFF', isActive: false }, pinDevices: [dev('ds', 'PENDING', 1)] }),
      cook('l', 'Lou', { user: { role: 'LEAD', isActive: true }, pinDevices: [dev('dl', 'PENDING', 1)] }),
      cook('n', 'Nia'),
    ])
    const body = await (await GET()).json()
    expect(cookFindMany.mock.calls[0][0].select.user).toEqual({ select: { role: true, isActive: true } })
    expect(body.pending.map((p: { id: string }) => p.id)).toEqual(['dl'])
    const by = Object.fromEntries(body.crew.map((c: { cookId: string }) => [c.cookId, c]))
    expect(by.m).toMatchObject({ blocked: 'MANAGER', status: { label: 'EMAIL LOGIN', tone: 'grey' } })
    expect(by.s).toMatchObject({ blocked: 'SWITCHED_OFF', status: { label: 'SWITCHED OFF', tone: 'red' } })
    expect(by.l.blocked).toBeNull()
    expect(by.n.blocked).toBeNull()
    expect(body.crew.map((c: { cookId: string }) => c.cookId).slice(0, 2)).toEqual(['l', 'n'])
  })

  it('includes createdAt on each crew device', async () => {
    cookFindMany.mockResolvedValue([cook('a', 'Ann', { pinDevices: [dev('d1', 'APPROVED', 1)] })])
    const body = await (await GET()).json()
    expect(body.crew[0].devices[0].createdAt).toEqual(expect.any(String))
  })
})
