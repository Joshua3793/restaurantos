import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const userFindMany = vi.fn(async () => [] as unknown[])
const cookFindMany = vi.fn(async () => [] as unknown[])
const locationFindMany = vi.fn(async () => [] as unknown[])
const tipRoleFindMany = vi.fn(async () => [] as unknown[])
const prepSettingsFindUnique = vi.fn(async () => null as { stations: string[] } | null)
// Explicit return type (rather than letting it infer from the initial value)
// so later `mockResolvedValue` calls in the POST describe block — which add
// `email`/`name`/`error` fields the GET-only initial value doesn't have — pass
// tsc's excess-property check instead of tripping it.
const requireSession = vi.fn(async (): Promise<
  { id: string; email?: string; name?: string | null; role: string; isActive: boolean }
> => ({ id: 'u9', role: 'ADMIN', isActive: true }))

const cookCreate = vi.fn(async () => ({ id: 'c-new' }))
const cookUpdate = vi.fn(async () => ({ id: 'c-new' }))
const cookCount = vi.fn(async () => 3)
const cookFindUnique = vi.fn(async () => null as { id: string; name: string } | null)
const inviteOne = vi.fn(async (): Promise<
  { email: string; status: string; userId?: string; error?: string }
> => ({ email: 'sam@fergies.test', status: 'invited', userId: 'u-new' }))
const validateAssignmentRows = vi.fn(async () => null as string | null)
// A vi.fn, not a bare arrow: the validate-BEFORE-dedupe order is a named
// behaviour, and only a spy records the invocation order that proves it.
const dedupeAssignmentRows = vi.fn((rows: unknown[]) => rows)
const loadSettings = vi.fn(async () => ({ defaultDailyHourCap: 8 }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findMany: (...a: unknown[]) => userFindMany(...(a as [])) },
    cook: {
      findMany: (...a: unknown[]) => cookFindMany(...(a as [])),
      findUnique: (...a: unknown[]) => cookFindUnique(...(a as [])),
      create: (...a: unknown[]) => cookCreate(...(a as [])),
      update: (...a: unknown[]) => cookUpdate(...(a as [])),
      count: (...a: unknown[]) => cookCount(...(a as [])),
    },
    location: { findMany: (...a: unknown[]) => locationFindMany(...(a as [])) },
    tipRole: { findMany: (...a: unknown[]) => tipRoleFindMany(...(a as [])) },
    prepSettings: { findUnique: (...a: unknown[]) => prepSettingsFindUnique(...(a as [])) },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))
