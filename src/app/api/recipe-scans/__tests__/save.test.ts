import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { ROLE_RANK } from '@/lib/roles'
import type { DraftData, DraftLine } from '@/lib/recipe-scan/types'

// POST /api/recipe-scans/drafts/[draftId]/save — one transaction makes the PREP
// recipe, its lines and the learned wordings; a second save of the same draft
// (double tap, two managers) gets 409 and makes nothing.

type Role = keyof typeof ROLE_RANK

const h = vi.hoisted(() => {
  class MockAuthError extends Error {
    constructor(public readonly status: 401 | 403, message: string) { super(message); this.name = 'AuthError' }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any
  const state = {
    role: 'MANAGER' as string,
    draft: null as Any,
    /** When set, findUnique keeps returning this (a stale read, as in a race). */
    staleRead: null as Any,
    recipes: [] as Any[],
    ingredients: [] as Any[],
    aliases: new Map<string, Any>(),
    measures: new Map<string, Any>(),
    invItems: [] as Any[],
    existingNames: [] as string[],
  }
  const calls = {
    recipeCreate: [] as Any[],
    aliasUpsert: [] as Any[],
    measureUpsert: [] as Any[],
  }
  let n = 0
  const id = (p: string) => `${p}${++n}`

  const db: Any = {
    recipeScanDraft: {
      findUnique: async () => (state.staleRead ?? state.draft),
      updateMany: async ({ where, data }: Any) => {
        if (!state.draft || state.draft.id !== where.id || state.draft.status !== where.status) return { count: 0 }
        state.draft = { ...state.draft, ...data }
        return { count: 1 }
      },
      update: async ({ data }: Any) => { state.draft = { ...state.draft, ...data }; return state.draft },
      findMany: async () => [],
    },
    recipe: {
      findMany: async ({ where }: Any) => {
        if (where?.name) return state.existingNames.map(name => ({ name }))
        if (where?.id?.in) {
          return where.id.in.map((rid: string) => ({ id: rid, type: 'PREP', isActive: true, inventoryItem: { baseUnit: 'ml' } }))
        }
        return []
      },
      create: async ({ data }: Any) => {
        calls.recipeCreate.push(data)
        const r = { id: id('rec'), ...data }
        state.recipes.push(r)
        return r
      },
      update: async ({ where, data }: Any) => {
        const r = state.recipes.find(x => x.id === where.id)
        Object.assign(r, data)
        return r
      },
    },
    recipeCategory: { findFirst: async ({ where }: Any) => (where.id === 'cat1' ? { id: 'cat1' } : null) },
    inventoryItem: {
      findMany: async ({ where }: Any) => where.id.in.map((iid: string) => ({
        id: iid, isActive: true, mergedIntoId: null, baseUnit: 'g',
      })),
      findFirst: async () => null,
      create: async ({ data }: Any) => { const it = { id: id('inv'), ...data }; state.invItems.push(it); return it },
      update: async ({ where }: Any) => ({ id: where.id }),
    },
    recipeIngredient: {
      createMany: async ({ data }: Any) => { state.ingredients.push(...data); return { count: data.length } },
    },
    recipeTextAlias: {
      upsert: async (a: Any) => {
        calls.aliasUpsert.push(a)
        const prev = state.aliases.get(a.where.text)
        state.aliases.set(a.where.text, prev ? { ...prev, ...a.update, useCount: prev.useCount + 1 } : a.create)
      },
    },
    itemCountMeasure: {
      upsert: async (a: Any) => {
        calls.measureUpsert.push(a)
        state.measures.set(`${a.where.inventoryItemId_word.inventoryItemId}:${a.where.inventoryItemId_word.word}`, a.create)
      },
    },
  }
  db.$transaction = async (fn: (tx: Any) => Promise<unknown>) => fn(db)
  return { MockAuthError, state, calls, db }
})

vi.mock('@/lib/auth', () => ({
  requireSession: async (min?: Role) => {
    if (min && ROLE_RANK[h.state.role as Role] < ROLE_RANK[min]) throw new h.MockAuthError(403, 'Forbidden')
    return { id: 'u1', role: h.state.role, isActive: true }
  },
  AuthError: h.MockAuthError,
}))
vi.mock('@/lib/prisma', () => ({ prisma: h.db }))
vi.mock('@/lib/rc-scope', () => ({ assertRcWritable: vi.fn(async () => undefined) }))
const recipeCosts = vi.hoisted(() => ({
  resyncPrepRecipe: vi.fn(async () => undefined),
  costContext: vi.fn(), prefetchRecipes: vi.fn(), resolveLinkedRecipes: vi.fn(),
}))
vi.mock('@/lib/recipeCosts', () => recipeCosts)
const prepSync = vi.hoisted(() => ({ syncPrepItemFromRecipe: vi.fn(async () => undefined) }))
vi.mock('@/lib/prep-sync', () => prepSync)

import { POST } from '../drafts/[draftId]/save/route'

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'l1', raw: '60 ml sherry vin', name: 'sherry vin', qtyText: '60 ml',
    qty: 60, unit: 'ml', link: { kind: 'item', id: 'vin', name: 'Sherry Vinegar' },
    status: 'MATCHED', reason: null, allergens: null, ...over,
  }
}
function data(over: Partial<DraftData> = {}): DraftData {
  return {
    name: 'House Romesco', yieldQty: 2, yieldUnit: 'l', yieldGuessed: false,
    categoryId: 'cat1', revenueCenterId: 'rc1',
    lines: [line()],
    method: [{ key: 's1', text: 'Roast the peppers', phase: 'Roast', minutes: 10 }],
    guessed: {}, siblingHints: {}, ...over,
  }
}
function setDraft(d: DraftData) {
  h.state.draft = { id: 'd1', scanId: 'scan1', status: 'OPEN', title: d.name, data: d }
}

