# Item backbone — Stage 2a: safe editing, the server rules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The item edit API can no longer break the app: it accepts an explicit allow-list (R1), stock changes only through a count (R2), an item's measure (weight / volume / each) is locked once it has history (R3, the lock only — the guided fix is Stage 2c), prices live on the box so the item's own price is editable only while it has no box (R4, the gate only — box add/edit/remove screens are Stage 2b), no $0 price slips through (R5), prep-owned fields are refused (R6), removing a bridge warns and flags the recipes that depend on it (R7), and two people editing at once get a clear "someone saved first" instead of a silent overwrite (R8). The drawer is changed only as far as these contracts require; its library redesign is Stage 4.

**Architecture:** One new pure/server helper module `src/lib/item-history.ts` (`hasItemHistory`, `bridgeUsedBy`); `PUT /api/inventory/[id]` shrinks to the allow-list and gains `expectedLastUpdated`; a new `PATCH /api/inventory/[id]/pricing` carries dimension/chain/pricing for box-less, non-prep items (409 `HAS_OFFERS` / `DIMENSION_LOCKED` / `PREP_OWNED` / `STALE`); `validateChainItem` gains a positive-price requirement; `mirrorItemToPrimaryOffer` is deleted (nothing flows item→box any more); the dead "mark counted" route and two unguarded maintenance routes are fixed; a `RECIPE_CONFLICT` signal rule surfaces recipes whose ingredient can no longer be converted. `GET /api/inventory/[id]` returns `hasHistory`, `offerCount` and `bridgeUsedBy` so the drawer can hide/lock the right controls.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma, vitest, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §3 (R1–R8). Stage 1 (PRs #154 #155 #156 #158) is merged; main = `4322f29`.

## Global Constraints

- Branch off `origin/main` (= `4322f29`). Worktree `.claude/worktrees/safe-edit-rules`, branch `worktree-safe-edit-rules`, pushed as `feat/safe-edit-rules`. One PR, squash-merged. **No migration, no live-data writes.**
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules`/`.env` are symlinks. After `EnterWorktree`, run `git fetch origin && git reset --hard origin/main` before anything else (the harness may branch from a stale ref).
- **No stored number changes**: a save that passes the new rules writes exactly what it wrote before, minus the fields the allow-list drops.
- Error contract for every refusal in this plan: `NextResponse.json({ error: <plain-English sentence>, code: <CODE> }, { status })` with codes `STALE` (409), `PREP_OWNED` (409), `HAS_OFFERS` (409), `DIMENSION_LOCKED` (409), `BRIDGE_IN_USE` (409, dry-run only), `ZERO_PRICE` (400). Plain-English sentences, restaurant words ("supplier box", "count"), no field names.
- Role gates unchanged: item edits are MANAGER+ (`requireSession('MANAGER')`), quick count is every role.
- Prisma `Decimal` values arrive as strings — `Number()` before arithmetic. Dates compare by `getTime()`.
- Tests: `npm test` green; `npm run build` green; lint findings identical to `main` (20 pre-existing files).

---

### Task 1: `item-history.ts` — has this item got history, and who depends on its bridge?

**Files:**
- Create: `src/lib/item-history.ts`
- Test: `src/lib/__tests__/item-history.test.ts`

**Interfaces (used by Tasks 2–5):**
```ts
export interface ItemHistory { counts: number; snapshots: number; receipts: number; recipeLines: number; wastage: number; transfers: number; offers: number }
export async function itemHistory(itemId: string): Promise<ItemHistory>          // one Promise.all of counts
export function hasHistory(h: ItemHistory): boolean                               // any count > 0, or offers >= 2
export async function bridgeUsedBy(itemId: string): Promise<{ id: string; name: string; type: string }[]>
  // recipes with a RecipeIngredient on this item whose unit's dimension differs from the item's (needs the each-measure to cost)
```

- [ ] **Step 1: Failing tests**

`src/lib/__tests__/item-history.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
const db = vi.hoisted(() => ({
  countLine: { count: vi.fn() }, inventorySnapshot: { count: vi.fn() }, invoiceScanItem: { count: vi.fn() },
  recipeIngredient: { count: vi.fn(), findMany: vi.fn() }, wastageLog: { count: vi.fn() }, stockTransfer: { count: vi.fn() },
  inventorySupplierPrice: { count: vi.fn() }, inventoryItem: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
import { itemHistory, hasHistory, bridgeUsedBy } from '@/lib/item-history'

const zero = () => { for (const t of Object.values(db)) for (const f of Object.values(t)) (f as ReturnType<typeof vi.fn>).mockReset() }

describe('itemHistory / hasHistory', () => {
  beforeEach(zero)
  it('counts every table once and reports no history for a fresh item with one box', async () => {
    for (const t of ['countLine', 'inventorySnapshot', 'invoiceScanItem', 'recipeIngredient', 'wastageLog', 'stockTransfer'] as const) db[t].count.mockResolvedValue(0)
    db.inventorySupplierPrice.count.mockResolvedValue(1)
    const h = await itemHistory('i1')
    expect(h).toEqual({ counts: 0, snapshots: 0, receipts: 0, recipeLines: 0, wastage: 0, transfers: 0, offers: 1 })
    expect(hasHistory(h)).toBe(false)
  })
  it('one count line is history; two boxes are history', () => {
    const base = { counts: 0, snapshots: 0, receipts: 0, recipeLines: 0, wastage: 0, transfers: 0, offers: 0 }
    expect(hasHistory({ ...base, counts: 1 })).toBe(true)
    expect(hasHistory({ ...base, offers: 2 })).toBe(true)
    expect(hasHistory({ ...base, offers: 1 })).toBe(false)
  })
})

describe('bridgeUsedBy — recipes that only cost through the each-measure', () => {
  beforeEach(zero)
  it('lists recipes using a per-each item by weight, not the ones using it by each', async () => {
    db.inventoryItem.findUnique.mockResolvedValue({ baseUnit: 'each', dimension: 'COUNT' })
    db.recipeIngredient.findMany.mockResolvedValue([
      { unit: 'g', recipe: { id: 'r1', name: 'Burger', type: 'MENU' } },
      { unit: 'each', recipe: { id: 'r2', name: 'Bun basket', type: 'MENU' } },
      { unit: 'kg', recipe: { id: 'r3', name: 'Stuffing', type: 'PREP' } },
    ])
    const r = await bridgeUsedBy('bun')
    expect(r.map(x => x.id)).toEqual(['r1', 'r3'])
  })
  it('a by-weight item used by count lists those recipes', async () => {
    db.inventoryItem.findUnique.mockResolvedValue({ baseUnit: 'g', dimension: 'MASS' })
    db.recipeIngredient.findMany.mockResolvedValue([{ unit: 'each', recipe: { id: 'r9', name: 'Loaf plate', type: 'MENU' } }])
    expect((await bridgeUsedBy('loaf')).map(x => x.id)).toEqual(['r9'])
  })
})
```

- [ ] **Step 2: Run — fail** (`npx vitest run src/lib/__tests__/item-history.test.ts`: module missing).

- [ ] **Step 3: Implement**

`src/lib/item-history.ts`:
```ts
// "Does this item have history?" — the one question the edit rules ask before
// letting a manager change what the item IS (its measure) or how it is priced.
// Frozen numbers (count lines, snapshots, receipts, wastage, transfers) are in
// the item's base unit; recipe lines convert through it; a second box means
// another supplier's pack is expressed in it. Any of those makes a measure
// change a data rewrite, which is Stage 2c's guided flow, never a plain save.
import { prisma } from '@/lib/prisma'
import { dimensionOf } from '@/lib/item-model'

export interface ItemHistory {
  counts: number; snapshots: number; receipts: number; recipeLines: number
  wastage: number; transfers: number; offers: number
}

export async function itemHistory(itemId: string): Promise<ItemHistory> {
  const [counts, snapshots, receipts, recipeLines, wastage, transfers, offers] = await Promise.all([
    prisma.countLine.count({ where: { inventoryItemId: itemId } }),
    prisma.inventorySnapshot.count({ where: { inventoryItemId: itemId } }),
    prisma.invoiceScanItem.count({ where: { matchedItemId: itemId, approved: true } }),
    prisma.recipeIngredient.count({ where: { inventoryItemId: itemId } }),
    prisma.wastageLog.count({ where: { inventoryItemId: itemId } }),
    prisma.stockTransfer.count({ where: { inventoryItemId: itemId } }),
    prisma.inventorySupplierPrice.count({ where: { inventoryItemId: itemId } }),
  ])
  return { counts, snapshots, receipts, recipeLines, wastage, transfers, offers }
}

export function hasHistory(h: ItemHistory): boolean {
  return h.counts > 0 || h.snapshots > 0 || h.receipts > 0 || h.recipeLines > 0
    || h.wastage > 0 || h.transfers > 0 || h.offers >= 2
}

/** Recipes whose line on this item is in another dimension than the item's base —
 *  they cost ONLY through the item's each-measure, and read $0 (dimension conflict)
 *  the moment it is removed. */
export async function bridgeUsedBy(itemId: string): Promise<{ id: string; name: string; type: string }[]> {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { baseUnit: true, dimension: true } })
  if (!item) return []
  const lines = await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: itemId },
    select: { unit: true, recipe: { select: { id: true, name: true, type: true } } },
  })
  const seen = new Map<string, { id: string; name: string; type: string }>()
  for (const l of lines) {
    if (dimensionOf(l.unit) === item.dimension) continue
    const crossesCount = item.dimension === 'COUNT' || dimensionOf(l.unit) === 'COUNT'
    if (crossesCount && !seen.has(l.recipe.id)) seen.set(l.recipe.id, l.recipe)
  }
  return Array.from(seen.values())
}
```

- [ ] **Step 4: Run — pass; commit**

```bash
git add src/lib/item-history.ts src/lib/__tests__/item-history.test.ts
git commit -m "feat(items): itemHistory/hasHistory and bridgeUsedBy — the questions the edit rules ask"
```

---

### Task 2: `PUT /api/inventory/[id]` — allow-list, optimistic concurrency, prep guard, bridge dry-run (R1, R6, R7, R8)

**Files:**
- Modify: `src/app/api/inventory/[id]/route.ts` (`handlePUT` ~48–170; `GET` adds `hasHistory`, `offerCount`, `bridgeUsedBy`)
- Test: `src/app/api/inventory/__tests__/edit-rules.test.ts` (new)

**Interfaces:**
- PUT body (only these keys are read; any other key → 400 `{ error: "That field can't be changed here.", code: 'BAD_FIELD' }`): `itemName, category, storageAreaId, isActive, isStocked, allergens, barcode, countUnit, eachMeasureQty, eachMeasureUnit, densityGPerMl, expectedLastUpdated`. `expectedLastUpdated` (ISO string) is REQUIRED → 400 without it; mismatch with the row's `lastUpdated` → 409 `STALE`: "Someone saved this item a moment ago. Reload to see their change before saving yours."
- Query `?dryRun=1`: validates and returns `{ ok: true, bridgeUsedBy: [...] }` without writing — used by the drawer before clearing a bridge.
- Prep-linked item (`recipe != null`): `itemName`, `allergens`, `countUnit` present in the body and different from the row → 409 `PREP_OWNED`: "This item is made from a recipe. Change its name, allergens or count unit in the recipe."
- `countUnit` is validated with `validateChainItem` against the stored chain/dimension (unchanged chain).
- Bridges keep today's PATCH semantics (missing key = unchanged, empty = clear, invalid unit = 400).
- Response: unchanged shape (`postUpdate`), but `mirrorItemToPrimaryOffer` is no longer called (Task 3 deletes it).
- GET adds: `hasHistory: boolean`, `offerCount: number`, `bridgeUsedBy: [{ id, name, type }]`.

- [ ] **Step 1: Failing tests**

`src/app/api/inventory/__tests__/edit-rules.test.ts` (same mocking pattern as `money-and-edit-gates.test.ts`; copy its `MockAuthError`, `requireSession`, `putReq`, `getReq` helpers):
```ts
// fixtures
const NOW = new Date('2026-10-03T10:00:00.000Z')
const ITEM = { id: 'i1', itemName: 'Butter', category: 'DAIRY', baseUnit: 'g', dimension: 'MASS', countUnit: 'case',
  packChain: [{ unit: 'case', per: 11350 }], pricing: { mode: 'PACK', purchasePrice: 142.5 },
  eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null, allergens: ['MLK'], mergedIntoId: null,
  lastUpdated: NOW, recipe: null, isStocked: true, supplierPrices: [] }
