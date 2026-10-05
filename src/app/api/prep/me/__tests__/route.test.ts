import { describe, it, expect, vi, beforeEach } from 'vitest'

// Same vi.mock-of-Prisma pattern as src/app/api/prep/cooks/__tests__/route.test.ts:
// the fake honours `select`, so a payroll column can only leak if the route asks for it.

type Row = Record<string, unknown>
const LINKED: Row = {
  id: 'c1', name: 'Ana Ruiz', initials: 'AR', homeStation: 'Sauce', isActive: true,
  userId: 'u1', wage: 24.5, clockId: '4521', dailyHourCap: 8,
}

function applySelect(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return row
  return Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]]))
}

let rowForUser: Row | null = LINKED
const cookFindUnique = vi.fn(async (args: { where: { userId: string }; select?: Record<string, boolean> }) =>
  rowForUser && rowForUser.userId === args.where.userId ? applySelect(rowForUser, args.select) : null)
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'STAFF', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}

vi.mock('@/lib/prisma', () => ({ prisma: { cook: { findUnique: (...a: unknown[]) => cookFindUnique(...(a as [never])) } } }))
vi.mock('@/lib/auth', () => ({ requireSession: (...a: unknown[]) => requireSession(...(a as [])), AuthError: MockAuthError }))

const { GET } = await import('@/app/api/prep/me/route')
const { AuthError } = await import('@/lib/auth')

beforeEach(() => {
  rowForUser = LINKED
  requireSession.mockResolvedValue({ id: 'u1', role: 'STAFF', isActive: true })
})

describe('GET /api/prep/me', () => {
  it("returns the caller's crew row and nothing from payroll", async () => {
    const body = await (await GET()).json()
    expect(body).toEqual({ cook: { id: 'c1', name: 'Ana Ruiz', initials: 'AR', homeStation: 'Sauce' } })
  })

  it('is null for a login nobody linked (the shared kitchen iPad)', async () => {
    requireSession.mockResolvedValue({ id: 'kitchen-ipad', role: 'STAFF', isActive: true })
    expect(await (await GET()).json()).toEqual({ cook: null })
  })

  it('is null when the linked crew member is switched off', async () => {
    rowForUser = { ...LINKED, isActive: false }
    expect(await (await GET()).json()).toEqual({ cook: null })
  })

  it('passes a 401 through', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    expect((await GET()).status).toBe(401)
  })
})
