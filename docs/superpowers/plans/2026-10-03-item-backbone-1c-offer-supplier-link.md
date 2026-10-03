# Item backbone — Stage 1c: every supplier box is linked to its supplier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `InventorySupplierPrice.supplierId` becomes required (NOT NULL, FK RESTRICT) and the one-offer-per-supplier-product rule is keyed on the supplier's id instead of a free-text name; every reader and writer of offers joins on the id. `supplierName` stays as display provenance only.

**Architecture:** Three moves, in order, each safe on its own: (1) a read-only audit + a dry-run-by-default backfill script fix the single unlinked offer and the one mismatched name on the live database; (2) a hand-authored migration (applied with the project's `scripts/apply-migration.cjs`) makes the column NOT NULL, swaps the unique index to `(inventoryItemId, supplierId, COALESCE(supplierItemCode,''))` and re-creates the FK as RESTRICT; (3) code stops keying on `supplierName` — approve writes an offer only when the session has a linked supplier, the matcher and item merge key on `supplierId`, and deleting a supplier that still has boxes is refused. Nothing changes a price.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma (pgBouncer transaction pooler — raw SQL via `$executeRawUnsafe` only), vitest, `npm run build`.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §2.3 (last row of the table: `InventorySupplierPrice.supplierName` as a key → `supplierId` NOT NULL). Stages 1a (#154) and 1b (#155) are merged.

## Global Constraints

- Branch off `origin/main` (= `d5742af`). Worktree `.claude/worktrees/offer-supplier-link`, branch `worktree-offer-supplier-link`, pushed as `feat/offer-supplier-link`. One PR, squash-merged.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `node_modules` and `.env` are symlinks in the worktree; `.env` is the LIVE database.
- **Live-data order is fixed:** audit (read-only) → backfill `--apply` (writes exactly the rows the dry run listed, with a backup JSON) → migration. The migration must never run against a table that still has a NULL `supplierId`.
- Live facts on 2026-10-03 (from the read-only stats): 266 offers; **1** with `supplierId` null (`Yellow potato`, supplierName "Independent (Hector's YIG Garibaldi Highlands)" → resolves to supplier "Your Independent Grocer" through its alias); **1** whose `supplierName` ("Sysco Canada, Inc.") differs from its supplier's name ("Sysco"); **0** duplicates on `(inventoryItemId, supplierId, COALESCE(supplierItemCode,''))`; **1** APPROVED invoice session with `supplierId` null (same YIG name). If the audit prints different numbers, stop and report before the backfill.
- Migrations are hand-authored, plain statements, no embedded semicolons, applied over the pooler with `node scripts/apply-migration.cjs prisma/migrations/<dir>` (records `_prisma_migrations`). Never `prisma migrate dev`. Grep every migration for `DROP TABLE|DELETE|TRUNCATE` before applying — none may appear.
- Prisma implies `ON DELETE RESTRICT` for a required relation; the migration must recreate the FK with that rule (a hand-trimmed NOT NULL without it is the drift pattern recorded in `project_prisma_migrate_shadow_broken`).
- No price, chain or pricing value changes anywhere. `supplierName` is never deleted — it is display/provenance.
- Prisma `Decimal` values arrive as strings — `Number()` before arithmetic.
- `src/lib/invoice/line-format.ts` is client-safe (no Prisma import) and its `OfferFormat`/`SupplierRef` types keep `supplierId?: string | null` (the review UI passes partial rows).

---

### Task 1: `coverageScore` becomes an export, and a read-only audit of supplier links

**Files:**
- Modify: `src/lib/supplier-matcher.ts` (export the existing `coverageScore` function; no behaviour change)
- Create: `scripts/audit-offer-supplier-links.ts`
- Test: `src/lib/__tests__/supplier-matcher.test.ts`

**Interfaces:**
- Produces: `export function coverageScore(a: string, b: string): number` (0–1 token coverage of the shorter name in the longer, business suffixes stripped) — Task 2 uses it to propose a supplier without the auto-learn side effect of `matchSupplierByName`.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/supplier-matcher.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
import { coverageScore } from '@/lib/supplier-matcher'

describe('coverageScore — token coverage of the shorter name in the longer', () => {
  it('ignores business suffixes and case: "SYSCO" vs "Sysco Foods Inc" → 1', () => {
    expect(coverageScore('SYSCO', 'Sysco Foods Inc')).toBe(1)
  })
  it("the live orphan: \"Independent (Hector's YIG Garibaldi Highlands)\" vs the YIG alias → ≥ 0.5", () => {
    expect(coverageScore("Independent (Hector's YIG Garibaldi Highlands)", "Independent (Your Independent Grocer) — Hector's VIG Garibaldi Highlands")).toBeGreaterThanOrEqual(0.5)
  })
  it('unrelated names → 0', () => {
    expect(coverageScore('Premium Meats', 'Quality Produce')).toBe(0)
  })
})
```

- [ ] **Step 2: Run it — fails because `coverageScore` is not exported**

Run: `npx vitest run src/lib/__tests__/supplier-matcher.test.ts`
Expected: FAIL (`coverageScore` is not a function / not exported).

- [ ] **Step 3: Export it**

In `src/lib/supplier-matcher.ts` change `function coverageScore(` to `export function coverageScore(`. Nothing else.

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/__tests__/supplier-matcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the audit script (read-only)**

`scripts/audit-offer-supplier-links.ts`:
```ts
// READ-ONLY. The pre-flight for making InventorySupplierPrice.supplierId required.
// Prints: offers with no supplier link and the supplier each would resolve to;
// offers whose stored supplierName differs from the linked supplier's name;
// duplicates that would collide under the new (item, supplierId, SKU) key;
// APPROVED invoice sessions with no supplier link; and the current FK rule.
//
// Run: TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-offer-supplier-links.ts
import { prisma } from '../src/lib/prisma'
import { coverageScore } from '../src/lib/supplier-matcher'

/** Exact alias/name match (case-blind), else the best fuzzy ≥ 0.5 — WITHOUT learning an alias. */
export async function proposeSupplier(name: string): Promise<{ id: string; name: string; how: 'exact' | 'fuzzy'; score: number } | null> {
  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true, aliases: { select: { name: true } } } })
  const n = name.trim().toLowerCase()
  for (const s of suppliers) {
    if (s.name.toLowerCase() === n || s.aliases.some(a => a.name.toLowerCase() === n)) return { id: s.id, name: s.name, how: 'exact', score: 1 }
  }
  let best: { id: string; name: string; how: 'fuzzy'; score: number } | null = null
  for (const s of suppliers) {
    for (const cand of [s.name, ...s.aliases.map(a => a.name)]) {
      const score = coverageScore(name, cand)
      if (score >= 0.5 && (!best || score > best.score)) best = { id: s.id, name: s.name, how: 'fuzzy', score }
    }
  }
  return best
}

