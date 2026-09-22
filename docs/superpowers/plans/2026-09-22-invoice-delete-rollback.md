# Invoice Delete Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting an approved invoice session rolls back everything its approval wrote — supplier offers, the item spine, the primary flag, learned match rules, created products, alerts and receipts — restoring each row only when nothing has changed it since.

**Architecture:** Approve captures one `InvoiceApproveUndo { prev, next }` record per row it touches (first touch wins), through canonical state selectors. Delete runs one pure `planRollback` over those records (restore `prev` iff the row still deep-equals `next`) inside one transaction per session, refuses RC clones, deletes clones with their parent, and keeps a labelled best-effort path for sessions approved before the records existed. A `delete-plan` GET runs the same planner without writing and drives the confirm dialog.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma (Supabase pgBouncer; interactive `$transaction`) · vitest · Tailwind flat tokens.

Spec: `docs/superpowers/specs/2026-09-22-invoice-delete-rollback-design.md`.

## Global Constraints

- **Capture never changes what approve writes.** Every existing write in the approve route keeps its exact data and order; the collector only reads before and after. Approve's outputs (offers, spine, alerts, receipts, rules, clones) are byte-identical to today.
- **First touch wins.** One record per `(sessionId, kind, targetId)`; `prev` is the state before the FIRST write in the run (the same offer is written by the upsert, `ensurePrimary` and `mirrorItemToPrimaryOffer`).
- **One restore rule.** Restore `prev` (delete when `prev` is null) **iff** the row's current state deep-equals `next` through the same selector; otherwise skip with `reason: 'changed-since'` (`'gone'` when the row no longer exists). Never overwrite a value the session did not write.
- Kinds are exactly `'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ITEM_CREATED'`; outcomes exactly `'restored' | 'deleted' | 'skipped' | 'best-effort'`; skip reasons exactly `'changed-since' | 'gone' | 'referenced' | 'approved before undo records existed'`. Apply order: `OFFER` (records with `prev.isPrimary === false` before those with `true`, per item), `ITEM`, `MATCH_RULE`, `ITEM_CREATED`.
- Selector fields, verbatim from the spec: `OFFER` = `lastPrice, packQty, packSize, packUOM, packChain, pricing, supplierId, supplierItemCode, isPrimary, lastInvoiceSessionId`; `ITEM` = `packChain, pricing, purchasePrice, densityGPerMl`; `MATCH_RULE` = `rawDescription, supplierName, inventoryItemId, invoicePackQty, invoicePackSize, invoicePackUOM, supplierItemCode`.
- Canonical state: Decimals → `Number`, `undefined` → `null`, keys sorted, only the fields above. `next` at approve and the delete-time read go through the same function.
- `ITEM_CREATED` is deleted only when the item has no approved scan line outside the session, no `RecipeIngredient`, no `CountLine`, and no remaining `InventorySupplierPrice`; else `skipped: 'referenced'`.
- Delete: a session with `parentSessionId` → `409 { error: 'This is an RC copy — delete the original invoice instead' }`; clones are deleted explicitly with their parent; one interactive `prisma.$transaction` per session; prep re-cost (`propagatePrepCostChanges` + `recalculateRecipeCosts`) for restored `ITEM`s runs after commit; blob deletion after that. Response `{ ok, legacy, restored, deleted, skipped: [...], recosted }`.
- Legacy path (no records on an `APPROVED` session): today's `revertedPricing` rule, extended to `ADD_SUPPLIER` lines, `outcome: 'best-effort'`; offers/rules/created items `skipped: 'approved before undo records existed'`. (The spec's "still equals the newPrice-implied value" guard is NOT implementable — `newPrice` is in the offer's denomination and `PriceAlert.newPrice` exists only for ≥ 15 % moves — so the legacy path is exactly today's rule plus `ADD_SUPPLIER`; record this in "As built".)
- UI copy, verbatim: `Restores {n} supplier price(s) and {m} item price(s) · removes {k} new product(s) · {s} price(s) stay (changed since) · {r} learned match(es) removed`; legacy: `Approved before rollback records existed — price reverts are best-effort; supplier prices and learned matches are not restored.`; clone tooltip = the 409 message.
- Role gate unchanged: MANAGER when the session has scanned lines; bulk always MANAGER. `requireSession` pattern; `AuthError` → JSON.
- Prisma singleton from `@/lib/prisma`; no `$executeRaw`; Prisma `Decimal` → `Number()`; Tailwind flat tokens; sub-components at module scope.
- vitest does NOT type-check: every task runs `npx tsc --noEmit -p tsconfig.json` (0 errors) and `npx eslint` on changed files (no NEW findings vs HEAD via `git show HEAD:path`; never `git stash`).
- Subagents never connect to the database, never apply the migration, never start a dev server, never run `npm run build`. The controller applies the migration (user OK first), runs the read-only sizing and the isolated build.
- `export PATH="$HOME/Desktop/node-install/bin:$PATH"`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Migration, selectors, collector

