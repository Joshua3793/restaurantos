# Item backbone — Stage 3: clean names and supplier wordings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every item has one plain name; every supplier's own wording and product code for it are stored as that supplier's alias; the invoice matcher looks up that supplier's code, then that supplier's wording, then the plain name — never another supplier's wording, never a switched-off or merged item. The 53 OCR-style item names get renamed from an owner-approved list, with the old wording kept as an alias.

**Architecture:** New table `ItemSupplierAlias` (supplier FK, normalised text, code, learned pack format, source, use count) replaces `InvoiceMatchRule` as the thing the matcher reads and approve writes. One normaliser `normaliseAliasText` in `src/lib/alias-text.ts` is used by the matcher, the upsert and the backfill. The old `InvoiceMatchRule` table is left in place but no longer read or written (its DROP ships in the Stage 1e drop PR); a backfill script copies its rows into aliases (supplier resolved through the existing `SupplierAlias` names, unresolvable rows reported). Undo/rollback and item-merge switch to alias ids; old undo records that name rule ids become no-ops for that step. The drawer gets a "Supplier wordings" list with ✕. The rename ships as two scripts: propose (read-only, Claude suggests names → table for the owner) and apply (writes names + aliases with a backup).

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma (one additive migration via `node scripts/apply-migration.cjs`), vitest, `npm run build`, Anthropic SDK (already used by `src/lib/invoice-ocr.ts`) for the rename proposals.

**Spec:** `docs/superpowers/specs/2026-10-03-item-backbone-design.md` §4 (W1–W9, §4.3).

## Global Constraints