async function main() {
  const orphans = await prisma.inventorySupplierPrice.findMany({
    where: { supplierId: null },
    select: { id: true, supplierName: true, isPrimary: true, inventoryItem: { select: { itemName: true } } },
  })
  console.log(`Offers with no supplier link: ${orphans.length}`)
  for (const o of orphans) {
    const p = await proposeSupplier(o.supplierName)
    console.log(`  ${o.id}  ${o.inventoryItem.itemName.padEnd(30)} "${o.supplierName}" → ${p ? `${p.name} (${p.how}${p.how === 'fuzzy' ? ` ${p.score.toFixed(2)}` : ''})` : 'UNRESOLVED'}`)
  }

  const mismatched = await prisma.inventorySupplierPrice.findMany({
    where: { supplierId: { not: null } },
    select: { id: true, supplierName: true, supplier: { select: { name: true } }, inventoryItem: { select: { itemName: true } } },
  })
  const bad = mismatched.filter(o => o.supplier && o.supplierName !== o.supplier.name)
  console.log(`Offers whose supplierName differs from the linked supplier: ${bad.length}`)
  for (const o of bad) console.log(`  ${o.id}  ${o.inventoryItem.itemName.padEnd(30)} "${o.supplierName}" → "${o.supplier!.name}"`)

  const dups = await prisma.$queryRawUnsafe<{ inventoryItemId: string; supplierId: string; code: string; n: number }[]>(
    `SELECT "inventoryItemId", "supplierId", COALESCE("supplierItemCode", '') AS code, COUNT(*)::int AS n
       FROM "InventorySupplierPrice" WHERE "supplierId" IS NOT NULL
      GROUP BY 1, 2, 3 HAVING COUNT(*) > 1`)
  console.log(`Duplicates under (item, supplierId, SKU): ${dups.length}`)
  for (const d of dups) console.log(`  item ${d.inventoryItemId} supplier ${d.supplierId} sku "${d.code}" × ${d.n}`)

  const sessions = await prisma.invoiceSession.findMany({
    where: { supplierId: null, status: 'APPROVED' },
    select: { id: true, supplierName: true, invoiceNumber: true },
  })
  console.log(`APPROVED sessions with no supplier link: ${sessions.length}`)
  for (const s of sessions) {
    const p = s.supplierName ? await proposeSupplier(s.supplierName) : null
    console.log(`  ${s.id}  #${s.invoiceNumber ?? '—'} "${s.supplierName}" → ${p ? `${p.name} (${p.how})` : 'UNRESOLVED'}`)
  }

  const fk = await prisma.$queryRawUnsafe<{ conname: string; confdeltype: string }[]>(
    `SELECT c.conname, c.confdeltype FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'InventorySupplierPrice' AND c.contype = 'f'
        AND pg_get_constraintdef(c.oid) LIKE '%"supplierId"%'`)
  console.log(`FK on supplierId: ${fk.map(f => `${f.conname} (on delete ${f.confdeltype === 'r' ? 'RESTRICT' : f.confdeltype === 'n' ? 'SET NULL' : f.confdeltype === 'a' ? 'NO ACTION' : f.confdeltype})`).join(', ') || 'NONE'}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 6: Run it against the live database**

Run: `TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-offer-supplier-links.ts` (or `npx tsx …`)
Expected (2026-10-03): `Offers with no supplier link: 1` resolving to `Your Independent Grocer (fuzzy …)`; `… differs …: 1` (Sysco Canada, Inc. → Sysco); `Duplicates …: 0`; `APPROVED sessions …: 1`; one `FK on supplierId:` line naming the constraint and its delete rule. **Record the FK constraint name and rule — Task 3's migration uses the name.** If any count differs from the Global Constraints, stop and report.

- [ ] **Step 7: Commit**

```bash
git add src/lib/supplier-matcher.ts src/lib/__tests__/supplier-matcher.test.ts scripts/audit-offer-supplier-links.ts
git commit -m "chore(offers): read-only audit of supplier links; coverageScore exported"
```

---

### Task 2: Backfill script — dry run by default, `--apply` writes exactly what it listed

**Files:**
- Create: `scripts/backfill-offer-supplier-fk.ts`

**Interfaces:**
- Consumes: `proposeSupplier` — move it out of the audit script into `src/lib/supplier-propose.ts` (server-only, `export async function proposeSupplier(name)`) and import it from both scripts.
- Produces: on `--apply`, every offer with `supplierId` null gets the proposed id; every offer whose `supplierName` differs from its supplier's name gets `supplierName = Supplier.name`; every APPROVED session with `supplierId` null and a resolvable name gets the id. Backup JSON `offer-supplier-fk-backup-<ISO>.json` at the repo root (same pattern as the other repair backups, untracked).

- [ ] **Step 1: Move `proposeSupplier` to `src/lib/supplier-propose.ts`**

Create `src/lib/supplier-propose.ts` with the function from Task 1 (same body, `import { prisma } from '@/lib/prisma'`, `import { coverageScore } from '@/lib/supplier-matcher'`). In `scripts/audit-offer-supplier-links.ts` delete the local function and `import { proposeSupplier } from '../src/lib/supplier-propose'`.

- [ ] **Step 2: Write the backfill script**

`scripts/backfill-offer-supplier-fk.ts`:
```ts
// Make every supplier box link to its supplier before the column becomes NOT NULL.
//   DRY RUN (default, writes nothing):   npx tsx scripts/backfill-offer-supplier-fk.ts
//   APPLY (writes exactly the dry-run rows, backup JSON first):  … --apply
// Only three kinds of write, all listed by the dry run first:
//   1. offer.supplierId  null → the proposed supplier (exact alias/name, else fuzzy ≥ 0.5)
//   2. offer.supplierName     → the linked Supplier.name when they differ (display only)
//   3. APPROVED session.supplierId null → the proposed supplier
// An UNRESOLVED row is printed and left alone; the migration in Task 3 will then
// refuse to run, which is the point.
import fs from 'fs'
import { prisma } from '../src/lib/prisma'
import { proposeSupplier } from '../src/lib/supplier-propose'

const APPLY = process.argv.includes('--apply')

async function main() {
  const plan: { kind: 'offer-link' | 'offer-name' | 'session-link'; id: string; before: unknown; after: unknown; label: string }[] = []

  for (const o of await prisma.inventorySupplierPrice.findMany({ where: { supplierId: null }, select: { id: true, supplierName: true, inventoryItem: { select: { itemName: true } } } })) {
    const p = await proposeSupplier(o.supplierName)
    if (!p) { console.log(`UNRESOLVED offer ${o.id} ${o.inventoryItem.itemName} "${o.supplierName}"`); continue }
    plan.push({ kind: 'offer-link', id: o.id, before: { supplierId: null, supplierName: o.supplierName }, after: { supplierId: p.id, supplierName: p.name }, label: `${o.inventoryItem.itemName}: "${o.supplierName}" → ${p.name} (${p.how})` })
  }
  for (const o of await prisma.inventorySupplierPrice.findMany({ where: { supplierId: { not: null } }, select: { id: true, supplierName: true, supplier: { select: { name: true } }, inventoryItem: { select: { itemName: true } } } })) {
    if (o.supplier && o.supplierName !== o.supplier.name)
      plan.push({ kind: 'offer-name', id: o.id, before: { supplierName: o.supplierName }, after: { supplierName: o.supplier.name }, label: `${o.inventoryItem.itemName}: "${o.supplierName}" → "${o.supplier.name}"` })
  }
  for (const s of await prisma.invoiceSession.findMany({ where: { supplierId: null, status: 'APPROVED' }, select: { id: true, supplierName: true, invoiceNumber: true } })) {
    const p = s.supplierName ? await proposeSupplier(s.supplierName) : null
    if (!p) { console.log(`UNRESOLVED session ${s.id} "${s.supplierName}"`); continue }
    plan.push({ kind: 'session-link', id: s.id, before: { supplierId: null }, after: { supplierId: p.id }, label: `invoice #${s.invoiceNumber ?? '—'} "${s.supplierName}" → ${p.name} (${p.how})` })
  }

  for (const w of plan) console.log(`${APPLY ? 'APPLY' : 'DRY  '} ${w.kind.padEnd(12)} ${w.label}`)
  console.log(`${plan.length} write(s) planned${APPLY ? '' : ' — re-run with --apply to write them'}`)
  if (!APPLY || plan.length === 0) return

  const backup = `offer-supplier-fk-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.writeFileSync(backup, JSON.stringify(plan, null, 2))
  console.log(`backup written: ${backup}`)
  for (const w of plan) {
    if (w.kind === 'session-link') await prisma.invoiceSession.update({ where: { id: w.id }, data: w.after as { supplierId: string } })
    else await prisma.inventorySupplierPrice.update({ where: { id: w.id }, data: w.after as { supplierId?: string; supplierName?: string } })
  }
  console.log(`${plan.length} row(s) written`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 3: Dry run against the live database**

Run: `npx tsx scripts/backfill-offer-supplier-fk.ts`
Expected: exactly 3 planned writes — `offer-link Yellow potato … → Your Independent Grocer (fuzzy)`, `offer-name … "Sysco Canada, Inc." → "Sysco"`, `session-link invoice … → Your Independent Grocer` — and no UNRESOLVED line. Anything else: stop and report.

- [ ] **Step 4: Apply**

Run: `npx tsx scripts/backfill-offer-supplier-fk.ts --apply`
Expected: `backup written: offer-supplier-fk-backup-….json` then `3 row(s) written`. Re-run the Task 1 audit: `Offers with no supplier link: 0`, `… differs …: 0`, `APPROVED sessions with no supplier link: 0`.

- [ ] **Step 5: Commit (the backup JSON stays untracked)**

```bash
git add scripts/backfill-offer-supplier-fk.ts scripts/audit-offer-supplier-links.ts src/lib/supplier-propose.ts
git commit -m "chore(offers): backfill the last unlinked supplier box (dry-run by default)"
```

---

### Task 3: Schema + migration — `supplierId` required, unique on the id

**Files:**
- Modify: `prisma/schema.prisma` (`InventorySupplierPrice` model, lines ~533–565)
- Create: `prisma/migrations/20261003000000_offer_supplier_required/migration.sql`

**Interfaces:**
- Produces: Prisma type `InventorySupplierPrice.supplierId: string`, relation `supplier: Supplier` (required). Unique index `InventorySupplierPrice_item_supplier_sku_key` on `("inventoryItemId", "supplierId", COALESCE("supplierItemCode",''))`; index `InventorySupplierPrice_inventoryItemId_supplierId_idx`.

- [ ] **Step 1: Schema**

In `prisma/schema.prisma`, `InventorySupplierPrice`:
- `supplierId           String?` → `supplierId           String`
- `supplier             Supplier?     @relation(fields: [supplierId], references: [id])` → `supplier             Supplier      @relation(fields: [supplierId], references: [id])`
- Replace the `@@index([inventoryItemId, supplierName])` line and its comment block with:
```prisma
  // One offer per supplier PRODUCT: unique (inventoryItemId, supplierId,
  // COALESCE(supplierItemCode, '')) — an expression index Prisma cannot model,
  // created by migration 20261003000000_offer_supplier_required (it replaced the
  // supplierName-keyed index from 20260926). supplierName is display/provenance only.
  @@index([inventoryItemId, supplierId])
```

- [ ] **Step 2: Migration (hand-authored; `<FK_NAME>` is the constraint name the Task 1 audit printed)**

`prisma/migrations/20261003000000_offer_supplier_required/migration.sql`:
```sql
-- Every supplier box links to its supplier; the one-offer-per-supplier-product
-- key moves from the free-text supplierName to supplierId. supplierName stays as
-- display/provenance. Backfill (scripts/backfill-offer-supplier-fk.ts) ran first;
-- SET NOT NULL below fails loudly if any NULL remains.
ALTER TABLE "InventorySupplierPrice" ALTER COLUMN "supplierId" SET NOT NULL;
ALTER TABLE "InventorySupplierPrice" DROP CONSTRAINT IF EXISTS "<FK_NAME>";
ALTER TABLE "InventorySupplierPrice" ADD CONSTRAINT "InventorySupplierPrice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX IF EXISTS "InventorySupplierPrice_item_supplier_sku_key";
DROP INDEX IF EXISTS "InventorySupplierPrice_inventoryItemId_supplierName_idx";
CREATE UNIQUE INDEX "InventorySupplierPrice_item_supplier_sku_key" ON "InventorySupplierPrice" ("inventoryItemId", "supplierId", (COALESCE("supplierItemCode", '')));
CREATE INDEX "InventorySupplierPrice_inventoryItemId_supplierId_idx" ON "InventorySupplierPrice" ("inventoryItemId", "supplierId");
```
(If the audit printed `FK on supplierId: NONE`, delete the `DROP CONSTRAINT` line.)

- [ ] **Step 3: Safety grep, then apply over the pooler**

Run: `grep -nE "DROP TABLE|DELETE|TRUNCATE" prisma/migrations/20261003000000_offer_supplier_required/migration.sql`
Expected: no output.

Run: `node scripts/apply-migration.cjs prisma/migrations/20261003000000_offer_supplier_required`
Expected: each statement applied, migration recorded. If `SET NOT NULL` fails, the backfill did not complete — go back to Task 2, never edit the SQL to skip it.

Run: `npx prisma generate`
Expected: client regenerated (`supplierId: string`).

- [ ] **Step 4: Verify the live shape (read-only)**

Re-run the Task 1 audit: the last line must read `FK on supplierId: InventorySupplierPrice_supplierId_fkey (on delete RESTRICT)`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261003000000_offer_supplier_required/migration.sql
git commit -m "feat(db): a supplier box always links to its supplier — supplierId NOT NULL, unique per (item, supplier, SKU)"
```

---

### Task 4: Writers and readers key on `supplierId`

**Files:**
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (offer gate ~line 573; `offerData.supplierId` ~709; update `...(session.supplierId ? …)` ~730; existing-offer lookup ~701)
- Modify: `src/app/api/invoices/sessions/[id]/route.ts` (the `updateMany` on orphaned offers ~163)
- Modify: `src/lib/invoice-matcher.ts` (`matchLineItems` signature ~442; offers query ~579–597; `buildOfferSkuIndex` ~291)
- Modify: `src/app/api/invoices/sessions/[id]/process/route.ts` (~332 call site)
- Modify: `src/lib/invoice/line-format.ts` (`supplierOffers` ~38)
- Modify: `src/lib/item-merge.ts` (`offerKey` ~372, `canSynth` ~398, synthesized offer ~446), `src/lib/item-merge-exec.ts` (~243, ~269: carry `supplierId` on survivor offers)
- Modify: `src/lib/supplier-offers.ts` (`keyOf` ~157)
- Modify: `src/app/api/suppliers/[id]/route.ts` (DELETE)
- Tests: `src/lib/__tests__/line-format.test.ts`, `src/lib/__tests__/invoice-matcher-aliases.test.ts`, `src/lib/__tests__/item-merge.test.ts`, `src/app/api/suppliers/__tests__/delete.test.ts` (new)

**Interfaces:**
- `matchLineItems(ocrItems, supplierName?, canonicalName?, supplierId?: string | null)` — fourth parameter; offers are loaded `where: { supplierId }` when present, else no offers.
- `buildOfferSkuIndex(offerRows: { supplierId: string; supplierItemCode: string | null; inventoryItemId: string }[]): Map<string, string>` — no canonical-name argument.
- `supplierOffers(offers, ref)` returns `[]` when `ref.supplierId` is absent (the name fallback is removed).
- Approve: an offer row is written only when `session.supplierId` is set; without it the legacy direct spine write still happens and nothing else changes.
- Supplier DELETE: `409 { error: "<name> still has <n> supplier boxes. Merge or remove those items' boxes first." }` when any offer references it; `requireSession('ADMIN')`.

- [ ] **Step 1: Failing tests**

Append to `src/lib/__tests__/line-format.test.ts`:
```ts
describe('supplierOffers — keyed on the supplier id only', () => {
  const rows = [
    { supplierId: 's1', supplierName: 'Sysco', supplierItemCode: 'A1', isPrimary: true },
    { supplierId: 's2', supplierName: 'Snow Cap', supplierItemCode: null, isPrimary: false },
  ]
  it('returns the rows of ref.supplierId', () => {
    expect(supplierOffers(rows, { supplierId: 's2' }).map(o => o.supplierName)).toEqual(['Snow Cap'])
  })
  it('returns nothing when the session has no linked supplier — a name never stands in for the id', () => {
    expect(supplierOffers(rows, { supplierName: 'Sysco', canonicalName: 'Sysco' })).toEqual([])
  })
})
```
Append to `src/lib/__tests__/invoice-matcher-aliases.test.ts`:
```ts
describe('buildOfferSkuIndex — (supplier, SKU) → item from one supplier\'s rows', () => {
  it('maps each SKU to its item and drops a SKU two items claim', () => {
    const idx = buildOfferSkuIndex([
      { supplierId: 's1', supplierItemCode: 'A1', inventoryItemId: 'i1' },
      { supplierId: 's1', supplierItemCode: 'B2', inventoryItemId: 'i2' },
      { supplierId: 's1', supplierItemCode: 'B2', inventoryItemId: 'i3' },
    ])
    expect(idx.get('A1')).toBe('i1')
    expect(idx.has('B2')).toBe(false)
  })
})
```
(Remove or rewrite any existing `buildOfferSkuIndex` test in that file that passes a canonical-name argument so it matches the new one-argument signature.)

In `src/lib/__tests__/item-merge.test.ts` find the test(s) that build absorbed/survivor offers for the collision rule and add `supplierId: 's1'` (same id on both sides) to the colliding pair; add one case where two offers share `supplierName` but have different `supplierId` and assert BOTH survive (no delete op).

`src/app/api/suppliers/__tests__/delete.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NextRequest } from 'next/server'
const count = vi.fn(async () => 3)
const del = vi.fn(async () => ({}))
vi.mock('@/lib/prisma', () => ({ prisma: {
  supplier: { findUnique: async () => ({ id: 's1', name: 'Sysco' }), delete: del },
  inventorySupplierPrice: { count },
  inventoryItem: { updateMany: async () => ({ count: 0 }) },
} }))
vi.mock('@/lib/auth', () => ({ requireSession: async () => ({ id: 'u1', role: 'ADMIN', isActive: true }), AuthError: class extends Error { status = 403 } }))
const route = await import('@/app/api/suppliers/[id]/route')
describe('DELETE /api/suppliers/[id]', () => {
  it('refuses while the supplier still has price boxes', async () => {
    const res = await route.DELETE({} as NextRequest, { params: { id: 's1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/3 supplier boxes/)
    expect(del).not.toHaveBeenCalled()
  })
  it('deletes once no box references it', async () => {
    count.mockResolvedValueOnce(0)
    const res = await route.DELETE({} as NextRequest, { params: { id: 's1' } })
    expect(res.status).toBe(200)
    expect(del).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run them — they fail**

Run: `npx vitest run src/lib/__tests__/line-format.test.ts src/lib/__tests__/invoice-matcher-aliases.test.ts src/lib/__tests__/item-merge.test.ts src/app/api/suppliers/__tests__/delete.test.ts`
Expected: FAIL (name fallback still returns rows; signature mismatch; delete route returns 200 / no auth).

- [ ] **Step 3: Implement — `line-format.ts`**

Replace `supplierOffers` with:
```ts
/** Every offer belonging to a line's supplier — by supplier id only. A session
 *  with no linked supplier has no offers: nothing stands in for the id. */
export function supplierOffers<T extends OfferFormat>(offers: T[] | null | undefined, ref: SupplierRef): T[] {
  if (!offers?.length || !ref.supplierId) return []
  return offers.filter(o => o.supplierId === ref.supplierId)
}
```
Update the `SupplierRef` doc: `canonicalName` and `supplierName` are now display-only inputs (keep the fields; the review UI still passes them).

- [ ] **Step 4: Implement — matcher + process route**

`src/lib/invoice-matcher.ts`:
- `export async function matchLineItems(ocrItems, supplierName?, canonicalName?, supplierId?: string | null)`.
- Offers block (~579–597): replace the name-based query and the raw/canonical partition with
```ts
  // ── This supplier's offers: per-supplier last price + pack format ─────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let offerRows: any[] = []
  if (supplierId) {
    try { offerRows = await prisma.inventorySupplierPrice.findMany({ where: { supplierId } }) }
    catch { /* stale client — fall back to item comparison */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerByItemId = new Map<string, any>()
  for (const o of offerRows) if (!offerByItemId.has(o.inventoryItemId) || o.isPrimary) offerByItemId.set(o.inventoryItemId, o)
```
- `buildOfferSkuIndex(offerRows)` (one argument): build `skuByItem` from every row's `supplierItemCode`, then the ambiguity drop exactly as today; delete the canonical-name precedence loop and update its doc comment ("rows are already one supplier's — loaded by supplierId").
- Update the call to `buildOfferSkuIndex(offerRows)`.

`src/app/api/invoices/sessions/[id]/process/route.ts` ~332: `matched = await matchLineItems(allOcrItems, finalSupplierName, canonicalName, session.supplierId ?? autoSupplierId ?? null)`.

- [ ] **Step 5: Implement — approve route**

- ~573: `if (offerSupplierName) {` → `if (offerSupplierName && session.supplierId) {` with a comment: `// An offer row needs a linked supplier (supplierId is NOT NULL). An invoice whose supplier is not linked still prices the item through the legacy direct spine write below — link the supplier on the review screen to record its box.`
- ~709: `supplierId: session.supplierId || null,` → `supplierId: session.supplierId,`
- ~730: `...(session.supplierId ? { supplierId: session.supplierId } : {}),` → `supplierId: session.supplierId,`
- ~701: the existing-offer lookup `where: { inventoryItemId: scanItem.matchedItemId, supplierName: offerSupplierName }` → `where: { inventoryItemId: scanItem.matchedItemId, supplierId: session.supplierId }`.
- ~768–772 (`shouldReprice`): `primary?.supplierName === offerSupplierName` → select `supplierId` on the primary lookup and compare `primary?.supplierId === session.supplierId`.

`src/app/api/invoices/sessions/[id]/route.ts` ~160–166: delete the "Adopt orphaned offers" `updateMany` block and its comment (no orphan can exist now).

- [ ] **Step 6: Implement — item merge, supplier-offers**

`src/lib/item-merge.ts`:
- `offerKey = (supplierId: string, code: unknown) => \`${supplierId}\u0000${normItemCode(...)}\`` and every call passes `o.supplierId`; the `MergeRelations.offers` / `SurvivorRelations.offers` types get `supplierId: string` (survivor rows must now carry it — update `item-merge-exec.ts` ~269 to include `supplierId: o.supplierId`).
- `canSynth` requires `rel.latestPurchaseSupplier?.supplierId` (a session without a linked supplier cannot synthesize an offer) and the key check uses that id; the synthesized row's `supplierId` is that id (no longer nullable).
- Update the header comment "offers: unique (item, supplierName, SKU)" → "(item, supplierId, SKU)".

`src/lib/supplier-offers.ts` ~157–171: `keyOf` becomes the id only: `const keyOf = (id: string | null | undefined) => id ?? ''` and both uses drop the name argument (a session line with no `supplierId` contributes no history).

- [ ] **Step 7: Implement — supplier DELETE**

`src/app/api/suppliers/[id]/route.ts`:
```ts
import { requireSession, AuthError } from '@/lib/auth'
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireSession('ADMIN') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
  const supplier = await prisma.supplier.findUnique({ where: { id: params.id }, select: { id: true, name: true } })
  if (!supplier) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Every supplier box links to its supplier (NOT NULL, RESTRICT): a supplier
  // with boxes cannot be deleted. Say which, instead of a database error.
  const boxes = await prisma.inventorySupplierPrice.count({ where: { supplierId: params.id } })
  if (boxes > 0) {
    return NextResponse.json({ error: `${supplier.name} still has ${boxes} supplier boxes. Merge or remove those items' boxes first.` }, { status: 409 })
  }
  await prisma.inventoryItem.updateMany({ where: { supplierId: params.id }, data: { supplierId: null } })
  await prisma.supplier.delete({ where: { id: params.id } })
  return NextResponse.json({ success: true })
}
```
(Keep `PUT` as it is, but add the same `requireSession('ADMIN')` guard at its top.)

- [ ] **Step 8: Tests, type-check, lint, suite**

Run the four focused files (Step 2) → PASS. Then `npm test` (fix any fixture that now needs `supplierId` — the Prisma row type requires it; add `supplierId: 's1'` rather than loosening types), `npm run build` (then the `tsconfig.json` check), `npm run lint` (baseline 20 files, nothing new in touched lines).

- [ ] **Step 9: Commit**

```bash
git add -A src
git commit -m "feat(offers): supplier boxes are keyed on the supplier, not its name — approve, matcher, merge, supplier delete"
```

---

### Task 5: Smoke in the preview, PR

- [ ] **Step 1: Preview from this worktree**

Temporarily add to the worktree's `.claude/launch.json` (do NOT commit):
```json
{ "name": "Worktree offer-supplier-link", "runtimeExecutable": "/bin/sh",
  "runtimeArgs": ["-c", "cd /Users/joshua/dev/fergies-os/.claude/worktrees/offer-supplier-link && exec /Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin/node node_modules/next/dist/bin/next dev -p 3114"],
  "port": 3114 }
```
`preview_start`, confirm `lsof -a -p <pid> -d cwd -Fn` prints the worktree. Check: `/inventory` loads with the same values; open Yellow potato's drawer → its supplier box now shows "Your Independent Grocer"; `/invoices` opens a REVIEW session without error; `GET /api/inventory/<goats-cheese-id>/suppliers` returns the Sysco box with `supplierId`. Then `preview_stop`, `git checkout .claude/launch.json`.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin HEAD:feat/offer-supplier-link
gh pr create --base main --head feat/offer-supplier-link --title "feat(offers): every supplier box is linked to its supplier" --body "$(cat <<'EOF'
## What changes for the restaurant
- Every supplier box (price + pack format) is now tied to the supplier record, not to the name printed on the invoice. The four spellings of Sysco can never split one item's prices into two boxes again.
- Live data fixed first (3 rows, backup kept): Yellow potato's box and one approved invoice linked to Your Independent Grocer; one box's label "Sysco Canada, Inc." → "Sysco".
- An invoice whose supplier is not linked yet still updates the item's price; it just does not record a supplier box until the supplier is linked on the review screen.
- A supplier that still has boxes can no longer be deleted by mistake (clear message instead).
- No price, pack or stock number changes.

## How
Spec §2.3 `docs/superpowers/specs/2026-10-03-item-backbone-design.md`; plan `docs/superpowers/plans/2026-10-03-item-backbone-1c-offer-supplier-link.md`.
Migration `20261003000000_offer_supplier_required` (applied live via `scripts/apply-migration.cjs` after the backfill): `supplierId` NOT NULL, FK RESTRICT, unique `(inventoryItemId, supplierId, COALESCE(supplierItemCode,''))`. Approve/matcher/merge/supplier-offers key on `supplierId`; `supplierName` is display only.

## Checks
- `npm test` green (new: coverageScore, supplierOffers id-only, buildOfferSkuIndex, merge key, supplier delete 409). `npm run build` green. Lint identical to main.
- Audit after: 0 unlinked boxes, 0 mismatched names, 0 duplicates, FK RESTRICT.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

- **Spec coverage (§2.3 offer row):** NOT NULL + id-keyed unique index (Task 3), backfill with dry run (Tasks 1–2), readers/writers on the id (Task 4), `supplierName` retained as provenance (everywhere). The `InvoiceMatchRule` supplier FK is Stage 3 (own table), not here.
- **Placeholders:** `<FK_NAME>` is filled from the Task 1 audit output — the one value only the live database knows.
- **Type consistency:** `proposeSupplier(name)` (Tasks 1→2), `coverageScore(a, b)` (Task 1), `matchLineItems(…, supplierId?)` + `buildOfferSkuIndex(rows)` (Task 4 + process route), `supplierOffers` id-only (Task 4), `offerKey(supplierId, code)` (Task 4) — names match across tasks.