**Files:**
- Modify: `prisma/schema.prisma` (add model + back-relation on `InvoiceSession`)
- Create: `prisma/migrations/20260922000000_invoice_approve_undo/migration.sql`
- Create: `src/lib/invoice/approve-undo.ts`
- Test: `src/lib/__tests__/approve-undo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UndoKind = 'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ITEM_CREATED'
  export type Canon = Record<string, unknown>
  export function offerState(row: OfferRowLike): Canon
  export function itemState(row: ItemRowLike): Canon
  export function ruleState(row: RuleRowLike): Canon
  export function canonEqual(a: Canon | null, b: Canon | null): boolean
  export const OFFER_SELECT / ITEM_SELECT / RULE_SELECT   // Prisma selects matching the selectors
  export class UndoCollector {
    constructor(sessionId: string, db?: Db)
    before(kind: UndoKind, targetId: string, prev: Canon): void      // first touch wins
    created(kind: UndoKind, targetId: string): void                  // prev = null
    flush(): Promise<number>                                         // reads `next`, writes unflushed records, returns count
  }
  ```

- [ ] **Step 1: Schema + migration.** Add to `prisma/schema.prisma`:

```prisma
model InvoiceApproveUndo {
  id        String         @id @default(cuid())
  sessionId String
  session   InvoiceSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  kind      String
  targetId  String
  prev      Json?
  next      Json
  createdAt DateTime       @default(now())
  @@unique([sessionId, kind, targetId])
  @@index([kind, targetId])
}
```

and `approveUndos InvoiceApproveUndo[]` on `InvoiceSession`. Write the migration SQL by hand (the shadow DB is broken; do NOT run `prisma migrate dev`):

```sql
CREATE TABLE "InvoiceApproveUndo" (
  "id" TEXT NOT NULL, "sessionId" TEXT NOT NULL, "kind" TEXT NOT NULL, "targetId" TEXT NOT NULL,
  "prev" JSONB, "next" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceApproveUndo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InvoiceApproveUndo_sessionId_kind_targetId_key" ON "InvoiceApproveUndo"("sessionId", "kind", "targetId");
CREATE INDEX "InvoiceApproveUndo_kind_targetId_idx" ON "InvoiceApproveUndo"("kind", "targetId");
ALTER TABLE "InvoiceApproveUndo" ADD CONSTRAINT "InvoiceApproveUndo_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InvoiceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Run `npx prisma generate`. Confirm the migration SQL matches what `npx prisma migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel prisma/schema.prisma --script` prints (that command needs no database).

- [ ] **Step 2: Failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { offerState, itemState, ruleState, canonEqual, UndoCollector } from '@/lib/invoice/approve-undo'
import { Prisma } from '@prisma/client'

describe('state selectors', () => {
  it('offerState keeps only approve-written fields, numbers Decimals, nulls undefined, sorts keys', () => {
    const s = offerState({ id: 'o1', lastPrice: new Prisma.Decimal('46.40'), packQty: undefined, packSize: null, packUOM: 'each', packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 46.4 }, supplierId: 'sup', supplierItemCode: null, isPrimary: true, lastInvoiceSessionId: 's1', lastUpdated: new Date(), inventoryItemId: 'i1', supplierName: 'Sysco' } as any)
    expect(Object.keys(s)).toEqual(['isPrimary', 'lastInvoiceSessionId', 'lastPrice', 'packChain', 'packQty', 'packSize', 'packUOM', 'pricing', 'supplierId', 'supplierItemCode'])
    expect(s.lastPrice).toBe(46.4); expect(s.packQty).toBeNull()
  })
  it('itemState / ruleState field sets', () => {
    expect(Object.keys(itemState({ packChain: [], pricing: {}, purchasePrice: '1', densityGPerMl: null } as any))).toEqual(['densityGPerMl', 'packChain', 'pricing', 'purchasePrice'])
    expect(Object.keys(ruleState({ rawDescription: 'x', supplierName: 'S', inventoryItemId: 'i', invoicePackQty: '1', invoicePackSize: '2', invoicePackUOM: 'kg', supplierItemCode: null, useCount: 9, lastUsed: new Date() } as any)))
      .toEqual(['inventoryItemId', 'invoicePackQty', 'invoicePackSize', 'invoicePackUOM', 'rawDescription', 'supplierItemCode', 'supplierName'])
  })
  it('canonEqual ignores key order and Decimal-vs-number, distinguishes null from missing-as-null consistently', () => {
    const a = offerState({ lastPrice: '5', packQty: null, packSize: null, packUOM: null, packChain: [{ per: 24, unit: 'case' }], pricing: { purchasePrice: 5, mode: 'PACK' }, supplierId: null, supplierItemCode: null, isPrimary: false, lastInvoiceSessionId: null } as any)
    const b = offerState({ lastPrice: new Prisma.Decimal(5), packQty: undefined, packSize: null, packUOM: null, packChain: [{ unit: 'case', per: 24 }], pricing: { mode: 'PACK', purchasePrice: 5 }, supplierId: null, supplierItemCode: null, isPrimary: false, lastInvoiceSessionId: null } as any)
    expect(canonEqual(a, b)).toBe(true)
    expect(canonEqual(a, { ...b, lastPrice: 5.01 })).toBe(false)
    expect(canonEqual(null, null)).toBe(true); expect(canonEqual(a, null)).toBe(false)
  })
})

describe('UndoCollector', () => {
  const db = () => {
    const created: any[] = []
    const offers: Record<string, any> = { o1: { id: 'o1', lastPrice: '46.4', packQty: null, packSize: null, packUOM: null, packChain: [], pricing: {}, supplierId: null, supplierItemCode: null, isPrimary: true, lastInvoiceSessionId: 's1' } }
    return { created, db: {
      inventorySupplierPrice: { findMany: async ({ where }: any) => where.id.in.map((id: string) => offers[id]).filter(Boolean) },
      inventoryItem: { findMany: async () => [] }, invoiceMatchRule: { findMany: async () => [] },
      invoiceApproveUndo: { createMany: async ({ data }: any) => { created.push(...data); return { count: data.length } } },
    } as any }
  }
  it('first touch wins; flush reads next and writes prev+next once; a second flush writes nothing new', async () => {
    const { created, db: d } = db()
    const c = new UndoCollector('s1', d)
    c.before('OFFER', 'o1', { lastPrice: 40 } as any)
    c.before('OFFER', 'o1', { lastPrice: 41 } as any)   // ignored
    expect(await c.flush()).toBe(1)
    expect(created[0]).toMatchObject({ sessionId: 's1', kind: 'OFFER', targetId: 'o1', prev: { lastPrice: 40 } })
    expect(created[0].next.lastPrice).toBe(46.4)
    expect(await c.flush()).toBe(0)
  })
  it('created() records prev = null', async () => {
    const { created, db: d } = db()
    const c = new UndoCollector('s1', d); c.created('OFFER', 'o1'); await c.flush()
    expect(created[0].prev).toBeNull()
  })
})
```