- Branch off `origin/main` after Stage 2c merges. Worktree `.claude/worktrees/names-aliases`, branch `worktree-names-aliases`, pushed as `feat/names-aliases`. One PR, squash-merged. After `EnterWorktree`: `git fetch origin && git reset --hard origin/main`; symlink `node_modules` and `.env`.
- `node`/`npm` are not on the sandbox PATH: prefix every command with `export PATH="/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin:$PATH" &&` (Bash `dangerouslyDisableSandbox: true`). `npm run build` may rewrite `tsconfig.json` — restore it. Lint baseline on `main` = 20 files; add none.
- **Migration is additive only**: create `ItemSupplierAlias` (+ the Prisma relation fields on `InventoryItem` and `Supplier`). **No DROP of `InvoiceMatchRule` in this PR** (rollout rule: drops ship a week after the readers go live; add it to the Stage 1e drop list).
- **Live writes in this PR, each dry-run first with a JSON backup in the worktree root** (copy backups to the main checkout root too): (1) the alias backfill from `InvoiceMatchRule` (556 rows on 2026-10-02); (2) the rename apply — ONLY after the owner has approved the proposals table (this is the one approval point of the stage).
- **One normaliser.** `normaliseAliasText(s)`: NFKD → lower → strip everything but `[a-z0-9 ]` (punctuation to space) → collapse whitespace → trim. Codes through `normItemCode` (`src/lib/invoice/line-format.ts`: trim + upper; '' → null). Uniqueness is `(supplierId, text)` on the NORMALISED text.
- **Matcher tiers (W3), in order, each scoped to the session's `supplierId`:** 0 alias by `(supplierId, code)` → HIGH; 0b this supplier's OFFER SKU (existing `buildOfferSkuIndex`, unchanged) → HIGH; 1 alias by `(supplierId, text)` → HIGH; 2 fuzzy against `itemName` only → `confidenceFromScore`; 3 fuzzy against THIS supplier's aliases → capped MEDIUM (`capAliasConfidence`). With no `supplierId` on the session: tiers 0, 0b, 1, 3 are skipped (fuzzy on names only). No borrowed aliases from other suppliers, ever.
- **W4 at every tier:** candidate items are `isActive && mergedIntoId == null && recipe == null` (today's query excludes PREP recipe outputs via `NOT: { recipe: { type: 'PREP' } }` and inactive; add `mergedIntoId: null`); alias joins filter the same way (an alias whose item fails the filter is ignored, not deleted).
- **Every approved line with a supplier upserts an alias** (W2) — replacing `saveMatchRule`. CREATE_NEW lines too (today they save nothing). The upsert keeps today's "code belongs to one item per supplier" rule (siblings with the same code under this supplier and another item lose their code).
- Role gates: alias GET MANAGER+ (it is drawer data for managers; LEAD sees nothing of it), DELETE MANAGER+. Plain English sentences. Prisma `Decimal` → `Number()`.
- Tests: `npm test` green; `npm run build` green; routes `ƒ (Dynamic)`.

---

### Task 1: Normaliser, schema, migration, backfill

**Files:**
- Create: `src/lib/alias-text.ts`, `src/lib/__tests__/alias-text.test.ts`
- Modify: `prisma/schema.prisma` (model `ItemSupplierAlias`; relations `aliases ItemSupplierAlias[]` on `InventoryItem` and `Supplier`); create `prisma/migrations/20261006000000_item_supplier_alias/migration.sql`
- Create: `scripts/backfill-item-supplier-aliases.ts`

**Interfaces (produces):**
```ts
// src/lib/alias-text.ts — pure
export function normaliseAliasText(s: string | null | undefined): string          // '' when blank
export function isShoutyName(name: string): boolean   // ≥ 3 words AND ≥ 70 % of its letters are uppercase (digits/punctuation ignored); false for < 3 words
export const SHOUTY_HINT = 'That looks like an invoice wording, not a plain name. Give it a plain name (for example "Red Grapes") — the invoice wording is kept as the supplier\'s own.'
```
Schema (exact — the spec's block, with the `source` values as a comment):
```prisma
model ItemSupplierAlias {
  id               String   @id @default(cuid())
  inventoryItemId  String
  supplierId       String
  text             String            // normaliseAliasText(rawText)
  rawText          String            // as last seen on an invoice, for display
  supplierItemCode String?           // normItemCode
  packQty          Decimal?          // learned human format, display/provenance only
  packSize         Decimal?
  packUOM          String?
  source           String            // 'APPROVE' | 'CREATE_NEW' | 'MERGE' | 'RENAME' | 'BACKFILL'
  useCount         Int      @default(1)
  lastUsed         DateTime @default(now())
  createdAt        DateTime @default(now())
  inventoryItem    InventoryItem @relation(fields: [inventoryItemId], references: [id], onDelete: Cascade)
  supplier         Supplier      @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  @@unique([supplierId, text])
  @@index([supplierId, supplierItemCode])
  @@index([inventoryItemId])
}
```
Migration SQL: `CREATE TABLE "ItemSupplierAlias" (…)` with the two FKs (`ON DELETE CASCADE`), `CREATE UNIQUE INDEX "ItemSupplierAlias_supplierId_text_key"`, the two indexes. Apply with `node scripts/apply-migration.cjs prisma/migrations/20261006000000_item_supplier_alias`, then `npx prisma generate`.

Backfill script (`npx tsx scripts/backfill-item-supplier-aliases.ts [--apply]`): read every `InvoiceMatchRule` with its item (`isActive, mergedIntoId, recipe`); resolve the supplier: `supplierName === ''` → unresolved ("no supplier"); else exact `Supplier.name` (case-insensitive) → else `SupplierAlias.name` exact (case-insensitive) → else unresolved. Skip (and report) rules whose item is a tombstone (`mergedIntoId != null`) or recipe-made. Group the rest by `(supplierId, normaliseAliasText(rawDescription))`: when several rules land on one key, keep the one with the highest `useCount` as the row (`rawText` = its `rawDescription`, code = its code, pack = its pack), `useCount` = sum, `lastUsed` = max, `source: 'BACKFILL'`; report the collisions. Dry run prints: rows to create, collisions, unresolved (with reason) — and writes `docs/audits/2026-10-aliases/backfill-report.md` (table of unresolved rules: rawDescription · supplierName · item · reason). `--apply`: backup `item-supplier-aliases-backup-<stamp>.json` (every InvoiceMatchRule row as-is), then `createMany({ skipDuplicates: true })` in chunks of 200; prints created count; re-runnable (existing keys skipped).

- [ ] **Step 1:** tests for `normaliseAliasText` (`"GRAPE, RED  Frsh/Seedls (CLAM)"` → `"grape red frsh seedls clam"`; blank → `''`; accents → ascii) and `isShoutyName` (`"GRAPE RED FRSH SEEDLS CLAM"` → true; `"Red Grapes"` → false; `"GF BUN"` → false (2 words); `"Bun 12 PK"` → false).
- [ ] **Step 2:** implement; schema + migration; **apply the migration live**; write the backfill; run DRY; attach the dry-run summary (counts) to the report file.
- [ ] **Step 3:** `npm test`; commit `feat(aliases): ItemSupplierAlias table, normaliser, backfill (dry)`.
- [ ] **Step 4 (live write):** run `--apply`; record created/collisions/unresolved counts + backup path in the report and in the PR body; copy the backup to the main checkout root.

---

### Task 2: Matcher reads aliases; approve writes them

**Files:**
- Modify: `src/lib/invoice-matcher.ts` (`matchLineItems`, replace `saveMatchRule` with `saveAlias`; delete `isSupplierSpecificRule`, `offerSkuTierYieldsToRule`, `groupAliases`, `MAX_ALIASES_PER_ITEM` and their tests if nothing else uses them — grep first)
- Modify: `src/app/api/invoices/sessions/[id]/approve/route.ts` (call `saveAlias` for every matched non-SKIP line AND for each CREATE_NEW line with `source: 'CREATE_NEW'`; pass `session.supplierId`, the line's `supplierItemCode`, the pack triple)
- Modify: `src/lib/invoice/approve-undo.ts` (kind `ALIAS` with `ALIAS_FIELDS = ['inventoryItemId','supplierId','text','rawText','supplierItemCode','packQty','packSize','packUOM','useCount']`; `aliasState`; keep `MATCH_RULE` in the type so old records still parse), `src/lib/invoice/rollback.ts` (table `'alias'` → `tx.itemSupplierAlias`; records of kind `MATCH_RULE` → `{ outcome: 'skipped', reason: 'learned wording predates the alias table' }` — never touch `invoiceMatchRule`)
- Tests: `src/lib/__tests__/invoice-matcher.test.ts` (existing — update), `src/lib/invoice/__tests__/rollback*.test.ts` (existing — add the MATCH_RULE no-op case), `src/lib/__tests__/save-alias.test.ts`

**Interfaces:**
```ts
export async function saveAlias(a: {
  rawDescription: string; inventoryItemId: string; supplierId: string | null | undefined
  supplierItemCode?: string | null; format?: { packQty: number; packSize: number; packUOM: string } | null
  source: 'APPROVE' | 'CREATE_NEW'; undo?: UndoCollector
}): Promise<void>
// no supplierId or blank text → return (nothing learned; log once per call at debug level)
// 1. code given → updateMany siblings { supplierId, supplierItemCode: code, inventoryItemId: { not } } → { supplierItemCode: null } (undo.before for each, same caught-read discipline as today)
// 2. upsert where { supplierId_text: { supplierId, text } } create { …, rawText: rawDescription, source, useCount 1 } update { inventoryItemId, rawText, useCount +1, lastUsed now, code if given, pack if given } (undo.before / undo.created exactly as saveMatchRule does today)
```
`matchLineItems(ocrItems, supplierName?, canonicalName?, supplierId?)` keeps its signature (callers unchanged) but the two name parameters are now unused for matching (keep them for logging only, or drop them and update the three callers — implementer's choice, state it in the report). Loads: items (W4 filter); when `supplierId`: `itemSupplierAlias.findMany({ where: { supplierId, OR: [{ text: { in: normalisedDescriptions } }, { supplierItemCode: { in: codes } }] }, include item (PRICING_SELECT + itemName + isActive + mergedIntoId + recipe) })` for tiers 0/1, and `itemSupplierAlias.findMany({ where: { supplierId, inventoryItemId: { in: itemIds } }, select: { inventoryItemId, rawText }, orderBy: [{ useCount: 'desc' }, { lastUsed: 'desc' }], take: 2000 })` for tier 3 (pre-normalised once per alias, at most 5 per item — keep today's cap as a local constant). Tier bodies: 0 code → `buildMatchResult(…, 'HIGH', 100, aliasFormat ?? parsed, offer)`; 0b unchanged; 1 text → HIGH 100; 2 fuzzy over `normalizedItems` by name only; 3 fuzzy over this supplier's aliases → `capAliasConfidence(conf, true)`; the fuzzy winner between 2 and 3 is chosen with `pickBestFuzzy` as today (own name beats alias on a tie).

- [ ] **Step 1: tests first** — matcher: (a) alias by code under supplier A matches HIGH; the same code under supplier B does not; (b) alias by text (normalised: punctuation/case differences) matches HIGH; (c) an alias whose item is inactive or merged is ignored (falls to fuzzy); (d) another supplier's alias never raises a score (fuzzy on names only); (e) this supplier's alias fuzzy hit is MEDIUM at most; (f) no supplierId → no alias tiers. `saveAlias`: upsert create/update paths, sibling code strip, undo captures. Rollback: a MATCH_RULE record → skipped with the reason; an ALIAS record → restores/deletes `itemSupplierAlias`.
- [ ] **Step 2:** implement; delete `saveMatchRule` and every `invoiceMatchRule` read/write in `src` (grep `invoiceMatchRule` → only `rollback.ts`'s legacy no-op comment may mention it); `npm run build`.
- [ ] **Step 3:** commit `feat(invoices): the matcher reads each supplier's own wordings and codes; approve learns them`.

---

### Task 3: Merge, create-new, shouty guard, supplier-alias confirm

**Files:**
- Modify: `src/lib/item-merge.ts` (`RepointTable` gains `'ItemSupplierAlias'`, `MergeRelations.aliasIds`, repoint op; W9: a `create-alias` op `{ t: 'alias', supplierId, text, rawText, source: 'MERGE' }` when the absorbed item has a primary box — planner emits it, exec writes it, undo deletes it by id recorded in the manifest), `src/lib/item-merge-exec.ts` + `src/lib/item-merge-rows.ts` (load `aliasIds`, delegate table, undo), `src/lib/__tests__/item-merge*.test.ts`
- Modify: `src/app/api/inventory/route.ts` POST — refuse `isShoutyName(itemName)` unless `allowShouty === true` → 400 `{ error: SHOUTY_HINT, code: 'SHOUTY_NAME' }`; `src/app/api/invoices/sessions/[id]/approve/route.ts` CREATE_NEW — same check on `newData.itemName` (skip the line with the hint in `skippedCreateNew`, do not create) unless `newData.allowShouty === true`.
- Modify: `src/components/invoices/v2/InvoiceReviewDrawer.tsx` create-new panel: the name box starts EMPTY (not the raw text), with "Sysco calls it: GRAPE RED FRSH SEEDLS CLAM" beneath (supplier name from the session, else "The invoice calls it"); a "Use this wording anyway" link fills the raw text and sets `allowShouty: true` in `newItemData`. Also the `/inventory` Add Item form: on 400 `SHOUTY_NAME` show the hint under the name with the same "Use it anyway" link (resend with `allowShouty: true`).
- Modify: `src/lib/supplier-matcher.ts` — `matchSupplierByName` no longer calls `learnAlias` on a FUZZY hit (exact hits need no learning); export `matchSupplierByName(name): Promise<{ supplierId: string; exact: boolean } | null>` and update the two callers (`process/route.ts:320`, `peek/route.ts:145`) to use `.supplierId`. The alias is learned when the approval goes through with a `supplierId` on the session: in approve, after the session is loaded, `await learnAlias(session.supplierId, session.supplierName).catch(() => {})` (the existing re-link route already learns on a manual pick — unchanged). Test: fuzzy hit returns `{ exact: false }` and writes no `SupplierAlias`.

- [ ] **Step 1:** tests (merge planner emits the repoint + alias op; undo removes the alias; shouty guard 400; approve skips a shouty CREATE_NEW with the hint; supplier matcher no auto-learn).
- [ ] **Step 2:** implement; `npm run build`; lint.
- [ ] **Step 3:** commit `feat(items): plain names on create, merge keeps the old name as a wording, supplier spellings confirmed at approve`.

---

### Task 4: Drawer "Supplier wordings" (W7)

**Files:**
- Create: `src/app/api/inventory/[id]/aliases/route.ts` (`GET` → `{ aliases: [{ id, supplierId, supplierName, rawText, supplierItemCode, packLabel, useCount, lastUsed }] }` grouped client-side), `src/app/api/inventory/[id]/aliases/[aliasId]/route.ts` (`DELETE` → `{ ok: true }`; 404 when not on this item)
- Create: `src/components/inventory/SupplierWordingsSection.tsx`; mount it in `InventoryItemDrawer.tsx` under the supplier boxes (view mode; MANAGER+ only; hidden for recipe-made items).
- Tests: `src/app/api/inventory/__tests__/alias-routes.test.ts` (LEAD 403; GET shape; DELETE wrong item 404).

UI: header "SUPPLIER WORDINGS · n"; grouped by supplier: `Sysco` then rows `GRAPE RED FRSH SEEDLS CLAM · #123456 · seen 14× · last 28 Sep · ✕`. ✕ → confirm "Forget this wording? The next invoice from Sysco with it will need matching again." → DELETE → refetch. Empty state: "No wordings learned yet — they are learned from approved invoices."

- [ ] Steps: tests → build → commit `feat(inventory): the drawer lists each supplier's wordings; a manager can forget one`.

---

### Task 5: The rename — propose (read-only) and apply

**Files:**
- Create: `scripts/propose-item-renames.ts`, `scripts/apply-item-renames.ts`, `docs/audits/2026-10-rename/` (proposals.json + proposals.md written by the script)
- Reuse: the Anthropic client setup from `src/lib/invoice-ocr.ts` (same key, model `claude-sonnet-5-5`), `isShoutyName`.

`propose`: select active, non-tombstone, non-recipe items where `isShoutyName(itemName)`; for each, one message: system "You name restaurant ingredients for a kitchen inventory. Reply with ONLY the name: 1–4 words, Title Case, no pack size, no supplier code, no brand unless it is the product (e.g. Tabasco)."; user: the item name + category + its boxes' `packLabel` + supplier names. Batch 10 names per request to keep it to ~6 calls; parse one name per line. Write `proposals.json` `[{ id, current, proposed, category, supplier }]` and `proposals.md` (a table: # · Current · Proposed · Category · Supplier). No DB writes.
`apply --apply` (reads `proposals.json`; `--only <id,...>` / `--skip <id,...>` to honour the owner's edits; an edited `proposed` value in the JSON is what gets written): backup `item-renames-backup-<stamp>.json` (id, old name); for each: `inventoryItem.update({ itemName: proposed, lastUpdated: now })` and, when the item has a primary box, upsert an alias `{ supplierId: primary box's, text: normaliseAliasText(old), rawText: old, source: 'RENAME' }` (skipDuplicates). Prints a per-item line. Nothing else changes (no prices, no stock, no recipes — recipe lines reference the item by id).

- [ ] **Step 1:** write both scripts; run `propose` (live read + Claude calls, no writes); commit the two files + `docs/audits/2026-10-rename/proposals.{json,md}` — `feat(scripts): propose and apply plain item names`.
- [ ] **Step 2 (OWNER GATE):** the controller shows `proposals.md` to the owner ONCE as a table and waits for approval/edits. **Do not run `apply` before that.**
- [ ] **Step 3 (after approval):** `apply --apply` (+ `--skip` for any he rejected); record the backup path + count in the PR.

---

### Task 6: Smoke, PR, merge

- [ ] Preview from the worktree (port 3119): upload nothing new — open an existing REVIEW session (or re-run matching via the scanitems refresh if one exists) and confirm lines match through aliases (network: `/api/invoices/sessions/[id]/process` or the scanitems GET shows `matchConfidence HIGH` for lines whose wording is an alias). In the drawer of a Sysco item, the wordings list shows its aliases; ✕ removes one (pick a throwaway: re-add is automatic on the next invoice). Create-new panel: name box empty with "Sysco calls it: …"; typing a shouty name shows the hint. Add Item form: shouty name → hint.
- [ ] Push `feat/names-aliases`, PR (Before: "the app matched invoice lines on exact wording + supplier name strings and borrowed other suppliers' wordings; 53 items had invoice-style names. After: each supplier's wording and code are stored per item; matching is per supplier; names are plain and approved by you; old wordings stay searchable"), `gh pr checks --watch`, squash-merge after the final review passes.
- [ ] Add to the Stage 1e drop list: `DROP TABLE "InvoiceMatchRule"` + remove the `MATCH_RULE` no-op branch, the `InventoryItem.matchRules` relation and `scripts/*` that reference it.

## Self-review
- **Spec coverage:** W1 (shouty guard on both create paths + "use anyway"), W2 (approve + create-new upsert), W3 (tiers), W4 (filters), W5 (empty name + "calls it"), W6 (no auto-learn on fuzzy; learned at approve/re-link), W7 (list + ✕), W8 (one normaliser), W9 (merge alias + repoint), §4.3 (propose/apply with owner gate). Migration drops deferred per §6.
- **Placeholders:** none; sentences given.
- **Type consistency:** `normaliseAliasText`, `isShoutyName`, `SHOUTY_HINT`, `saveAlias`, `ALIAS` undo kind, `ItemSupplierAlias`, routes as named.