/** The review screen posts the draft as it shows it. */
const post = (body: unknown = { data: h.state.draft.data }) =>
  POST({ json: async () => body } as unknown as NextRequest, ctx)
const ctx = { params: { draftId: 'd1' } }

beforeEach(() => {
  h.state.role = 'MANAGER'
  h.state.staleRead = null
  h.state.recipes = []
  h.state.ingredients = []
  h.state.aliases.clear()
  h.state.measures.clear()
  h.state.invItems = []
  h.state.existingNames = []
  h.calls.recipeCreate = []
  h.calls.aliasUpsert = []
  h.calls.measureUpsert = []
  recipeCosts.resyncPrepRecipe.mockClear()
  prepSync.syncPrepItemFromRecipe.mockClear()
  setDraft(data())
})

describe('POST /api/recipe-scans/drafts/[draftId]/save', () => {
  it('MANAGER only', async () => {
    h.state.role = 'STAFF'
    const res = await post()
    expect(res.status).toBe(403)
    expect(h.calls.recipeCreate).toHaveLength(0)
    expect(h.state.draft.status).toBe('OPEN')
  })

  it('creates recipe, lines, aliases in one go', async () => {
    setDraft(data({
      lines: [
        line(),
        line({ key: 'l2', raw: '3 cloves garlic', name: 'garlic', qtyText: '3 cloves', qty: 15, unit: 'g', link: { kind: 'item', id: 'gar', name: 'Garlic Peeled' } }),
        line({ key: 'l3', raw: '1 cup aioli', name: 'aioli', qtyText: '1 cup', qty: 236.588, unit: 'ml', link: { kind: 'recipe', id: 'r9', name: 'House Aioli' } }),
      ],
    }))
    const res = await post()
    expect(res.status).toBe(201)
    const body = await res.json()
    const recipe = h.state.recipes[0]
    expect(body.recipeId).toBe(recipe.id)
    expect(body.inventoryItemId).toBe(h.state.invItems[0].id)

    expect(h.calls.recipeCreate[0]).toMatchObject({
      name: 'House Romesco', type: 'PREP', categoryId: 'cat1', baseYieldQty: 2, yieldUnit: 'l',
      revenueCenterId: 'rc1', sourceScanId: 'scan1', isActive: true,
    })
    expect(h.calls.recipeCreate[0].method).toEqual([{ key: 's1', text: 'Roast the peppers', phase: 'Roast', minutes: 10 }])
    // PREPD item made and linked, as POST /api/recipes does.
    expect(h.state.invItems[0]).toMatchObject({ itemName: 'House Romesco', category: 'PREPD', baseUnit: 'l' })
    expect(recipe.inventoryItemId).toBe(h.state.invItems[0].id)

    expect(h.state.ingredients).toEqual([
      expect.objectContaining({ recipeId: recipe.id, inventoryItemId: 'vin', linkedRecipeId: null, qtyBase: 60, unit: 'ml', notes: '60 ml sherry vin', sortOrder: 0 }),
      expect.objectContaining({ inventoryItemId: 'gar', qtyBase: 15, unit: 'g', sortOrder: 1 }),
      expect.objectContaining({ inventoryItemId: null, linkedRecipeId: 'r9', qtyBase: 236.588, unit: 'ml', sortOrder: 2 }),
    ])

    // Wordings learned (each differs from the item's name); clove weight learned.
    expect([...h.state.aliases.keys()].sort()).toEqual(['aioli', 'garlic', 'sherry vin'])
    expect(h.state.aliases.get('aioli')).toMatchObject({ linkedRecipeId: 'r9', inventoryItemId: null })
    expect(h.state.aliases.get('sherry vin')).toMatchObject({ inventoryItemId: 'vin', linkedRecipeId: null })
    expect(h.calls.aliasUpsert[0].update.useCount).toEqual({ increment: 1 })
    expect(h.state.measures.get('gar:clove')).toMatchObject({ inventoryItemId: 'gar', word: 'clove', qty: 5, unit: 'g' })

    expect(h.state.draft).toMatchObject({ status: 'SAVED', savedRecipeId: recipe.id })
    expect(recipeCosts.resyncPrepRecipe).toHaveBeenCalledWith(recipe.id)
    expect(prepSync.syncPrepItemFromRecipe).toHaveBeenCalledWith(recipe.id)
  })

  it('second save of the same draft is 409', async () => {
    expect((await post()).status).toBe(201)
    expect((await post()).status).toBe(409)
    expect(h.calls.recipeCreate).toHaveLength(1)
  })

  it('second save in a race (both read OPEN) is 409 and makes nothing', async () => {
    h.state.staleRead = { ...h.state.draft }
    expect((await post()).status).toBe(201)
    const res = await post()
    expect(res.status).toBe(409)
    expect(h.calls.recipeCreate).toHaveLength(1)
    expect(h.state.recipes).toHaveLength(1)
  })

  it('unlinked line keeps its words and allergens', async () => {
    setDraft(data({
      lines: [line({
        raw: '3 cloves black garlic', name: 'black garlic', qtyText: '3 cloves',
        link: null, qty: null, unit: null, status: 'NO_MATCH', allergens: ['Sulphites'],
      })],
    }))
    expect((await post()).status).toBe(201)
    expect(h.state.ingredients[0]).toMatchObject({
      inventoryItemId: null, linkedRecipeId: null, customName: 'black garlic',
      qtyBase: 3, unit: 'cloves', allergens: ['Sulphites'], notes: '3 cloves black garlic',
    })
    expect(h.state.aliases.size).toBe(0)
  })

  it('no-amount linked line saves qty 0', async () => {
    setDraft(data({
      lines: [line({
        raw: 'salt to taste', name: 'salt', qtyText: 'to taste', qty: 0, unit: 'g',
        status: 'NO_AMOUNT', link: { kind: 'item', id: 'salt', name: 'Salt' },
      })],
    }))
    expect((await post()).status).toBe(201)
    expect(h.state.ingredients[0]).toMatchObject({ inventoryItemId: 'salt', qtyBase: 0, unit: 'g' })
    expect(h.state.measures.size).toBe(0)
  })

  it('save uses the body data, not the stored data', async () => {
    // Autosave had not landed yet: the stored draft is one edit behind the screen.
    const onScreen = data({
      name: 'Romesco Sauce',
      lines: [line({ qty: 75, raw: '75 ml sherry vin', qtyText: '75 ml' })],
    })
    setDraft(data({ name: 'House Romesco', lines: [line()] }))
    const res = await post({ data: onScreen })
    expect(res.status).toBe(201)
    expect(h.calls.recipeCreate[0].name).toBe('Romesco Sauce')
    expect(h.state.ingredients[0]).toMatchObject({ qtyBase: 75, notes: '75 ml sherry vin' })
    // The draft now holds exactly what was saved.
    expect(h.state.draft.data).toEqual(onScreen)
    expect(h.state.draft).toMatchObject({ status: 'SAVED', title: 'Romesco Sauce' })
  })

  it('invalid body is 400 and saves nothing', async () => {
    for (const body of [null, {}, { data: { lines: [] } }, { data: { ...data(), lines: 'x' } }]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(h.calls.recipeCreate).toHaveLength(0)
    expect(h.state.draft.status).toBe('OPEN')
  })

  it('blockers are checked on the body data', async () => {
    const res = await post({ data: data({ yieldQty: null }) })
    expect(res.status).toBe(400)
    expect((await res.json()).blockers).toEqual(['Add the yield'])
    expect(h.state.draft.status).toBe('OPEN')
  })

  it('a draft with blockers is refused with the reasons', async () => {
    setDraft(data({ lines: [line({ status: 'CHECK' })], categoryId: null }))
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).blockers).toEqual(['1 line needs a check', 'Pick a category'])
    expect(h.calls.recipeCreate).toHaveLength(0)
    expect(h.state.draft.status).toBe('OPEN')
  })

  it('a name already in the Recipe Book is refused', async () => {
    h.state.existingNames = ['house romesco']
    const res = await post()
    expect(res.status).toBe(400)
    expect((await res.json()).blockers).toEqual(['A recipe called House Romesco already exists'])
  })
})