- [ ] **Step 3: Implement** `src/lib/invoice/approve-undo.ts`:

```ts
// Undo records for an invoice approval. Approve captures, per row it touches,
// the state BEFORE its first write (`prev`) and AFTER its last (`next`) through
// ONE canonical selector per kind; DELETE restores `prev` only while the row
// still equals `next`. Pure except UndoCollector.flush (Prisma writes).
import { prisma } from '@/lib/prisma'
import type { Prisma as P } from '@prisma/client'

export type UndoKind = 'OFFER' | 'ITEM' | 'MATCH_RULE' | 'ITEM_CREATED'
export type Canon = Record<string, unknown>
type Db = P.TransactionClient | typeof prisma

const OFFER_FIELDS = ['lastPrice', 'packQty', 'packSize', 'packUOM', 'packChain', 'pricing', 'supplierId', 'supplierItemCode', 'isPrimary', 'lastInvoiceSessionId'] as const
const ITEM_FIELDS  = ['packChain', 'pricing', 'purchasePrice', 'densityGPerMl'] as const
const RULE_FIELDS  = ['rawDescription', 'supplierName', 'inventoryItemId', 'invoicePackQty', 'invoicePackSize', 'invoicePackUOM', 'supplierItemCode'] as const
const DECIMAL_FIELDS = new Set(['lastPrice', 'packQty', 'packSize', 'purchasePrice', 'densityGPerMl', 'invoicePackQty', 'invoicePackSize'])

export const OFFER_SELECT = Object.fromEntries(OFFER_FIELDS.map(f => [f, true])) as Record<typeof OFFER_FIELDS[number], true>
export const ITEM_SELECT  = Object.fromEntries(ITEM_FIELDS.map(f => [f, true]))  as Record<typeof ITEM_FIELDS[number], true>
export const RULE_SELECT  = Object.fromEntries(RULE_FIELDS.map(f => [f, true]))  as Record<typeof RULE_FIELDS[number], true>

/** Plain, sorted, Decimal-free: the same input always canonicalises identically. */
function canon(row: Record<string, unknown>, fields: readonly string[]): Canon {
  const out: Canon = {}
  for (const f of [...fields].sort()) {
    const v = row[f]
    if (v === undefined || v === null) out[f] = null
    else if (DECIMAL_FIELDS.has(f)) out[f] = Number(v)
    else out[f] = JSON.parse(JSON.stringify(v)) // Json columns: strip Prisma wrappers, keep structure
  }
  return out
}
export const offerState = (row: Record<string, unknown>) => canon(row, OFFER_FIELDS)
export const itemState  = (row: Record<string, unknown>) => canon(row, ITEM_FIELDS)
export const ruleState  = (row: Record<string, unknown>) => canon(row, RULE_FIELDS)

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
export function canonEqual(a: Canon | null, b: Canon | null): boolean {
  if (a === null || b === null) return a === b
  return stable(a) === stable(b)
}

type Entry = { kind: UndoKind; targetId: string; prev: Canon | null; flushed: boolean }

export class UndoCollector {
  private entries = new Map<string, Entry>()
  constructor(private sessionId: string, private db: Db = prisma) {}
  /** Call BEFORE the first write to a target. Later calls for the same target are ignored. */
  before(kind: UndoKind, targetId: string, prev: Canon) {
    const k = `${kind}|${targetId}`
    if (!this.entries.has(k)) this.entries.set(k, { kind, targetId, prev, flushed: false })
  }
  /** A row this approval created (its id is known only after the create). */
  created(kind: UndoKind, targetId: string) {
    const k = `${kind}|${targetId}`
    if (!this.entries.has(k)) this.entries.set(k, { kind, targetId, prev: null, flushed: false })
  }
  /** Read `next` for every unflushed entry through its selector and write the records. */
  async flush(): Promise<number> {
    const pending = [...this.entries.values()].filter(e => !e.flushed)
    if (pending.length === 0) return 0
    const ids = (kinds: UndoKind[]) => pending.filter(e => kinds.includes(e.kind)).map(e => e.targetId)
    const [offers, items, rules] = await Promise.all([
      ids(['OFFER']).length ? this.db.inventorySupplierPrice.findMany({ where: { id: { in: ids(['OFFER']) } }, select: { id: true, ...OFFER_SELECT } }) : [],
      ids(['ITEM', 'ITEM_CREATED']).length ? this.db.inventoryItem.findMany({ where: { id: { in: ids(['ITEM', 'ITEM_CREATED']) } }, select: { id: true, ...ITEM_SELECT } }) : [],
      ids(['MATCH_RULE']).length ? this.db.invoiceMatchRule.findMany({ where: { id: { in: ids(['MATCH_RULE']) } }, select: { id: true, ...RULE_SELECT } }) : [],
    ])
    const nextOf = (e: Entry): Canon | null => {
      if (e.kind === 'OFFER') { const r = offers.find(o => o.id === e.targetId); return r ? offerState(r) : null }
      if (e.kind === 'MATCH_RULE') { const r = rules.find(o => o.id === e.targetId); return r ? ruleState(r) : null }
      const r = items.find(o => o.id === e.targetId); return r ? itemState(r) : null
    }
    const data = pending.flatMap(e => { const next = nextOf(e); return next ? [{ sessionId: this.sessionId, kind: e.kind, targetId: e.targetId, prev: e.prev as P.InputJsonValue | undefined ?? undefined, next: next as P.InputJsonValue }] : [] })
    // Prisma: a nullable Json column takes Prisma.JsonNull for SQL NULL.
    for (const d of data) if (d.prev === undefined) (d as Record<string, unknown>).prev = P.JsonNull
    if (data.length) await this.db.invoiceApproveUndo.createMany({ data, skipDuplicates: true })
    pending.forEach(e => { e.flushed = true })
    return data.length
  }
}
```

