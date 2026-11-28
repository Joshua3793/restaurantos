import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'

// Linking a scanned barcode to an item (POST /api/inventory/[id]/barcode):
// anyone signed in may fill an empty barcode; replacing a different one is
// MANAGER+; a code already on another active item is refused with its name.

type Role = keyof typeof ROLE_RANK
type Item = { id: string; itemName: string; barcode: string | null; isActive: boolean; recipe?: { type: string } | null }

let items: Item[] = []
let currentRole: Role = 'STAFF'

const update = vi.fn(async ({ where, data }: { where: { id: string }; data: { barcode: string } }) => {
  const it = items.find(i => i.id === where.id)!
  it.barcode = data.barcode
  return { id: it.id, itemName: it.itemName, barcode: it.barcode }
})
type FirstWhere = { barcode: { in: string[] }; isActive: boolean; NOT: [{ id: string }, { recipe: { type: string } }] }
const findFirst = vi.fn(async ({ where }: { where: FirstWhere }) =>
  items.find(i =>
    i.barcode !== null && where.barcode.in.includes(i.barcode) && i.isActive === where.isActive &&
    i.id !== where.NOT[0].id && i.recipe?.type !== where.NOT[1].recipe.type) ?? null)

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryItem: {
      findUnique: async ({ where }: { where: { id: string } }) => items.find(i => i.id === where.id) ?? null,
      findFirst: (a: Parameters<typeof findFirst>[0]) => findFirst(a),
      update: (a: Parameters<typeof update>[0]) => update(a),
    },
  },
}))

class MockAuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
}
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: Role) => {
    if (!signedIn) throw new MockAuthError(401, 'Unauthorized')
    if (min && ROLE_RANK[currentRole] < ROLE_RANK[min]) throw new MockAuthError(403, 'Forbidden')
    return { id: 'u1', role: currentRole, isActive: true }
  },
  AuthError: MockAuthError,
}))

const route = await import('@/app/api/inventory/[id]/barcode/route')
const post = (id: string, body: unknown) =>
  route.POST({ json: async () => body } as unknown as NextRequest, { params: { id } })

beforeEach(() => {
  currentRole = 'STAFF'; signedIn = true
  update.mockClear(); findFirst.mockClear()
  items = [
    { id: 'goat', itemName: 'Goats Cheese', barcode: null, isActive: true },
    { id: 'feta', itemName: 'Feta', barcode: '0123456789012', isActive: true },
    { id: 'old', itemName: 'Old Brie', barcode: '9999999999999', isActive: false },
    { id: 'pesto', itemName: 'Pesto', barcode: null, isActive: true, recipe: { type: 'PREP' } },
    { id: 'gone', itemName: 'Gone Gouda', barcode: null, isActive: false },
  ]
})

describe('POST /api/inventory/[id]/barcode', () => {
  it('refuses when not signed in', async () => {
    signedIn = false
    const res = await post('goat', { barcode: '5000000000001' })
    expect(res.status).toBe(401)
    expect(update).not.toHaveBeenCalled()
  })

  it('lets a cook give a barcode to an item that has none (trimmed)', async () => {
    const res = await post('goat', { barcode: '  5000000000001 ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'goat', itemName: 'Goats Cheese', barcode: '5000000000001' })
    expect(items[0].barcode).toBe('5000000000001')
  })

  it.each([['12345'], ['x'.repeat(33)], ['50000 00001'], ['ab/cd12'], [''], [123456789]])(
    'rejects a malformed code %j', async (code) => {
      const res = await post('goat', { barcode: code })
      expect(res.status).toBe(400)
      expect(update).not.toHaveBeenCalled()
    })

  it('accepts letters and dashes (Code 128)', async () => {
    const res = await post('goat', { barcode: 'SYS-12345-A' })
    expect(res.status).toBe(200)
  })

  it('404s an unknown item', async () => {
    const res = await post('nope', { barcode: '5000000000001' })
    expect(res.status).toBe(404)
  })

  it('refuses a cook replacing an existing different barcode (403)', async () => {
    const res = await post('feta', { barcode: '5000000000001' })
    expect(res.status).toBe(403)
    expect(items[1].barcode).toBe('0123456789012')
    expect(update).not.toHaveBeenCalled()
  })

  it('also refuses a LEAD replacing one', async () => {
    currentRole = 'LEAD'
    expect((await post('feta', { barcode: '5000000000001' })).status).toBe(403)
  })

  it('lets a manager replace an existing barcode', async () => {
    currentRole = 'MANAGER'
    const res = await post('feta', { barcode: '5000000000001' })
    expect(res.status).toBe(200)
    expect(items[1].barcode).toBe('5000000000001')
  })

  it('re-sending the same code is a no-op success for anyone', async () => {
    const res = await post('feta', { barcode: '0123456789012' })
    expect(res.status).toBe(200)
    expect(update).not.toHaveBeenCalled()
  })

  it("409s when another active item already has the code, naming it", async () => {
    currentRole = 'MANAGER'
    const res = await post('goat', { barcode: '0123456789012' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.itemName).toBe('Feta')
    expect(body.error).toContain('Feta')
    expect(items[0].barcode).toBeNull()
  })

  it('ignores a code held only by an inactive item', async () => {
    const res = await post('goat', { barcode: '9999999999999' })
    expect(res.status).toBe(200)
    expect(items[0].barcode).toBe('9999999999999')
  })

  it('409s when another item holds the same code spelled as UPC-A (no leading 0)', async () => {
    currentRole = 'MANAGER'
    // Feta has the EAN-13 0123456789012; the scanner reported the 12-digit UPC-A.
    const res = await post('goat', { barcode: '123456789012' })
    expect(res.status).toBe(409)
    expect((await res.json()).itemName).toBe('Feta')
    expect(findFirst.mock.calls[0][0].where.barcode).toEqual({ in: ['123456789012', '0123456789012'] })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to link a barcode to an inactive item (400)', async () => {
    const res = await post('gone', { barcode: '5000000000001' })
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to link a barcode to a prep recipe item (400)', async () => {
    currentRole = 'MANAGER'
    const res = await post('pesto', { barcode: '5000000000001' })
    expect(res.status).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  it('the conflict check skips prep recipe items, like the scan lookup', async () => {
    items.push({ id: 'aioli', itemName: 'Aioli', barcode: '7777777777777', isActive: true, recipe: { type: 'PREP' } })
    const res = await post('goat', { barcode: '7777777777777' })
    expect(res.status).toBe(200)
    expect(findFirst.mock.calls[0][0].where.NOT).toEqual([{ id: 'goat' }, { recipe: { type: 'PREP' } }])
  })
})
