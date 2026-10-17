import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { DraftData } from '@/lib/recipe-scan/types'

// PATCH /api/recipe-scans/drafts/[draftId] — the review screen's autosave. Its
// reply carries the line costs the screen repaints, never the scan's files: when
// the cloud upload failed those are data: URLs, megabytes on every keystroke save.
// GET still returns them for the original viewer.

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any
  const FILE = { id: 'f1', fileName: 'page.jpg', fileType: 'image/jpeg', fileUrl: `data:image/jpeg;base64,${'A'.repeat(1000)}` }
  /** Answers a findUnique the way Prisma would: only what the select asks for. */
  const pick = (row: Any, select: Any): Any => {
    if (!select) return row
    const out: Any = {}
    for (const [k, v] of Object.entries(select)) {
      if (!v || !(k in row)) continue
      out[k] = v === true ? row[k]
        : Array.isArray(row[k]) ? row[k].map((r: Any) => pick(r, (v as Any).select))
        : pick(row[k], (v as Any).select)
    }
    return out
  }
  const draft: Any = {
    id: 'd1', scanId: 's1', index: 0, title: 'Aioli', status: 'OPEN', savedRecipeId: null, updatedAt: new Date(), data: null,
    scan: { id: 's1', status: 'READ', revenueCenterId: null, files: [FILE], drafts: [{ id: 'd1', index: 0, title: 'Aioli', status: 'OPEN' }] },
  }
  return { FILE, pick, draft }
})

vi.mock('@/lib/auth', () => ({
  requireSession: async () => ({ id: 'u1', role: 'MANAGER', isActive: true }),
  AuthError: class extends Error { status = 401 },
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    recipeScanDraft: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ select }: any) => h.pick(h.draft, select),
      updateMany: async () => ({ count: 1 }),
    },
    recipe: { findMany: async () => [] },
  },
}))
vi.mock('@/lib/recipe-scan/context', () => ({
  draftCosts: async () => ({ l1: { lineCost: 1.25, unpriced: false } }),
  loadDraftContext: async () => ({ candidates: [] }),
}))
vi.mock('@/lib/recipe-scan/build-draft', () => ({ rematchDraft: (d: DraftData) => d }))

import { GET, PATCH } from '../drafts/[draftId]/route'

const data: DraftData = {
  name: 'Aioli', yieldQty: null, yieldUnit: null, yieldGuessed: false, categoryId: null, revenueCenterId: null,
  lines: [{ key: 'l1', raw: '2 egg yolks', name: 'egg yolk', qtyText: '2', qty: null, unit: null, link: null, status: 'NO_MATCH', reason: null, allergens: null }],
  method: [], guessed: {}, siblingHints: {},
}
const ctx = { params: { draftId: 'd1' } }

beforeEach(() => { h.draft.data = data })

describe('draft autosave reply', () => {
  it('PATCH returns the costs and no files', async () => {
    const req = { json: async () => ({ data }) } as unknown as NextRequest
    const res = await PATCH(req, ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.costs).toEqual({ l1: { lineCost: 1.25, unpriced: false } })
    expect(JSON.stringify(body)).not.toContain('data:image')
    expect(body.scan?.files).toBeUndefined()
  })
  it('GET still returns the files for the original viewer', async () => {
    const res = await GET({} as NextRequest, ctx)
    const body = await res.json()
    expect(body.scan.files).toEqual([h.FILE])
  })
})