Adjust the `Prisma.JsonNull` import/usage to what the generated client exposes (`import { Prisma } from '@prisma/client'` for the value); keep the test's mock DB shape in sync.

- [ ] **Step 4: Run** the test → PASS; `tsc` → 0; eslint.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260922000000_invoice_approve_undo src/lib/invoice/approve-undo.ts src/lib/__tests__/approve-undo.test.ts
git commit -m "feat(invoices): undo records for an approval — canonical state selectors and a first-touch-wins collector"
```

---

### Task 2: Approve captures

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (~:655 offer upsert, ~:701 `ensurePrimary`, ~:733-770 spine write, ~:784 mirror, ~:832 `CREATE_NEW`, ~:932-950 prior-clone cleanup, ~:1062-1081 match rules)
- Modify: `src/lib/primary-offer.ts` (`ensurePrimary`, `mirrorItemToPrimaryOffer` — optional `undo?: UndoCollector`)
- Modify: `src/lib/invoice-matcher.ts` (`saveMatchRule` — optional `undo?: UndoCollector`)
- Test: `src/lib/__tests__/approve-undo.test.ts` (append: `saveMatchRule` + `ensurePrimary` capture via a mock db)

**Interfaces:**
- Consumes Task 1.
- Produces: `saveMatchRule(rawDescription, itemId, supplierName, format?, code?, undo?)`, `ensurePrimary(itemId, db?, undo?)`, `mirrorItemToPrimaryOffer(itemId, db?, undo?)` — all additive optional params.

- [ ] **Step 1: Failing tests** (append):

```ts
describe('capture hooks', () => {
  it('ensurePrimary touches every offer of the item BEFORE clearing/promoting', async () => {
    const touched: string[] = []
    const undo = { before: (k: string, id: string) => touched.push(`${k}:${id}`), created: () => {}, flush: async () => 0 } as any
    const db = { inventorySupplierPrice: {
      findMany: async () => [{ id: 'a', isPrimary: false, ...OFFER_ROW }, { id: 'b', isPrimary: false, ...OFFER_ROW }],
      updateMany: async () => ({ count: 2 }), update: async () => ({}),
    } } as any
    const { ensurePrimary } = await import('@/lib/primary-offer')
    await ensurePrimary('item', db, undo)
    expect(touched.sort()).toEqual(['OFFER:a', 'OFFER:b'])
  })
  it('saveMatchRule touches the sibling rules it strips a code from and the rule it upserts; a new rule is created()', async () => { /* mock findMany (siblings) + findUnique (existing rule) + upsert → assert before()/created() calls */ })
})
```

Write the second test fully with a mock db whose `invoiceMatchRule.findMany` returns one sibling `{ id: 'r9', … }`, `findUnique` returns null, and `upsert` returns `{ id: 'r-new' }`; assert `before('MATCH_RULE','r9',…)` and `created('MATCH_RULE','r-new')`.

- [ ] **Step 2: Implement hooks.**

`primary-offer.ts`: `ensurePrimary(itemId, db = prisma, undo?: UndoCollector)` — change the `findMany` select to `{ id: true, ...OFFER_SELECT }` and, only when it is about to write (none or > 1 primary), `offers.forEach(o => undo?.before('OFFER', o.id, offerState(o)))` before the `updateMany`. `mirrorItemToPrimaryOffer(itemId, db = prisma, undo?)` — select `{ id: true, ...OFFER_SELECT }` for `primary` and `undo?.before('OFFER', primary.id, offerState(primary))` before the `update`.

`invoice-matcher.ts` `saveMatchRule(..., undo?: UndoCollector)`: before the sibling `updateMany`, `findMany` the same `where` with `{ id: true, ...RULE_SELECT }` and `before('MATCH_RULE', r.id, ruleState(r))` each; before the `upsert`, `findUnique` by `rawDescription_supplierName` with `{ id: true, ...RULE_SELECT }` → `before(...)` if found; after the upsert (make it return the row: `const row = await prisma.invoiceMatchRule.upsert({ …, select: { id: true } })`) → `if (!existing) undo?.created('MATCH_RULE', row.id)`.

Approve route:
1. `const undo = new UndoCollector(sessionId)` after the session is claimed (`REVIEW → APPROVING`); right there, `await prisma.invoiceApproveUndo.deleteMany({ where: { sessionId } })` (next to the prior-clone cleanup — put it in the same idempotency block).
2. Before the offer upsert (:655): `const existingOffer = await prisma.inventorySupplierPrice.findUnique({ where: { inventoryItemId_supplierName: {…} }, select: { id: true, ...OFFER_SELECT } })`; `if (existingOffer) undo.before('OFFER', existingOffer.id, offerState(existingOffer))`; make the upsert `select: { id: true }` and `if (!existingOffer) undo.created('OFFER', upserted.id)`.
3. `ensurePrimary(scanItem.matchedItemId, prisma, undo)`.
4. Before `prisma.$transaction(itemOps)` when `shouldReprice`: the item's pre-write state — the route already holds `item` (from `matchedItem` with `PRICING_SELECT`); add `purchasePrice: true, densityGPerMl: true` to that select if missing and `undo.before('ITEM', item.id, itemState(item))`.
5. `mirrorItemToPrimaryOffer(scanItem.matchedItemId, prisma, undo)`.
6. After the mirror (end of the line's writes): `await undo.flush()`.
7. `CREATE_NEW`: after `created`, `undo.created('ITEM_CREATED', created.id)`; `await undo.flush()`.
8. Match rules: pass `undo` to every `saveMatchRule` call; after the `Promise.all`, `await undo.flush()`.

Deviation to record: approve's per-line writes are not in one transaction today (offer upsert, `ensurePrimary`, `$transaction(itemOps)`, mirror are separate statements), so the records are written right after the line's last write rather than "inside the same transaction" — same failure envelope approve already has.

- [ ] **Step 3: Verify.** Tests, `tsc`, eslint, `npm test`. In the report: the exact list of write sites hooked (file:line) and confirmation that no `data:` payload of any existing write changed.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/invoices/sessions/[id]/approve/route.ts" src/lib/primary-offer.ts src/lib/invoice-matcher.ts src/lib/__tests__/approve-undo.test.ts
git commit -m "feat(invoices): approve records what it writes — offers, spine, primary flag, match rules, created items"
```