vi.mock('@/lib/user-invite', () => ({ inviteOne: (...a: unknown[]) => inviteOne(...(a as [])) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/tips/settings', () => ({ loadSettings: (...a: unknown[]) => loadSettings(...(a as [])) }))
vi.mock('@/lib/assignment-input', () => ({
  validateAssignmentRows: (...a: unknown[]) => validateAssignmentRows(...(a as [])),
  dedupeAssignmentRows: (...a: unknown[]) => dedupeAssignmentRows(...(a as [unknown[]])),
}))

const { GET, POST } = await import('@/app/api/settings/people/route')
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

import type { NextRequest } from 'next/server'

const postReq = (body: Record<string, unknown>) =>
  ({ json: async () => body, url: 'https://app.test/api/settings/people' }) as unknown as NextRequest

const loginBody = {
  name: 'Sam Lee',
  login: { email: 'sam@fergies.test', clearance: 'STAFF', assignments: [{ locationId: 'loc1', revenueCenterId: null, clearance: null }] },
}
const rosterBody = {
  name: 'Sam',
  roster: { initials: 'SL', homeStation: 'Hot', clockId: '4521', tipRoleId: 'r1', onTipPool: true },
}

describe('POST /api/settings/people', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireSession.mockResolvedValue({ id: 'u9', email: 'admin@fergies.test', name: 'Admin', role: 'ADMIN', isActive: true })
    cookCreate.mockResolvedValue({ id: 'c-new' })
    cookCount.mockResolvedValue(3)
    cookFindUnique.mockResolvedValue(null)
    validateAssignmentRows.mockResolvedValue(null)
    loadSettings.mockResolvedValue({ defaultDailyHourCap: 8 })
    inviteOne.mockResolvedValue({ email: 'sam@fergies.test', status: 'invited', userId: 'u-new' })
  })

  it('requires ADMIN', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(403, 'Forbidden'))
    const res = await POST(postReq(loginBody))
    expect(res.status).toBe(403)
    expect(cookCreate).not.toHaveBeenCalled()
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('rejects a body with neither half', async () => {
    const res = await POST(postReq({ name: 'Sam' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/login|roster/i)
  })

  it('rejects a blank name', async () => {
    const res = await POST(postReq({ ...rosterBody, name: '  ' }))
    expect(res.status).toBe(400)
  })

  it('creates a roster-only person', async () => {
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBe('c-new')
    expect(body.userId).toBeNull()
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('creates a login-only person', async () => {
    const res = await POST(postReq(loginBody))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBeNull()
    expect(body.userId).toBe('u-new')
    expect(cookCreate).not.toHaveBeenCalled()
  })

  it('prefills dailyHourCap from TipSettings — /api/prep/cooks does not, and the hub must not inherit that', async () => {
    await POST(postReq(rosterBody))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dailyHourCap: 8 }) }),
    )
  })

  it('appends the new roster row to the end of the run-sheet order', async () => {
    cookCount.mockResolvedValueOnce(3)
    await POST(postReq(rosterBody))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sortOrder: 3 }) }),
    )
  })

  it('derives initials from the name when none are supplied', async () => {
    await POST(postReq({ name: 'Sam', roster: { onTipPool: true } }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ initials: 'SA' }) }),
    )
  })

  it('creates the roster row BEFORE inviting, and links the two', async () => {
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    expect(cookCreate.mock.invocationCallOrder[0]).toBeLessThan(inviteOne.mock.invocationCallOrder[0])
    expect(cookUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c-new' }, data: { userId: 'u-new' } }),
    )
  })

  it('keeps the roster row and reports the failure when the invite fails', async () => {
    inviteOne.mockResolvedValueOnce({ email: 'sam@fergies.test', status: 'failed', error: 'SMTP down' })
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBe('c-new')
    expect(body.userId).toBeNull()
    expect(body.invite.status).toBe('failed')
    expect(cookUpdate).not.toHaveBeenCalled()
  })

  it('does not attempt the invite when the roster create fails', async () => {
    cookCreate.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(500)
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('returns a readable 409 when the clock id is taken, before creating anything', async () => {
    cookFindUnique.mockResolvedValueOnce({ id: 'other', name: 'Alex Kim' })
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Alex Kim')
    expect(cookCreate).not.toHaveBeenCalled()
  })

  it('rejects a clearance the actor may not hand out', async () => {
    const res = await POST(postReq({ ...loginBody, login: { ...loginBody.login, clearance: 'OWNER' } }))
    expect(res.status).toBe(400)
    expect(inviteOne).not.toHaveBeenCalled()
  })

  it('rejects invalid assignment rows before anything is created', async () => {
    validateAssignmentRows.mockResolvedValueOnce('Unknown revenue center')
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(400)
    expect(cookCreate).not.toHaveBeenCalled()
  })

  // Cook.name is the SHORT FIRST NAME (run-sheet chips, initials seed) and
  // Cook.lastName is its own column — the tip payout CSV exports the two
  // separately, so a full name in Cook.name blanks the Surname column.
  it('splits a two-word name into a first name and a surname', async () => {
    await POST(postReq({ name: 'Sam Lee', roster: rosterBody.roster }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Sam', lastName: 'Lee' }) }),
    )
  })

  it('leaves lastName null for a one-word name', async () => {
    await POST(postReq({ name: 'Sam', roster: rosterBody.roster }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Sam', lastName: null }) }),
    )
  })

  it('keeps every remaining word in the surname', async () => {
    await POST(postReq({ name: 'Ana Maria de Souza', roster: rosterBody.roster }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Ana', lastName: 'Maria de Souza' }) }),
    )
  })

  // User.name is the FULL name and is never synced to Cook.name — only the
  // Cook write splits.
  it('still invites with the full name while the roster row stores the first name', async () => {
    await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(inviteOne).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sam Lee' }))
    expect(cookCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Sam' }) }),
    )
  })

  // Dedupe keeps only the FIRST row per node, so validating afterwards would
  // never see the second submission of the same node with a different clearance.
  it('validates the assignment rows BEFORE deduping them', async () => {
    await POST(postReq(loginBody))
    expect(validateAssignmentRows).toHaveBeenCalled()
    expect(dedupeAssignmentRows).toHaveBeenCalled()
    expect(validateAssignmentRows.mock.invocationCallOrder[0])
      .toBeLessThan(dedupeAssignmentRows.mock.invocationCallOrder[0])
  })

  it('does not dedupe at all when the rows fail validation', async () => {
    validateAssignmentRows.mockResolvedValueOnce('Unknown revenue center')
    await POST(postReq(loginBody))
    expect(dedupeAssignmentRows).not.toHaveBeenCalled()
  })

  // Both halves genuinely exist and are individually correct — only the join
  // failed. That is a warning on a 201, not an error.
  it('degrades a failed link to a warning on a 201, not an error', async () => {
    cookUpdate.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.cookId).toBe('c-new')
    expect(body.userId).toBe('u-new')
    expect(body.warning).toMatch(/link/i)
  })

  it('omits the warning key entirely when the link succeeds', async () => {
    const res = await POST(postReq({ ...loginBody, roster: rosterBody.roster }))
    expect(res.status).toBe(201)
    expect(await res.json()).not.toHaveProperty('warning')
  })

  // The findUnique pre-check can be raced past; the unique violation must land
  // as the same readable 409, not a generic 500.
  it('maps a clockId P2002 race to the same readable 409', async () => {
    cookCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002', clientVersion: 'test', meta: { target: ['clockId'] },
      }),
    )
    cookFindUnique
      .mockResolvedValueOnce(null)                            // pre-check: free
      .mockResolvedValueOnce({ id: 'other', name: 'Alex' })   // post-race holder
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('Alex')
  })

  it('still 500s on a non-P2002 roster create failure', async () => {
    cookCreate.mockRejectedValueOnce(new Error('db down'))
    const res = await POST(postReq(rosterBody))
    expect(res.status).toBe(500)
  })
})