const update = vi.fn(async ({ data }) => ({ ...ITEM, ...data }))
vi.mock('@/lib/prisma', () => ({ prisma: {
  inventoryItem: { findUnique: async () => ITEM, update },
  recipe: { findFirst: async () => null, findMany: async () => [] },
  inventorySupplierPrice: { count: async () => 0, findFirst: async () => null },
  countLine: { count: async () => 0 }, inventorySnapshot: { count: async () => 0 }, invoiceScanItem: { count: async () => 0 },
  recipeIngredient: { count: async () => 0, findMany: async () => [] }, wastageLog: { count: async () => 0 }, stockTransfer: { count: async () => 0 },
} }))
vi.mock('@/lib/recipeCosts', () => ({ syncPrepToInventory: async () => {}, propagatePrepCostChanges: async () => [] }))
vi.mock('@/lib/cost-basis', async (o) => ({ ...(await o()), windowedAvgCost: async () => new Map() }))
// role MANAGER for all

describe('PUT /api/inventory/[id] — R1 allow-list', () => {
  it('refuses a key outside the allow-list', async () => {
    const res = await item.PUT(putReq({ itemName: 'Butter', stockOnHand: 5, expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(400); expect((await res.json()).code).toBe('BAD_FIELD')
  })
  it('ignores nothing silently: pricing/packChain/dimension are not accepted here', async () => {
    const res = await item.PUT(putReq({ pricing: { mode: 'PACK', purchasePrice: 1 }, expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(400)
  })
  it('writes only the allowed fields', async () => {
    update.mockClear()
    const res = await item.PUT(putReq({ itemName: 'Butter Unsalted', barcode: '9', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(200)
    expect(Object.keys(update.mock.calls[0][0].data).sort()).toEqual(['barcode', 'itemName', 'lastUpdated'])
  })
})
describe('R8 — two people editing', () => {
  it('requires expectedLastUpdated', async () => { expect((await item.PUT(putReq({ itemName: 'x' }), ctx)).status).toBe(400) })
  it('refuses a stale save with STALE', async () => {
    const res = await item.PUT(putReq({ itemName: 'x', expectedLastUpdated: '2026-10-03T09:00:00.000Z' }), ctx)
    expect(res.status).toBe(409); expect((await res.json()).code).toBe('STALE')
  })
})
describe('R6 — prep-owned fields', () => {
  it('refuses a name change on a recipe-made item', async () => {
    // swap fixture: recipe set
    ;(ITEM as any).recipe = { id: 'r1', name: 'Bacon Jam' }
    const res = await item.PUT(putReq({ itemName: 'Other', expectedLastUpdated: NOW.toISOString() }), ctx)
    expect(res.status).toBe(409); expect((await res.json()).code).toBe('PREP_OWNED')
    ;(ITEM as any).recipe = null
  })
})
describe('R7 — bridge dry run', () => {
  it('reports the recipes that would lose their costing', async () => {
    // mock bridgeUsedBy's queries: item COUNT with a g line
    // (set ITEM.dimension/baseUnit to COUNT/each and recipeIngredient.findMany to return a g line for this test)
    ...
    const res = await item.PUT(putReq({ eachMeasureQty: null, expectedLastUpdated: NOW.toISOString() }, '?dryRun=1'), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()).bridgeUsedBy).toEqual([{ id: 'r1', name: 'Burger', type: 'MENU' }])
  })
})
```
(Write the R7 test body fully: use `vi.mocked`-style swappable mocks for `recipeIngredient.findMany` and set the fixture's dimension to COUNT for that case; restore after.)

- [ ] **Step 2: Run — fail** (today the route accepts everything and never 409s).

- [ ] **Step 3: Implement `handlePUT`**

Replace the destructuring + `delete rest.*` block and the `update` with:
```ts
  const url = new URL(req.url)
  const dryRun = url.searchParams.get('dryRun') === '1'
  const body = await req.json()
  const ALLOWED = ['itemName', 'category', 'storageAreaId', 'isActive', 'isStocked', 'allergens', 'barcode', 'countUnit', 'eachMeasureQty', 'eachMeasureUnit', 'densityGPerMl', 'expectedLastUpdated'] as const
  const bad = Object.keys(body).filter(k => !(ALLOWED as readonly string[]).includes(k))
  if (bad.length) return NextResponse.json({ error: "That field can't be changed here.", code: 'BAD_FIELD', fields: bad }, { status: 400 })
  if (!body.expectedLastUpdated) return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD', fields: ['expectedLastUpdated'] }, { status: 400 })

  const before = await prisma.inventoryItem.findUnique({
    where: { id: params.id },
    select: { id: true, itemName: true, allergens: true, countUnit: true, mergedIntoId: true, lastUpdated: true,
      dimension: true, baseUnit: true, packChain: true, pricing: true, isStocked: true,
      eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true, recipe: { select: { id: true, name: true } } },
  })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tombstonedRows([before]).length) return NextResponse.json({ error: TOMBSTONE_EDIT_ERROR, code: 'TOMBSTONE' }, { status: 409 })
  if (new Date(body.expectedLastUpdated).getTime() !== before.lastUpdated.getTime()) {
    return NextResponse.json({ error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.', code: 'STALE' }, { status: 409 })
  }
  // R6 — a recipe-made item is named, allergened and count-united by its recipe.
  if (before.recipe) {
    const changed = (k: 'itemName' | 'countUnit') => k in body && body[k] !== before[k]
    const allergensChanged = 'allergens' in body && JSON.stringify([...(body.allergens ?? [])].sort()) !== JSON.stringify([...(before.allergens ?? [])].sort())
    if (changed('itemName') || changed('countUnit') || allergensChanged) {
      return NextResponse.json({ error: `This item is made from the recipe "${before.recipe.name}". Change its name, allergens or count unit in the recipe.`, code: 'PREP_OWNED' }, { status: 409 })
    }
  }
```
Keep the bridge-field handling exactly as today (it reads `eachMeasureQty`/`eachMeasureUnit`/`densityGPerMl` from `body`). Validation: build `ci` from the STORED chain/pricing/dimension with the incoming `countUnit ?? before.countUnit` and the effective bridges; `validateChainItem(ci)` → 400 as today. Then:
```ts
  if (dryRun) {
    const clearingBridge = hasEachMeasure && !emValid && eachMeasureOf(before) !== null
    return NextResponse.json({ ok: true, bridgeUsedBy: clearingBridge ? await bridgeUsedBy(params.id) : [] })
  }
  const data: Prisma.InventoryItemUncheckedUpdateInput = { lastUpdated: new Date() }
  for (const k of ['itemName', 'category', 'isActive', 'isStocked', 'allergens', 'barcode', 'countUnit'] as const) if (k in body) (data as any)[k] = body[k]
  if ('storageAreaId' in body) data.storageAreaId = body.storageAreaId || null
  if (hasEachMeasure) { data.eachMeasureQty = emValid ? emQty : null; data.eachMeasureUnit = emValid ? emUnit : null }
  if (hasDensity) data.densityGPerMl = nextDensity
  await prisma.inventoryItem.update({ where: { id: params.id }, data })
  return await postUpdate(params.id, before.allergens ?? [], body.allergens)
```
In `postUpdate`, delete the `mirrorItemToPrimaryOffer(id)` call and its comment (Task 3 deletes the function). Remove the now-unused imports (`keepBridgedRate`, `DIMENSION_BASE`, `ChainItem`, `Pricing` if unused).

GET: after loading `item`, `const [h, usedBy] = await Promise.all([itemHistory(item.id), bridgeUsedBy(item.id)])` and add to `body`: `hasHistory: hasHistory(h), offerCount: h.offers, bridgeUsedBy: usedBy`.

- [ ] **Step 4: Run the new test + `money-and-edit-gates.test.ts`** — update the latter's PUT cases to send `expectedLastUpdated` (its ITEM fixture gains `lastUpdated`) and its "lets a MANAGER through to validation" case now expects 400 with code `BAD_FIELD` for `{}` (no `expectedLastUpdated`). PASS both.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inventory/[id]/route.ts src/app/api/inventory/__tests__/edit-rules.test.ts src/app/api/inventory/__tests__/money-and-edit-gates.test.ts
git commit -m "feat(items): the item edit route takes an allow-list, refuses stale and recipe-owned saves, and can dry-run a bridge removal"
```

---

### Task 3: `PATCH /api/inventory/[id]/pricing` for box-less items; no $0; the item→box mirror goes (R3 lock, R4 gate, R5)

**Files:**
- Create: `src/app/api/inventory/[id]/pricing/route.ts`
- Modify: `src/lib/item-model.ts` (`validateChainItem` gains `opts?: { requirePositivePrice?: boolean }`)
- Modify: `src/lib/primary-offer.ts` (delete `mirrorItemToPrimaryOffer`), `src/app/api/invoices/sessions/[id]/approve/route.ts` (its one call → delete; the primary's box already carries the written price there — confirm by reading ~862–870: the item was re-priced FROM the offer, so the mirror was redundant; remove the call and the import)
- Tests: `src/lib/__tests__/item-model.test.ts` (append), `src/app/api/inventory/__tests__/pricing-route.test.ts` (new)

**Interfaces:**
- `PATCH /api/inventory/[id]/pricing` body: `{ dimension?: 'MASS'|'VOLUME'|'COUNT', packChain, pricing, countUnit?, expectedLastUpdated }` (MANAGER+). Order of refusals: 404; tombstone 409; `STALE` 409; `PREP_OWNED` 409 (any prep-linked item: "This item's price comes from its recipe."); `HAS_OFFERS` 409 when `itemHistory(id).offers > 0` ("This item's price lives on its supplier box. Edit the box instead."); `DIMENSION_LOCKED` 409 when `dimension` differs from the stored one and `hasHistory(h)` ("This item already has counts, deliveries or recipes in its current measure. Use 'Change how it's measured' to convert them together." — that flow is Stage 2c); `ZERO_PRICE` 400 from `validateChainItem(ci, { requirePositivePrice: item.isStocked })` ("A stocked item needs a price above $0."). On success: writes `dimension, baseUnit, packChain, pricing, countUnit, lastUpdated`, then `propagatePrepCostChanges([id])`, returns the item like `postUpdate` does (reuse it by exporting `postUpdate` from `[id]/route.ts` → move it to `src/lib/inventory-post-update.ts` and import from both routes).
- `validateChainItem(item, opts)`: when `opts.requirePositivePrice`, PACK `purchasePrice > 0` / RATE `rate > 0` else error string `'price must be above $0'`.

- [ ] **Step 1: Failing tests**

Append to `item-model.test.ts`:
```ts
describe('validateChainItem — requirePositivePrice', () => {
  const base: ChainItem = { dimension: 'MASS', baseUnit: 'g', packChain: [{ unit: 'case', per: 1000 }], pricing: { mode: 'PACK', purchasePrice: 0 } }
  it('is lenient by default (unchanged behaviour)', () => expect(validateChainItem(base)).toEqual([]))
  it('refuses $0 when required', () => expect(validateChainItem(base, { requirePositivePrice: true })).toContain('price must be above $0'))
  it('accepts a positive rate', () => expect(validateChainItem({ ...base, pricing: { mode: 'RATE', rate: 2, rateUnit: 'kg' } }, { requirePositivePrice: true })).toEqual([]))
})
```
`pricing-route.test.ts` (same mock scaffolding as Task 2; `inventorySupplierPrice.count` swappable): cases — box-less item + valid body → 200 and `update` called with the chain; `offers: 1` → 409 `HAS_OFFERS`; dimension change with `countLine.count → 1` → 409 `DIMENSION_LOCKED`; dimension change with all zero history and 0 offers → 200; `$0` on a stocked item → 400 `ZERO_PRICE`; `$0` on `isStocked: false` → 200; prep-linked → 409 `PREP_OWNED`; stale → 409 `STALE`.

- [ ] **Step 2: Run — fail.**

- [ ] **Step 3: Implement**

`validateChainItem`:
```ts
export function validateChainItem(item: ChainItem, opts: { requirePositivePrice?: boolean } = {}): string[] {
  …existing checks…
  if (opts.requirePositivePrice) {
    const p = item.pricing
    const price = p?.mode === 'RATE' ? Number(p.rate) : Number((p as { purchasePrice?: unknown })?.purchasePrice)
    if (!(price > 0)) errs.push('price must be above $0')
  }
  return errs
}
```
Move `postUpdate` to `src/lib/inventory-post-update.ts` (`export async function postUpdate(id, prevAllergens, newAllergensInput): Promise<NextResponse>` — identical body minus the mirror call); import it in `[id]/route.ts`.

`src/app/api/inventory/[id]/pricing/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireSession, AuthError } from '@/lib/auth'
import { DIMENSION_BASE, validateChainItem, eachMeasureOf, densityOf, type ChainItem, type Dimension } from '@/lib/item-model'
import { itemHistory, hasHistory } from '@/lib/item-history'
import { tombstonedRows, TOMBSTONE_EDIT_ERROR } from '@/lib/item-merge-rows'
import { postUpdate } from '@/lib/inventory-post-update'
import { invalidatesTheoretical } from '@/lib/theoretical-cache'

export const dynamic = 'force-dynamic'

// PATCH /api/inventory/[id]/pricing — the item's OWN measure, pack and price.
// Only for an item with no supplier box: with a box, the price lives on the box
// (edit the box; the primary box is the item's price). The measure is locked
// once the item has history — Stage 2c's guided flow converts history with it.
async function handlePATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('MANAGER') }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e }
  const body = await req.json()
  if (!body.packChain || !body.pricing || !body.expectedLastUpdated) return NextResponse.json({ error: 'Reload the item and try again.', code: 'BAD_FIELD' }, { status: 400 })
  const before = await prisma.inventoryItem.findUnique({ where: { id: params.id }, select: { id: true, mergedIntoId: true, lastUpdated: true, dimension: true, baseUnit: true, countUnit: true, isStocked: true, eachMeasureQty: true, eachMeasureUnit: true, densityGPerMl: true, allergens: true, recipe: { select: { id: true, name: true } } } })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (tombstonedRows([before]).length) return NextResponse.json({ error: TOMBSTONE_EDIT_ERROR, code: 'TOMBSTONE' }, { status: 409 })
  if (new Date(body.expectedLastUpdated).getTime() !== before.lastUpdated.getTime()) return NextResponse.json({ error: 'Someone saved this item a moment ago. Reload to see their change before saving yours.', code: 'STALE' }, { status: 409 })
  if (before.recipe) return NextResponse.json({ error: `This item's price comes from its recipe "${before.recipe.name}".`, code: 'PREP_OWNED' }, { status: 409 })
  const h = await itemHistory(params.id)
  if (h.offers > 0) return NextResponse.json({ error: "This item's price lives on its supplier box. Edit the box instead.", code: 'HAS_OFFERS' }, { status: 409 })
  const dimension = (body.dimension ?? before.dimension) as Dimension
  if (dimension !== before.dimension && hasHistory(h)) return NextResponse.json({ error: "This item already has counts, deliveries or recipes in its current measure. Use 'Change how it's measured' to convert them together.", code: 'DIMENSION_LOCKED' }, { status: 409 })
  const countUnit = body.countUnit ?? before.countUnit
  const ci: ChainItem = { dimension, baseUnit: DIMENSION_BASE[dimension], packChain: body.packChain, pricing: body.pricing, countUnit, eachMeasure: eachMeasureOf(before), densityGPerMl: densityOf(before) }
  const errors = validateChainItem(ci, { requirePositivePrice: before.isStocked })
  if (errors.length) return NextResponse.json({ error: errors.includes('price must be above $0') ? 'A stocked item needs a price above $0.' : errors.join('; '), code: errors.includes('price must be above $0') ? 'ZERO_PRICE' : 'INVALID' }, { status: 400 })
  await prisma.inventoryItem.update({ where: { id: params.id }, data: { dimension, baseUnit: ci.baseUnit, packChain: body.packChain, pricing: body.pricing, countUnit, lastUpdated: new Date() } })
  return await postUpdate(params.id, before.allergens ?? [], undefined)
}
export const PATCH = invalidatesTheoretical(handlePATCH)
```
Delete `mirrorItemToPrimaryOffer` from `primary-offer.ts` (and its header comment line about "manual item edit"); remove the call + import in the approve route (~862–870) with a one-line comment "the item was priced FROM the primary box above; nothing flows back".

- [ ] **Step 4: Tests + build; commit**

```bash
git add src/lib/item-model.ts src/lib/inventory-post-update.ts src/lib/primary-offer.ts "src/app/api/inventory/[id]/route.ts" "src/app/api/inventory/[id]/pricing/route.ts" "src/app/api/invoices/sessions/[id]/approve/route.ts" src/lib/__tests__/item-model.test.ts src/app/api/inventory/__tests__/pricing-route.test.ts
git commit -m "feat(items): the item's own price is edited only while it has no box; a stocked item cannot be \$0; the measure is locked by history; the item→box mirror is gone"
```

---

### Task 4: Dead "mark counted" route, two unguarded maintenance routes, the recipe-conflict signal (R2 server side, R7 flag)

**Files:**
- Delete: `src/app/api/inventory/count/[id]/route.ts` (keep the sibling `count/[id]/quick/route.ts`)
- Modify: `src/app/inventory/page.tsx` (delete `markCounted` and `countedFlash` if unused elsewhere)
- Modify: `src/app/api/recipes/[id]/route.ts` DELETE → `requireSession('MANAGER')` guard at the top (same shape as the inventory routes); `src/app/api/inventory/sync-prepd/route.ts` → `requireSession('MANAGER')`
- Modify: `src/lib/signals/rules.ts` — add `ruleRecipeConflict()` and register it in `evaluateAllRules`
- Test: `src/lib/__tests__/signals-recipe-conflict.test.ts` (new)

- [ ] **Step 1: Failing test** — mock `@/lib/prisma` `recipe.findMany` returning two recipes with ingredients `{ unit, inventoryItem: { itemName, baseUnit, dimension, eachMeasureQty, eachMeasureUnit } }`; one has a `g` line on a per-each item with no each-measure → one candidate `{ rule: 'RECIPE_CONFLICT', fingerprint: 'recipe-conflict:<recipeId>:<itemId>', severity: 'warn', title: '<Recipe> can't cost <Item>', body: 'It uses <Item> by weight, but the item has no "1 each = ? g". Set it on the item.', verbLabel: 'Fix item', verbHref: '/inventory?item=<itemId>', recipeId, itemId }`; the other recipe (same-dimension lines) → none.

- [ ] **Step 2: Implement the rule** using `dimensionallyCostable(ing.unit, item.baseUnit, eachMeasureOf(item))` from `@/lib/uom` / `@/lib/item-model` over `prisma.recipe.findMany({ where: { isActive: true }, select: { id, name, ingredients: { select: { unit, inventoryItem: { select: { id, itemName, baseUnit, dimension, eachMeasureQty, eachMeasureUnit } } } } } })` (check the Recipe model for the active flag name; if there is none, drop the where). Register as rule 6. Delete the dead route + page function; add the two guards.

- [ ] **Step 3: `npm test`, `npm run build`, lint; commit**

```bash
git add -A src
git commit -m "fix(items): remove the stale 'mark counted' route; guard recipe delete and prep sync; signal recipes that can no longer cost an ingredient"
```

---

### Task 5: The drawer obeys the rules (R2 stock read-only + Count now, R3 lock, R4 gate, R5 mode toggle, R6 read-only prep fields, R7 confirm, R8 reload)

**Files:**
- Modify: `src/components/inventory/InventoryItemDrawer.tsx` (`InventoryItem` type gains `hasHistory?`, `offerCount?`, `bridgeUsedBy?`, `lastUpdated?`; `EditForm` drops `stockOnHand`; `handleSave`; the edit form JSX)
- Modify: `src/components/inventory/ItemChainEditor.tsx` (`PricingEditor.setMode` carries the number)
- Test: `src/lib/__tests__/chain-editor-mode.test.ts` (pure helper `carryPricingMode(pricing, mode, dimension)` extracted from `setMode` and tested: PACK $50 → RATE $50/<first unit>; RATE $3.49/lb → PACK $3.49)

- [ ] **Step 1: Failing test for `carryPricingMode`** (extract it to `src/lib/pricing-mode.ts`, pure).
- [ ] **Step 2: Drawer edits**
  - `handleSave`: body = `{ itemName, category, storageAreaId, isActive, isStocked, allergens, barcode, countUnit, eachMeasureQty, eachMeasureUnit, densityGPerMl, expectedLastUpdated: item.lastUpdated }` to PUT; if `!item.recipe && (item.offerCount ?? 0) === 0` and the chain/pricing/dimension differ from `chainFromItem(item)`, THEN a second call `PATCH /api/inventory/${id}/pricing` with `{ dimension, packChain, pricing, countUnit, expectedLastUpdated: <lastUpdated from the PUT response> }`. On any 409: `STALE` → `alert('Someone saved this item a moment ago. Reloading…')` then `refreshItem()` and stay in edit mode with the fresh row; other codes → `alert(err.error)`.
  - Before saving, if the form clears an existing each-measure (`item.eachMeasureQty != null && editForm.eachMeasureQty == null`): call PUT with `?dryRun=1` first; if `bridgeUsedBy.length > 0`, `confirm(\`${names.join(', ')} use${n === 1 ? 's' : ''} this item by weight. Without "1 each = ? g" they will cost $0 until fixed. Remove it anyway?\`)`; cancel → stop.
  - Stock: replace the "Stock On Hand" input with a read-only line `On hand: <qty> <countUnit>` and a "Count now" button that opens `QuickCountSheet` (`setShowQuick(true)`); remove `stockOnHand` from `EditForm`/`buildEditForm`/the live preview (preview shows no stock value).
  - Pricing block: render `PricingEditor`/`DimensionToggle`/`PackChainEditor` only when `!item.recipe && (item.offerCount ?? 0) === 0`; when the item HAS boxes show instead: "Price and pack come from its supplier boxes below." (box editing is Stage 2b). `DimensionToggle` is rendered only when `!item.hasHistory`; otherwise a line "Measured in <weight|volume|each> — locked because it has counts, deliveries or recipes. (Change how it's measured: coming next.)".
  - Prep-linked item: `itemName`, allergens and count unit inputs `disabled`, and the blue banner text becomes "Made from the recipe <name>: its name, allergens, count unit and price are set there."
  - `PricingEditor.setMode` → `onChange(carryPricingMode(pricing, mode, dimension))`.
- [ ] **Step 3: `npm test`, `npm run build`, lint; commit**

```bash
git add src/components/inventory src/lib/pricing-mode.ts src/lib/__tests__/chain-editor-mode.test.ts
git commit -m "feat(inventory): the item drawer follows the edit rules — count to change stock, locked measure, price on the box, reload on a clash"
```

---

### Task 6: Smoke, PR

- [ ] **Step 1: Preview from the worktree** (temporary launch.json entry, port 3116; never commit): open Goats Cheese (has a box): Edit → no price/pack editors, "Price and pack come from its supplier boxes"; stock read-only + Count now opens the quick count; save a barcode → 200. Open a box-less item (e.g. "Croutons" or any `offerCount 0`): price editors shown, set $0 → "A stocked item needs a price above $0."; set $2 → saves. Open Brioche Unsliced in two tabs, save in one, save in the other → "Someone saved this item a moment ago…". Open a recipe-made item (Bacon Jam): name/allergens disabled. `preview_stop`, `git checkout .claude/launch.json`.
- [ ] **Step 2: Push + PR** (`feat/safe-edit-rules`; body: the 8 rules in plain words with Before/After "Before: anyone could type a new stock number in the item editor. After: stock changes only by counting"; notes: box add/edit/remove screens = Stage 2b; guided measure change = Stage 2c).

## Self-review
- **Spec coverage (§3):** R1 Task 2; R2 Tasks 4–5 (quick count exists); R3 lock Task 3 (+ drawer Task 5), guided fix deferred to 2c; R4 gate Task 3 (+ drawer), box CRUD deferred to 2b; R5 Tasks 3+5; R6 Tasks 2+5; R7 Tasks 1, 2, 4, 5; R8 Tasks 2, 3, 5. Also §3's "also": the legacy price route was deleted in 1d; recipes DELETE + sync-prepd guards Task 4.
- **Placeholders:** the R7 test body is marked "write fully" — the implementer completes it from the pattern in the same file; everything else is explicit.
- **Type consistency:** `itemHistory/hasHistory/bridgeUsedBy` (Task 1) used in Tasks 2–4; `validateChainItem(item, { requirePositivePrice })` (Task 3) used in Task 3's route; `postUpdate` moved to `src/lib/inventory-post-update.ts` and imported by both routes; `carryPricingMode` (Task 5) in `src/lib/pricing-mode.ts`; response codes as listed in Global Constraints.
