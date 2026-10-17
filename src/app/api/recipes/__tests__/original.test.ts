import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// GET /api/recipes/[id]/original — the photo/file a scanned recipe was read
// from. Any signed-in user may open it (cooks included); a recipe that was not
// scanned has none.

type Role = keyof typeof ROLE_RANK
const h = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
  }
  return {
    MockAuthError,
    role: 'STAFF' as string,
    signedIn: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recipe: null as any,
  }
})
vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: Role) => {
    if (!h.signedIn) throw new h.MockAuthError(401, 'Unauthorized')
    if (min && ROLE_RANK[h.role as Role] < ROLE_RANK[min]) throw new h.MockAuthError(403, 'Forbidden')
    return { id: 'u1', role: h.role, isActive: true }
  },
  AuthError: h.MockAuthError,
}))
const findUnique = vi.fn(async (..._a: unknown[]) => h.recipe)
vi.mock('@/lib/prisma', () => ({ prisma: { recipe: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))

import { GET } from '../[id]/original/route'

const req = {} as NextRequest
const ctx = { params: { id: 'r1' } }
const FILES = [
  { fileName: 'page1.jpg', fileType: 'image/jpeg', fileUrl: 'https://files.example/page1.jpg' },
  { fileName: 'page2.jpg', fileType: 'image/jpeg', fileUrl: 'https://files.example/page2.jpg' },
]

beforeEach(() => {
  h.role = 'STAFF'
  h.signedIn = true
  h.recipe = { sourceScan: { files: FILES } }
  findUnique.mockClear()
})

describe('GET /api/recipes/[id]/original', () => {
  it.each(['STAFF', 'LEAD', 'MANAGER', 'ADMIN'] as const)('any signed-in role can list originals (%s)', async role => {
    h.role = role
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: FILES })
  })

  it('404 without a scan', async () => {
    h.recipe = { sourceScan: null }
    expect((await GET(req, ctx)).status).toBe(404)
  })

  it('404 for a recipe that does not exist', async () => {
    h.recipe = null
    expect((await GET(req, ctx)).status).toBe(404)
  })

  it('unauthenticated gets 401 and never reads the database', async () => {
    h.signedIn = false
    expect((await GET(req, ctx)).status).toBe(401)
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('reads the files in page order', async () => {
    await GET(req, ctx)
    const arg = findUnique.mock.calls[0][0] as { where: { id: string }; select: { sourceScan: { select: { files: { orderBy: unknown } } } } }
    expect(arg.where).toEqual({ id: 'r1' })
    expect(arg.select.sourceScan.select.files.orderBy).toEqual({ sortOrder: 'asc' })
  })
})