---

### Task 3: The rollback planner and executor

**Files:**
- Create: `src/lib/invoice/rollback.ts`
- Test: `src/lib/__tests__/rollback.test.ts`

**Interfaces:**
- Consumes: Task 1 selectors, `canonEqual`; `revertedPricing`/`priorPpbFromAlerts` from `src/lib/invoice/revert-pricing.ts` for the legacy path.
- Produces:
  ```ts
  export type Outcome = 'restored' | 'deleted' | 'skipped' | 'best-effort'
  export type SkipReason = 'changed-since' | 'gone' | 'referenced' | 'approved before undo records existed'
  export interface PlanRow { kind: UndoKind; targetId: string; name: string; outcome: Outcome; reason?: SkipReason; write?: { table: 'offer' | 'item' | 'rule'; op: 'update' | 'delete'; data?: Canon } }
  export interface RollbackPlan { legacy: boolean; rows: PlanRow[]; restoredItemIds: string[]; summary: { restored: number; deleted: number; skipped: number; bestEffort: number } }
  export function planRollback(a: {
    records: Array<{ kind: UndoKind; targetId: string; prev: Canon | null; next: Canon }>
    current: { offers: Map<string, Canon & { inventoryItemId: string; supplierName: string }>; items: Map<string, Canon & { itemName: string }>; rules: Map<string, Canon> }
    refs: Map<string, { approvedLinesElsewhere: number; recipeIngredients: number; countLines: number; offers: number }>  // for ITEM_CREATED
    legacy: { status: string; lines: Array<{ matchedItemId: string | null; previousPrice: number | null; action: string; matchedItem: ChainItemRow | null }>; priceAlerts: Array<{ inventoryItemId: string; previousPrice: unknown }> } | null
  }): RollbackPlan
  export async function executeRollback(tx: Db, plan: RollbackPlan): Promise<void>
  ```

