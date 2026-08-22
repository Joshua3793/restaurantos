import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Same vi.mock-of-Prisma pattern as src/app/api/tips/roster/__tests__/route.test.ts.
//
// `cookFindMany`'s fake implementation actually honours the `select` clause
// it's called with — pared down from a "full" payroll row — so these tests
// exercise the real bug: GET /api/prep/cooks used to run `findMany` with no
// `select` at all and hand the whole Cook row back to any authenticated
// caller, including STAFF. That row carries `wage` (hourly pay), `clockId`
// (POS employee number), `dailyHourCap`, `tipRoleId`, `onTipPool` and
// `posPosition` — tip-payroll columns documented in prisma/schema.prisma
// that src/lib/tips/me.ts deliberately keeps off a staff member's view of
// their OWN pay. This endpoint was handing out the same fields for the
// whole crew, unauthenticated by role.

type CookRow = Record<string, unknown>

// A "full" Cook row as Prisma would return it with no `select` — includes
// every tip-payroll column alongside the roster-identity fields every real
// consumer (run sheet claim popover, People hub) renders.
const FULL_COOK: CookRow = {
  id: 'c1',
  name: 'Sam Lee',
  initials: 'SL',
  homeStation: 'Grill',
  isActive: true,
  sortOrder: 0,
  lastName: 'Lee',
  clockId: '4521',
  wage: 24.5,
  dailyHourCap: 8,
  tipRoleId: 'r1',
  onTipPool: true,
  posPosition: 'Line Cook',
}

const FULL_COOK_2: CookRow = {
  ...FULL_COOK,
  id: 'c2',
  name: 'Alex Kim',
  initials: 'AK',
  isActive: false,
  clockId: '9910',
  wage: 21,
}

// Mimic Prisma's `select` semantics: only keys explicitly set `true` survive.
function applySelect(row: CookRow, select?: Record<string, boolean>): CookRow {
  if (!select) return row
  const out: CookRow = {}
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key]
  }
  return out
}

const cookFindMany = vi.fn(
  async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> }) => {
    const rows = args?.where && 'isActive' in (args.where ?? {}) ? [FULL_COOK] : [FULL_COOK, FULL_COOK_2]
    return rows.map(r => applySelect(r, args?.select))
  },
)
const requireSession = vi.fn(async () => ({ id: 'u1', role: 'STAFF', isActive: true }))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    cook: {
      findMany: (...a: unknown[]) => cookFindMany(...(a as [never])),
    },
  },
}))
vi.mock('@/lib/auth', () => ({
  requireSession: (...a: unknown[]) => requireSession(...(a as [])),
  AuthError: MockAuthError,
}))

const { GET } = await import('@/app/api/prep/cooks/route')
const { AuthError } = await import('@/lib/auth')

const req = (search?: string) =>
  ({ nextUrl: { searchParams: new URLSearchParams(search ?? '') } }) as unknown as NextRequest

beforeEach(() => {
  cookFindMany.mockClear()
  requireSession.mockClear()
  requireSession.mockResolvedValue({ id: 'u1', role: 'STAFF', isActive: true })
})

describe('GET /api/prep/cooks', () => {
  it('does not leak payroll fields to a non-privileged (STAFF) caller', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    const cooks = await res.json()
    expect(cooks).toHaveLength(1)
    const cook = cooks[0]

    // The fields the run sheet claim popover / crew strip actually render
    // (components/prep/runsheet/assignee.tsx's Cook type).
    expect(cook).toMatchObject({ id: 'c1', name: 'Sam Lee', initials: 'SL', homeStation: 'Grill' })

    // The leak this route.ts fix closes: none of Cook's tip-payroll columns
    // should be reachable through this endpoint, for any caller.
    expect(cook).not.toHaveProperty('wage')
    expect(cook).not.toHaveProperty('clockId')
    expect(cook).not.toHaveProperty('userId')
    expect(cook).not.toHaveProperty('dailyHourCap')
    expect(cook).not.toHaveProperty('tipRoleId')
    expect(cook).not.toHaveProperty('onTipPool')
    expect(cook).not.toHaveProperty('posPosition')
    expect(cook).not.toHaveProperty('lastName')
  })

  it('passes an explicit select (not undefined) so Prisma cannot fall back to selecting every column', async () => {
    await GET(req())
    expect(cookFindMany).toHaveBeenCalledTimes(1)
    const args = cookFindMany.mock.calls[0][0]
    expect(args.select).toBeDefined()
    expect(args.select).toMatchObject({
      id: true,
      name: true,
      initials: true,
      homeStation: true,
      isActive: true,
      sortOrder: true,
    })
    expect(args.select?.wage).toBeUndefined()
    expect(args.select?.clockId).toBeUndefined()
  })

  it('still returns the identity + roster-management fields a deactivated-cook listing needs with ?includeInactive=true', async () => {
    // ?includeInactive=true has NO caller in the app: the retired
    // kitchen-crew page used it, and the People hub that replaced that page
    // (src/app/setup/users/page.tsx) reads /api/settings/people instead. It is
    // kept as the supported way to list deactivated cooks for reactivation, so
    // it still has to return isActive + sortOrder for a reactivate toggle and
    // manual ordering. Nothing gates it: this route is callable at any role
    // (requireSession() with no minimum), so the flag must stay safe there too
    // — which is what the payroll-field assertions below pin down.
    requireSession.mockResolvedValue({ id: 'admin1', role: 'ADMIN', isActive: true })
    const res = await GET(req('includeInactive=true'))
    expect(res.status).toBe(200)
    const cooks = await res.json()
    expect(cooks).toHaveLength(2)
    for (const cook of cooks) {
      expect(cook).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        initials: expect.any(String),
        isActive: expect.any(Boolean),
        sortOrder: expect.any(Number),
      })
      expect(cook).not.toHaveProperty('wage')
      expect(cook).not.toHaveProperty('clockId')
    }
  })

  it('propagates a 401 from requireSession without reaching Prisma', async () => {
    requireSession.mockRejectedValueOnce(new AuthError(401, 'Unauthorized'))
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(cookFindMany).not.toHaveBeenCalled()
  })
})
