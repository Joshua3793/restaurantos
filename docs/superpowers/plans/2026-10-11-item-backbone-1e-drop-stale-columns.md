# Item backbone — Stage 1e: drop the retired columns and the old match-rule table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the columns and the table nothing has read or written since the readers went live (Stage 1d on 2026-10-03, Stage 3 on 2026-10-04), so no future change can drift back onto a stale copy.

**Do not start before 2026-10-11** (spec §6: drops ship a week after the readers are live). Verify the date before entering the worktree.

**Architecture:** one hand-authored migration (`DROP COLUMN` × 5, `DROP TABLE InvoiceMatchRule`), applied live with `node scripts/apply-migration.cjs` after a JSON backup of the five columns and the whole table; the Prisma schema loses the fields and the model; every remaining code reference is deleted (fills on create, the two item-delete cleanups, the rollback-load reference count, the `MATCH_RULE` undo kind kept as a parse-only no-op, client types, scripts/seeds). `cost-readers-gate.test.ts` / `stale-columns-gate.test.ts` keep guarding the names.

**Tech Stack:** Prisma migration SQL, TypeScript, vitest, `npm run build`.

## Global Constraints
- Branch off `origin/main` AFTER Stage 4 merges. Worktree `.claude/worktrees/drop-stale-columns`, branch `worktree-drop-stale-columns`, pushed as `feat/drop-stale-columns`. One PR, squash-merged. `git fetch origin && git reset --hard origin/main` after `EnterWorktree`; symlink `node_modules` and `.env`.
- PATH prefix `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&`. Restore `tsconfig.json` after a build.
- **Live, destructive, irreversible without the backup.** Backup FIRST (`scripts/backup-stale-columns.ts` → `stale-columns-backup-<stamp>.json` with every `InventoryItem.{id,purchasePrice,supplierId,location,needsReview}`, every `InventorySupplierPrice.{id,lastPrice}`, and every `InvoiceMatchRule` row), copy it to the main checkout root, THEN apply the migration. Say "live" in the PR.
- Columns to drop: `InventoryItem.purchasePrice`, `InventoryItem.supplierId` (+ its FK and the `Supplier.inventory` relation), `InventoryItem.location`, `InventoryItem.needsReview`, `InventorySupplierPrice.lastPrice`. Table to drop: `InvoiceMatchRule` (+ `InventoryItem.matchRules` relation).
- Tests: `npm test` green; `npm run build` green; lint baseline unchanged (19 files on main as of 2026-10-04).

### Task 1: Backup script + migration + schema
- Create `scripts/backup-stale-columns.ts` (read-only except the JSON file). Run it; copy the backup.
- Create `prisma/migrations/20261011000000_drop_stale_columns/migration.sql`:
```sql
ALTER TABLE "InventoryItem" DROP CONSTRAINT IF EXISTS "InventoryItem_supplierId_fkey";
DROP INDEX IF EXISTS "InventoryItem_supplierId_idx";
ALTER TABLE "InventoryItem" DROP COLUMN "purchasePrice";
ALTER TABLE "InventoryItem" DROP COLUMN "supplierId";
ALTER TABLE "InventoryItem" DROP COLUMN "location";
ALTER TABLE "InventoryItem" DROP COLUMN "needsReview";
ALTER TABLE "InventorySupplierPrice" DROP COLUMN "lastPrice";
DROP TABLE "InvoiceMatchRule";
```
(verify the real constraint/index names with `prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource` or by querying `pg_indexes`/`pg_constraint` read-only first; use the names Postgres has.)
- Schema: remove the five fields, the `Supplier.inventory` and `InventoryItem.matchRules` relations, the `InvoiceMatchRule` model. `npx prisma generate`.
- Apply live with the runner; commit `feat(db): drop the retired price/supplier/location/needsReview/lastPrice columns and the old match-rule table`.

### Task 2: Code removals
- `grep -rn "purchasePrice\|needsReview\|lastPrice\|invoiceMatchRule\|InvoiceMatchRule\|\.location\b\|location:" src scripts prisma/seed.ts` and remove every remaining reference: the `lastPrice:` fills on box create (approve route CREATE_NEW + the three create paths + merge synth), the two item-delete cleanups (`inventory/[id]/route.ts`, `inventory/bulk/route.ts`), `rollback-load.ts` old-rule reference count, `approve-undo.ts` `MATCH_RULE` kind (keep the string in `UndoKind` for old records; delete `RULE_FIELDS`/`ruleState`/`RULE_SELECT`; `rollback.ts` keeps the labelled no-op branch for `MATCH_RULE`), `suppliers/[id]/route.ts` `updateMany` clear of `supplierId`, the count page `item.location` fallback, client types (`src/components/invoices/types.ts`, drawer types), `scripts/migrate-match-rules.ts` (delete), seeds. Keep `currentFieldsOnly`.
- Update `stale-columns-gate.test.ts` to assert the names appear nowhere in `src` except the undo no-op.
- Fix the two pre-existing test-file type errors (`count-expected-bridges.test.ts:22`, `rollback.test.ts` `as Offer`).
- `npm test`, `npm run build`, lint. Commit `refactor(items): remove every reference to the dropped columns and table`.

### Task 3: PR
- Push, PR (Before: "five stale copies and an old match-rule table still existed, unread. After: gone; the backup is at …"), checks, squash-merge.

## Self-review
- Covers the 1e list in `project_item_drawer_redesign.md` memory (5 columns + lastPrice fills + suppliers/[id] clear + count page fallback + client types + scripts/seeds + keep currentFieldsOnly) and the Stage 3 addendum (DROP InvoiceMatchRule + remove the MATCH_RULE write paths). No placeholders. Names consistent with the schema as of 2026-10-04.
