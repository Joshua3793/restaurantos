import { describe, it, expect, vi, beforeEach } from 'vitest'

const userFindMany = vi.fn(async () => [] as unknown[])
const cookFindMany = vi.fn(async () => [] as unknown[])
const locationFindMany = vi.fn(async () => [] as unknown[])
const tipRoleFindMany = vi.fn(async () => [] as unknown[])
const prepSettingsFindUnique = vi.fn(async () => null as { stations: string[] } | null)
const requireSession = vi.fn(async () => ({ id: 'u9', role: 'ADMIN', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => userFindMany(...(a as [])) },
    cook: { findMany: (...a: unknown[]) => cookFindMany(...(a as [])) },
    location: { findMany: (...a: unknown[]) => locationFindMany(...(a as [])) },
    tipRole: { findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])) },
    prepSettings: { findUnique: (...a: unknown[]) => prepSettingsFindUnique(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { GET } = await import('@/app/api/settings/people/route')
const { AuthError } = await import('@/lib/auth')

const dbCook = (over: Record<string, unknown> = {}) => ({
  id: 'c1', name: 'Mia', lastName: 'Chen', initials: 'MC', homeStation: 'Hot',
  isActive: true, sortOrder: 0, clockId: '1204', posPosition: 'Line Cook',
  wage: '22.5', dailyHourCap: '8', tipRoleId: 'r1', onTipPool: true, ...over,
})

const dbUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1', email: 'mia@fergies.test', name: 'Mia Chen', role: 'STAFF',
  isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
  scopes: [], cook: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  requireSession.mockResolvedValue({ id: 'u9', role: 'ADMIN', isActive: true })
  userFindMany.mockResolvedValue([])
  cookFindMany.mockResolvedValue([])
  locationFindMany.mockResolvedValue([])
  tipRoleFindMany.mockResolvedValue([])
  prepSettingsFindUnique.mockResolvedValue(null)
})

describe('GET /api/settings/people', () => {
  it('requires ADMIN', async () => {
    await GET()
    expect(requireSession).toHaveBeenCalledWith('ADMIN')
  })

  it('returns 403 for a MANAGER without touching the database', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(403, 'Forbidden'))
    const res = await GET()
    expect(res.status).toBe(403)
    expect(userFindMany).not.toHaveBeenCalled()
  })

  it('returns a linked person with both halves', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: dbCook() })])
    const body = await (await GET()).json()
    expect(body.people).toHaveLength(1)
    expect(body.people[0].key).toBe('u1')
    expect(body.people[0].roster.id).toBe('c1')
  })

  it('returns a login-only person with a null roster', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: null })])
    const body = await (await GET()).json()
    expect(body.people[0].roster).toBeNull()
  })

  it('queries only unlinked cooks, so a linked cook cannot appear twice', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ cook: dbCook() })])
    cookFindMany.mockResolvedValueOnce([])
    await GET()
    expect(cookFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: null },
    }))
  })

  it('includes orphan roster rows as roster-only people', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ id: 'c9' })])
    const body = await (await GET()).json()
    expect(body.people[0].key).toBe('cook:c9')
    expect(body.people[0].login).toBeNull()
  })

  it('converts Decimal wage and cap to numbers, not strings', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ wage: '22.5', dailyHourCap: '8' })])
    const body = await (await GET()).json()
    expect(body.people[0].roster.wage).toBe(22.5)
    expect(body.people[0].roster.dailyHourCap).toBe(8)
  })

  it('keeps a null wage null rather than coercing it to 0', async () => {
    cookFindMany.mockResolvedValueOnce([dbCook({ wage: null, dailyHourCap: null })])
    const body = await (await GET()).json()
    expect(body.people[0].roster.wage).toBeNull()
    expect(body.people[0].roster.dailyHourCap).toBeNull()
  })

  it('marks an invited-but-never-accepted account as pending', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ isActive: false, name: null })])
    const body = await (await GET()).json()
    expect(body.people[0].login.isPending).toBe(true)
  })

  it('does not mark a deactivated named account as pending', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({ isActive: false, name: 'Mia Chen' })])
    const body = await (await GET()).json()
    expect(body.people[0].login.isPending).toBe(false)
  })

  it('flattens a revenue-center scope to both its RC and its parent location', async () => {
    userFindMany.mockResolvedValueOnce([dbUser({
      scopes: [{
        id: 's1', clearance: null, location: null,
        revenueCenter: { id: 'rc1', name: 'Cafe', location: { id: 'loc1', name: 'Downtown' } },
      }],
    })])
    const body = await (await GET()).json()
    expect(body.people[0].login.assignments[0]).toMatchObject({
      revenueCenterId: 'rc1', rcName: 'Cafe', locationId: 'loc1', locationName: 'Downtown',
    })
  })

  it('returns tip roles with numeric multipliers', async () => {
    tipRoleFindMany.mockResolvedValueOnce([{ id: 'r1', name: 'Line Cook', multiplier: '1.5', sortOrder: 0 }])
    const body = await (await GET()).json()
    expect(body.tipRoles[0].multiplier).toBe(1.5)
  })

  it('falls back to the default stations when the PrepSettings singleton is missing', async () => {
    prepSettingsFindUnique.mockResolvedValueOnce(null)
    const body = await (await GET()).json()
    expect(body.stations).toContain('Hot')
  })

  it('uses the configured stations when the singleton exists', async () => {
    prepSettingsFindUnique.mockResolvedValueOnce({ stations: ['Grill', 'Fry'] })
    const body = await (await GET()).json()
    expect(body.stations).toEqual(['Grill', 'Fry'])
  })
})
