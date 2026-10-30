import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// People guards for PIN accounts (RULING P9): no promotion above LEAD, no
// invite of the PIN sign-in domain, and deleting a login revokes the cook's phones.

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

const ADMIN = { id: 'a1', email: 'boss@fergies.test', name: 'Boss', role: 'ADMIN', isActive: true }
const requireSession = vi.fn(async () => ADMIN)

const userFindUnique = vi.fn()
const userUpdate = vi.fn()
const userDelete = vi.fn()
const cookFindUnique = vi.fn()
const deviceUpdateMany = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
      delete: (...a: unknown[]) => userDelete(...a),
    },
    cook: { findUnique: (...a: unknown[]) => cookFindUnique(...a) },
    pinDevice: { updateMany: (...a: unknown[]) => deviceUpdateMany(...a) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const getUserById = vi.fn()
const updateUserById = vi.fn()
const deleteUser = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { getUserById, updateUserById, deleteUser } } }),
}))
const recordAccessEvent = vi.fn(async () => undefined)
vi.mock('@/lib/access-audit', () => ({ recordAccessEvent: (...a: unknown[]) => recordAccessEvent(...(a as [])) }))
const inviteOne = vi.fn()
vi.mock('@/lib/user-invite', () => ({ inviteOne: (...a: unknown[]) => inviteOne(...a) }))
vi.mock('@/lib/assignment-input', () => ({
  validateAssignmentRows: async () => null,
  dedupeAssignmentRows: (rows: unknown[]) => rows,
}))

const idRoute = await import('@/app/api/settings/users/[id]/route')
const listRoute = await import('@/app/api/settings/users/route')

const NEEDS_EMAIL = 'This cook signs in with a PIN — give them an email login to make them a manager'
const PIN_ADDR = 'pin.c1@crew.controlaos.vercel.app'

const target = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'sam@fergies.test', name: 'Sam', role: 'STAFF', isActive: true, ...over,
})
const patch = (body: unknown) =>
  idRoute.PATCH(
    new NextRequest('http://localhost/api/settings/users/u1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: 'u1' } },
  )
const del = () => idRoute.DELETE(new NextRequest('http://localhost/api/settings/users/u1', { method: 'DELETE' }), { params: { id: 'u1' } })

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue(ADMIN)
  userFindUnique.mockResolvedValue(target())
  userUpdate.mockImplementation(async (a: { data: object }) => ({ ...target(), ...a.data }))
  userDelete.mockResolvedValue(target())
  cookFindUnique.mockResolvedValue(null)
  deviceUpdateMany.mockResolvedValue({ count: 0 })
  getUserById.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: {} } }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  deleteUser.mockResolvedValue({ error: null })
})

describe('PATCH /api/settings/users/[id] — PIN accounts', () => {
  it.each(['MANAGER', 'ADMIN'])('refuses %s for a PIN-stamped login with 409, writing nothing', async (clearance) => {
    getUserById.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: { pinCookId: 'c1' } } }, error: null })
    const res = await patch({ clearance })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: NEEDS_EMAIL })
    expect(getUserById).toHaveBeenCalledWith('u1')
    expect(userUpdate).not.toHaveBeenCalled()
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('falls back to the PIN email when the auth user has no stamp or cannot be read', async () => {
    userFindUnique.mockResolvedValue(target({ email: PIN_ADDR }))
    expect((await patch({ clearance: 'MANAGER' })).status).toBe(409)
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'down' } })
    expect((await patch({ clearance: 'MANAGER' })).status).toBe(409)
    getUserById.mockRejectedValue(new Error('network'))
    expect((await patch({ clearance: 'MANAGER' })).status).toBe(409)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('still lets a PIN login be made a LEAD', async () => {
    getUserById.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: { pinCookId: 'c1' } } }, error: null })
    const res = await patch({ clearance: 'LEAD' })
    expect(res.status).toBe(200)
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { role: 'LEAD' } })
  })

  it('an ordinary email login can still be made a MANAGER', async () => {
    const res = await patch({ clearance: 'MANAGER' })
    expect(res.status).toBe(200)
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { role: 'MANAGER' } })
  })

  it('a name or active change never asks Supabase who the user is', async () => {
    expect((await patch({ isActive: false })).status).toBe(200)
    expect(getUserById).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/settings/users/[id] — linked cook', () => {
  it("revokes the linked cook's APPROVED and PENDING phones before deleting anything", async () => {
    cookFindUnique.mockResolvedValue({ id: 'c1' })
    deviceUpdateMany.mockResolvedValue({ count: 2 })
    const order: string[] = []
    deviceUpdateMany.mockImplementation(async () => { order.push('revoke'); return { count: 2 } })
    deleteUser.mockImplementation(async () => { order.push('auth-delete'); return { error: null } })
    userDelete.mockImplementation(async () => { order.push('row-delete'); return target() })

    const res = await del()
    expect(res.status).toBe(200)
    expect(cookFindUnique).toHaveBeenCalledWith({ where: { userId: 'u1' }, select: { id: true } })
    expect(deviceUpdateMany).toHaveBeenCalledWith({
      where: { cookId: 'c1', status: { in: ['APPROVED', 'PENDING'] } },
      data: { status: 'REVOKED' },
    })
    expect(order).toEqual(['revoke', 'auth-delete', 'row-delete'])
  })

  it('no linked cook → no phone writes', async () => {
    expect((await del()).status).toBe(200)
    expect(deviceUpdateMany).not.toHaveBeenCalled()
  })

  it('if the revoke fails, nothing is deleted', async () => {
    cookFindUnique.mockResolvedValue({ id: 'c1' })
    deviceUpdateMany.mockRejectedValue(new Error('db down'))
    await expect(del()).rejects.toThrow('db down')
    expect(deleteUser).not.toHaveBeenCalled()
    expect(userDelete).not.toHaveBeenCalled()
  })
})

describe('POST /api/settings/users — PIN sign-in addresses', () => {
  const post = (body: unknown) =>
    listRoute.POST(
      new NextRequest('http://localhost/api/settings/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('refuses any PIN sign-in address with 400 and invites nobody', async () => {
    const res = await post({ emails: ['ok@fergies.test', ' PIN.c1@crew.controlaos.vercel.app '], clearance: 'STAFF', assignments: [] })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/PIN sign-in/)
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('an ordinary address still goes through', async () => {
    inviteOne.mockResolvedValue({ email: 'ok@fergies.test', status: 'invited', userId: 'n1' })
    const res = await post({ emails: ['ok@fergies.test'], clearance: 'STAFF', assignments: [] })
    expect(res.status).toBe(201)
    expect(inviteOne).toHaveBeenCalledTimes(1)
  })
})