- [ ] **Step 1: Failing tests** — cover: unchanged → `restored` with `write.data = prev`; changed-since → `skipped`; `prev = null` → `deleted`; target gone → `skipped 'gone'`; `ITEM_CREATED` referenced → `skipped 'referenced'`, unreferenced → `deleted`; ordering — `OFFER` rows with `prev.isPrimary === false` come before `true` for the same item, and kinds in order `OFFER, ITEM, MATCH_RULE, ITEM_CREATED`; `restoredItemIds` lists restored `ITEM` targets; legacy (`records: []`, `legacy.status === 'APPROVED'`) → `best-effort` rows for `UPDATE_PRICE` AND `ADD_SUPPLIER` lines with `previousPrice`, using `revertedPricing`; the **Cilantro shape**: record `{ kind: 'ITEM', prev: { pricing: { mode: 'PACK', purchasePrice: 4.99 }, purchasePrice: 4.99, packChain: […], densityGPerMl: null }, next: { pricing: { mode: 'RATE', rate: 15.98, rateUnit: 'lb' }, purchasePrice: 15.98, … } }` with current === next → `write.data.pricing` equals the PACK object exactly.

- [ ] **Step 2: Implement.** `planRollback` is pure and deterministic; `executeRollback(tx, plan)` applies `plan.rows` in order: `write.op === 'update'` → `tx.<table>.update({ where: { id }, data })` (Json fields cast; Decimals as numbers); `'delete'` → `tx.<table>.delete({ where: { id } })`. For `OFFER` updates, restore `isPrimary` as part of `data` (ordering already guarantees the partial unique index holds). The legacy rows write `{ purchasePrice, pricing }` from `revertedPricing` exactly as the routes do today.

- [ ] **Step 3: Verify + commit**

```bash
git add src/lib/invoice/rollback.ts src/lib/__tests__/rollback.test.ts
git commit -m "feat(invoices): the rollback planner — restore a row only while it still equals what the approval wrote"
```

---

### Task 4: The routes

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/route.ts` (DELETE ~:220-296)
- Modify: `src/app/api/invoices/sessions/route.ts` (bulk DELETE ~:49-123)
- Create: `src/app/api/invoices/sessions/[id]/delete-plan/route.ts` (GET; `export const dynamic = 'force-dynamic'`)
- Create: `src/lib/invoice/rollback-load.ts` — `loadRollbackInputs(db, sessionId)` gathers `records`, `current`, `refs`, `legacy` for the planner (used by all three routes)

**Interfaces:**
- Consumes Task 3.
- Produces: `DELETE` response `{ ok, legacy, restored, deleted, skipped: PlanRow[], recosted, blobsDeleted, blobsFailed }`; bulk `{ ok, sessions: Array<{ id, ...same }> , refused: Array<{ id, error }> }`; `GET …/delete-plan` → `{ legacy, rows: PlanRow[], summary, isClone: boolean }`.

- [ ] **Step 1: `loadRollbackInputs`.** Select the session `{ id, status, parentSessionId, files, priceAlerts, approveUndos, scanItems (approved, action in UPDATE_PRICE/ADD_SUPPLIER, with matchedItem PRICING_SELECT), _count.scanItems }`; from the records, one `findMany` each for offers (`{ id, inventoryItemId, supplierName, ...OFFER_SELECT }`), items (`{ id, itemName, ...ITEM_SELECT }`), rules (`{ id, ...RULE_SELECT }`); for each `ITEM_CREATED` target, the four reference counts (`invoiceScanItem.count` where `matchedItemId`, `approved`, `sessionId != sessionId`; `recipeIngredient.count`; `countLine.count`; `inventorySupplierPrice.count` where `inventoryItemId` and `id NOT IN` the session's created-offer targets). Build the planner input.

- [ ] **Step 2: Shared `deleteSession(db, sessionId, user)`** in `rollback-load.ts` (or a sibling `rollback-run.ts`): (a) load; 404 if missing; (b) `parentSessionId` → throw a typed `RollbackRefused(409, 'This is an RC copy — delete the original invoice instead')`; (c) role gate as today; (d) `plan = planRollback(inputs)`; (e) `await prisma.$transaction(async tx => { await executeRollback(tx, plan); await tx.invoiceSession.deleteMany({ where: { parentSessionId: id } }); await tx.invoiceSession.delete({ where: { id } }) })`; (f) after commit: `if (plan.restoredItemIds.length) { const moved = await propagatePrepCostChanges(ids); await recalculateRecipeCosts([...new Set([...ids, ...moved])], null /* no session to attach alerts to — check the signature; pass what the function needs to skip alert creation or create none */, priorPpbByItem) }` — read `src/lib/recipe-costs.ts` to see how `sessionId` is used and adapt (if it requires a session for `RecipeAlert`, pass `undefined` and skip alerts: the invoice that caused them is gone); (g) `deleteFileBlobs(files)`; return the response.

- [ ] **Step 3: Routes.** Single DELETE → `deleteSession`; bulk DELETE loops ids sequentially, catching `RollbackRefused` per id into `refused`; `delete-plan` GET → load + plan only (`requireSession()`; MANAGER not required to *preview*).

- [ ] **Step 4: Verify.** `tsc`, eslint, `npm test`. Confirm in `npm run build`-style terms that `delete-plan/route.ts` exports `dynamic = 'force-dynamic'`. In the report: the three exact HTTP checks the controller runs against a dev server (`GET /api/invoices/sessions/<legacy id>/delete-plan` → `legacy: true`; a clone id → `isClone: true`; `DELETE` on a clone → 409).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/invoices/sessions src/lib/invoice/rollback-load.ts
git commit -m "feat(invoices): deleting an approved invoice rolls back what its approval wrote, in one transaction, with a preview"
```

---

### Task 5: The confirm dialog

**Files:**
- Modify: `src/components/invoices/InvoiceListV2.tsx` (`handleDelete` ~:195, the delete `ConfirmModal` ~:469-480, bulk ~:488-500, the row action ~:366-371)

- [ ] **Step 1.** When the delete confirm opens for an `APPROVED` session, fetch `GET /api/invoices/sessions/${id}/delete-plan` (show `Checking what this will change…` while loading) and render the plan summary as the body, verbatim copy from Global Constraints: counts from `summary` and the rows (`Restores {n} supplier price(s) and {m} item price(s) · removes {k} new product(s) · {s} price(s) stay (changed since) · {r} learned match(es) removed`); when `legacy`, the legacy sentence instead; non-approved sessions keep today's copy. Bulk: fetch each selected approved session's plan and show per-session totals (one line each).

- [ ] **Step 2.** Row action for a session with `parentSessionId` (the list already tags "Copy"): render Delete disabled with `title` = the 409 message; if the API still returns 409 (race), surface `error` in the modal.

- [ ] **Step 3.** Types: a small `DeletePlan` interface in the component file mirroring the GET response. Module-scope sub-components, flat tokens.

- [ ] **Step 4.** `tsc`, eslint, `npm test`. Report a 4-step click-through (legacy approved session → legacy sentence; a session approved after deploy → counts; a Copy row → disabled Delete; bulk with two sessions).

- [ ] **Step 5: Commit**

```bash
git add src/components/invoices/InvoiceListV2.tsx
git commit -m "feat(invoices): the delete dialog shows exactly what will be restored, and refuses an RC copy"
```

---

### Task 6: Sizing, docs, build

**Files:**
- Create: `docs/audits/2026-09-22-invoice-delete-rollback/rollback-sizing.ts` (read-only; controller runs it)
- Modify: `CLAUDE.md` ("Invoice processing" step 5 + a new bullet), the spec (`Status`, "As built")

- [ ] **Step 1: Sizing script** — counts: `APPROVED` sessions (all legacy), sessions with `parentSessionId` (clones), approved sessions with ≥ 1 `ADD_SUPPLIER` line (never reverted until now), and offers whose `lastInvoiceSessionId` points at a session that no longer exists (evidence of past un-rolled-back deletes). Prints a table; writes `rollback-sizing-<stamp>.json`. Follow sibling audit scripts' import style.

- [ ] **Step 2: CLAUDE.md.** After the invoice-processing step 5 paragraph, add:

```markdown
6. `DELETE /api/invoices/sessions/[id]` (and the bulk route) **rolls back what the approval wrote**: approve records one `InvoiceApproveUndo { prev, next }` per row it touches (offer, item spine, primary flag, learned match rule, created item — `src/lib/invoice/approve-undo.ts`, first touch wins), and delete restores `prev` only while the row still deep-equals `next` through the same canonical selector (`planRollback` in `src/lib/invoice/rollback.ts`) — so a value a later invoice or a manual edit changed is left alone (`skipped: 'changed-since'`). One transaction per session; RC copies refuse delete (409) and are deleted with their parent; restored items are re-costed after commit; `GET …/delete-plan` previews the plan for the confirm dialog. Sessions approved before 2026-09-22 have no records and get the labelled best-effort `revertedPricing` path (now covering `ADD_SUPPLIER` lines too). Never revert from `InvoiceScanItem.previousPrice` for a recorded session.
```

- [ ] **Step 3: Spec** → `Status: implemented`; "As built" with deviations (records written after the line's last write, not inside a per-line transaction; the legacy-path guard not implementable; anything the reviews changed) and a placeholder line `_Sizing: (controller fills in after the read-only run)_`.

- [ ] **Step 4 (controller):** apply the migration to the live DB **after the user's OK** (diff/db-execute path over the session pooler, then `migrate resolve --applied`); run the sizing (read-only); isolated `npm run build` (sandbox off for Google Fonts); fill the sizing line.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-22-invoice-delete-rollback-design.md docs/audits/2026-09-22-invoice-delete-rollback
git commit -m "docs: deleting an approved invoice rolls back what its approval wrote"
```

---

## Self-Review Notes

- **Spec coverage:** §1 table/selectors/collector/first-touch → Task 1 · capture sites incl. `ensurePrimary`, mirror, `saveMatchRule` siblings, `CREATE_NEW`, old-record cleanup → Task 2 · restore rule, ordering, `ITEM_CREATED` references, legacy path → Task 3 · transaction, clone refusal + cascade, re-cost after commit, preview GET, bulk → Task 4 · dialog copy + disabled clone delete → Task 5 · sizing, docs, migration, post-deploy cycle → Task 6.
- **Deviations recorded in the plan itself:** records flushed after the line's writes (approve is not transactional per line); the legacy "newPrice-implied" guard dropped (not derivable) — both go into "As built".
- **Type consistency:** `UndoKind`, `Canon`, selectors and `OFFER_SELECT`/`ITEM_SELECT`/`RULE_SELECT` defined once (Task 1) and used by Tasks 2–4; `PlanRow`/`RollbackPlan` (Task 3) are the response shapes of Task 4 and the `DeletePlan` type of Task 5; `deleteSession` returns exactly the documented response.
- **Open question for the implementer of Task 4:** `recalculateRecipeCosts(ids, sessionId, priorPpb)` attaches `RecipeAlert`s to a session — the deleted session cannot own them; read the function and either pass a value that suppresses alert creation or skip alerts entirely (state which in the report).
