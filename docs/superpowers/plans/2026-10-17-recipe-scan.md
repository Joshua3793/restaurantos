# Recipe Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager photographs a cookbook page or drops a PDF / Word / Excel file, reviews what the app read, and saves a costed PREP recipe with a stepped, phased, timed method.

**Architecture:** A `RecipeScan` (uploaded files) is read by Claude in a background route into one `RecipeScanDraft` per recipe found. Pure libs under `src/lib/recipe-scan/` turn the extraction into a draft (matching, amounts, method, save rules) and are unit-tested; thin MANAGER-guarded routes persist drafts and save them in one transaction as an ordinary PREP recipe. The review UI is built from the Controla design system's Recipe-scan components.

**Tech Stack:** Next.js 14 App Router · TypeScript · Prisma/Postgres · `@anthropic-ai/sdk` ^0.86 · UploadThing · SheetJS `xlsx` (present) · `mammoth` (new, .docx → text) · vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-recipe-scan-design.md` (read it first; every "Joshua's decision" there is fixed).

**Design reference:** design system artifact "Controla OS" (https://claude.ai/artifact/NBzLWwR8Hmp8dVUm4AGgNJ), group "Recipe scan": ScanCapture, ScanReviewHead, CostSummary, IngredientMatchRow, FuzzyPicker, MethodStep; core: Pill, ActionRow, ProgressStrip, Button, Toast. Tailwind tokens already match Controla on main (PR #180).

## Global Constraints

- Read code from `origin/main`; build in a fresh worktree off `origin/main` (the main checkout is behind and has a dev server running).
- PREP recipes only. `type: 'PREP'` is hard-coded in the save path.
- Every new route calls `requireSession('MANAGER')` and maps `AuthError` → `NextResponse.json({ error: e.message }, { status: e.status })`; every route file exports `const dynamic = 'force-dynamic'`. Exception: the "original files" GET uses `requireSession()` (any signed-in user — Joshua's decision).
- Never store a price. Costs come from `lineCost` / `pricePerBaseUnit` (`src/lib/item-model.ts`) at read time.
- The recipe is saved exactly as written (no scaling).
- Times not stated on the page are marked `guessed`; the mark lives on the draft only.
- Unit conversion only for a line matched to an item, only into that item's dimension; unmatched lines keep `qtyText` exactly as written.
- Saving is blocked while any line is `CHECK`, yield or category is missing, or any unlinked line has no allergen choice (`allergens: string[]` set, possibly `[]` meaning "No allergens"; `null` = not chosen).
- Migrations are additive only. Write the SQL by hand in `prisma/migrations/<YYYYMMDDHHMMSS>_recipe_scan/migration.sql` (`prisma migrate dev` is broken here — shadow DB); apply to the live database **only after Joshua says yes**, with `npx prisma db execute --file …` then `npx prisma migrate resolve --applied <name>`.
- Model: one constant `RECIPE_SCAN_MODEL = 'claude-sonnet-5-5'` in `src/lib/recipe-scan/extract.ts`.
- Upload limits: 16 MB per file, 10 files per scan (as invoices).
- UI copy uses kitchen words: "read as", "no price yet", "no amount", "GUESSED", "CHECK", "NO MATCH", "Keep uncosted", "Create item", "See original".

## Review Focus

1. **A blurry or non-recipe photo** (a receipt, a blank page) → the scan ends "Couldn't read" with a retry, never an empty draft that can be saved. (Task 4 test.)
2. **Units the page writes oddly** ("1/2 cup", "1½ tbsp", "2-3 cloves", "250g", "a pinch") → quantity parses to a number or the line becomes NO AMOUNT with the words kept; never NaN or a silent 0. (Task 2 test.)
3. **Matching an inactive or merged item** → never offered; merged items resolve to their target. (Task 3 test.)
4. **A draft re-opened after its sibling saved, or after an item was renamed/deleted** → stale links are dropped back to NO MATCH on load, not saved as broken references. (Task 5 test; Task 6's draft GET runs it.)
5. **Two managers saving the same draft** (double tap) → one recipe, the second save gets 409. (Task 6 test.)

---

### Task 1: Database — scans, drafts, learned wordings and counts, line allergens, recipe source

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261018000000_recipe_scan/migration.sql`

**Interfaces — Produces (Prisma models):**
```prisma
model RecipeScan {
  id              String   @id @default(uuid())
  status          String   @default("UPLOADING") // UPLOADING | READING | READY | ERROR
  error           String?
  createdById     String
  revenueCenterId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  files           RecipeScanFile[]
  drafts          RecipeScanDraft[]
  recipes         Recipe[]
}
model RecipeScanFile {
  id       String @id @default(uuid())
  scanId   String
  fileName String
  fileType String
  fileUrl  String
  sortOrder Int   @default(0)
  scan     RecipeScan @relation(fields: [scanId], references: [id], onDelete: Cascade)
}
model RecipeScanDraft {
  id            String   @id @default(uuid())
  scanId        String
  index         Int
  title         String
  data          Json     // DraftData (Task 2)
  status        String   @default("OPEN") // OPEN | SAVED | DISCARDED
  savedRecipeId String?  @unique
  updatedAt     DateTime @updatedAt
  scan          RecipeScan @relation(fields: [scanId], references: [id], onDelete: Cascade)
}
model RecipeTextAlias {           // "sherry vin" -> Sherry Vinegar (recipe wording, not supplier)
  id              String  @id @default(cuid())
  text            String  @unique // normaliseAliasText(raw)
  inventoryItemId String?
  linkedRecipeId  String?
  useCount        Int     @default(1)
  lastUsed        DateTime @default(now())
}
model ItemCountMeasure {          // "1 clove of Garlic Peeled = 5 g"
  id              String  @id @default(cuid())
  inventoryItemId String
  word            String  // singular, lower-case: "clove", "bunch", "handful"
  qty             Decimal
  unit            String  // a canonical unit in the item's dimension
  @@unique([inventoryItemId, word])
}
```
Plus: `RecipeIngredient.allergens String[] @default([])`; `Recipe.sourceScanId String?` → `RecipeScan` (`onDelete: SetNull`).

- [ ] **Step 1:** Add the models/fields to `schema.prisma`.
- [ ] **Step 2:** Generate the SQL from the schema diff (no database needed): `git show "origin/main:prisma/schema.prisma" > <scratch>/old.prisma`, then `npx prisma migrate diff --from-schema-datamodel <scratch>/old.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261018000000_recipe_scan/migration.sql`. Expected: only `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, indexes, FKs — no `DROP`.
- [ ] **Step 3:** `npx prisma generate && npm run build`. Expected: build passes.
- [ ] **Step 4:** Commit (`feat(recipe-scan): tables for scans, drafts, learned wordings`). Do **not** apply to the live DB yet — ask Joshua at the end of Task 6.

### Task 2: Draft model + amounts (pure)

**Files:**
- Create: `src/lib/recipe-scan/types.ts`, `src/lib/recipe-scan/amount.ts`
- Test: `src/lib/__tests__/recipe-scan-amount.test.ts`

**Interfaces — Produces:**
```ts
// types.ts
export type LineStatus = 'MATCHED' | 'CHECK' | 'NO_MATCH' | 'NO_AMOUNT'
export interface ExtractedIngredient { raw: string; qty: number | null; unit: string | null; name: string; estimate?: { qty: number; unit: string } | null }
export interface ExtractedStep { text: string; phase: string; minutes: number | null; minutesStated: boolean; waitMinutes: number | null; waitNote: string | null; waitStated: boolean }
export interface ExtractedRecipe { name: string; yieldQty: number | null; yieldUnit: string | null; categoryHint: string | null; ingredients: ExtractedIngredient[]; steps: ExtractedStep[] }
export interface DraftLine {
  key: string; raw: string; name: string
  qtyText: string                       // as written, e.g. "3 cloves"
  qty: number | null; unit: string | null // what will be saved (canonical unit) when linked
  link: { kind: 'item' | 'recipe'; id: string; name: string } | null
  status: LineStatus; reason: string | null   // e.g. "3 cloves — how much is a clove?"
  allergens: string[] | null            // only for unlinked lines; null = not chosen yet
  createdItem?: boolean
}
export interface DraftData {
  name: string; yieldQty: number | null; yieldUnit: string | null; yieldGuessed: boolean
  categoryId: string | null; revenueCenterId: string | null
  lines: DraftLine[]
  method: import('@/lib/recipe-method').MethodStep[]
  guessed: Record<string, { minutes?: true; wait?: true }>  // keyed by MethodStep.key
  siblingHints: Record<string, string>  // line key -> sibling draft title, "Aioli is in this scan — save it first"
}
// amount.ts
export interface AmountItem { dimension: 'MASS' | 'VOLUME' | 'COUNT'; baseUnit: string; eachMeasureQty: number | null; eachMeasureUnit: string | null; densityGPerMl: number | null }
export function parseQty(text: string): number | null
export function resolveAmount(
  ing: ExtractedIngredient,
  item: AmountItem | null,
  learned: { word: string; qty: number; unit: string } | null,
): Pick<DraftLine, 'qty' | 'unit' | 'status' | 'reason'>
```

- [ ] **Step 1: Write the failing tests**
```ts
describe('parseQty', () => {
  it('reads fractions and ranges', () => {
    expect(parseQty('1/2')).toBe(0.5); expect(parseQty('1½')).toBe(1.5)
    expect(parseQty('2-3')).toBe(2.5);  expect(parseQty('250g')).toBe(250)
    expect(parseQty('a pinch')).toBeNull()
  })
})
describe('resolveAmount', () => {
  const kg: AmountItem = { dimension: 'MASS', baseUnit: 'g', eachMeasureQty: null, eachMeasureUnit: null, densityGPerMl: null }
  it('keeps a known compatible unit silently', () =>
    expect(resolveAmount({ raw: '150 g almonds', qty: 150, unit: 'g', name: 'almonds' }, kg, null))
      .toEqual({ qty: 150, unit: 'g', status: 'MATCHED', reason: null }))
  it('converts a count word with the estimate and flags CHECK', () =>
    expect(resolveAmount({ raw: '3 cloves garlic', qty: 3, unit: 'clove', name: 'garlic', estimate: { qty: 15, unit: 'g' } }, kg, null))
      .toEqual({ qty: 15, unit: 'g', status: 'CHECK', reason: '3 cloves — about 15 g, check' }))
  it('uses a learned measure and does not flag', () =>
    expect(resolveAmount({ raw: '3 cloves garlic', qty: 3, unit: 'clove', name: 'garlic' }, kg, { word: 'clove', qty: 5, unit: 'g' }))
      .toEqual({ qty: 15, unit: 'g', status: 'MATCHED', reason: null }))
  it('unmatched lines are left as written', () =>
    expect(resolveAmount({ raw: '1 tsp pimentón', qty: 1, unit: 'tsp', name: 'pimentón' }, null, null))
      .toEqual({ qty: null, unit: null, status: 'NO_MATCH', reason: null }))
  it('no amount stays NO_AMOUNT with qty 0', () =>
    expect(resolveAmount({ raw: 'salt to taste', qty: null, unit: null, name: 'salt' }, kg, null))
      .toEqual({ qty: 0, unit: 'g', status: 'NO_AMOUNT', reason: null }))
  it('count word with no estimate asks', () =>
    expect(resolveAmount({ raw: '1 bunch dill', qty: 1, unit: 'bunch', name: 'dill' }, kg, null).status).toBe('CHECK'))
})
```
- [ ] **Step 2:** `npx vitest run src/lib/__tests__/recipe-scan-amount.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement. Known units via `isKnownUnit`/`canonicalUom` and `dimensionallyCostable(unit, item.baseUnit, bridge)` from `src/lib/uom.ts` (bridge = item's eachMeasure); anything else is a count word (singularise: strip trailing "s"/"es"). Weight↔volume across an item without density → `CHECK` "ml for a weighed item — check".
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit.

### Task 3: Ingredient matching (pure)

**Files:** Create `src/lib/recipe-scan/match.ts` · Test `src/lib/__tests__/recipe-scan-match.test.ts`

**Interfaces:**
- Consumes: `normaliseAliasText` (`src/lib/alias-text.ts`), `similarity` (`src/lib/recipe-match.ts`).
```ts
export interface Candidate { kind: 'item' | 'recipe'; id: string; name: string; active: boolean; mergedIntoId: string | null; usedInRecipes: number; boughtAs: string; supplier: string | null }
export interface MatchResult { best: Candidate | null; confidence: 'HIGH' | 'MEDIUM' | 'NONE'; options: Candidate[] /* top 5, best first */ }
export function matchIngredient(name: string, raw: string, candidates: Candidate[], aliases: Map<string, { kind: 'item' | 'recipe'; id: string }>): MatchResult
```
Rules: alias hit (by `normaliseAliasText(name)` then of `raw`) → HIGH. Exact normalised name → HIGH. Else score with `similarity`; ≥0.85 HIGH, ≥0.5 MEDIUM, below → NONE (options still returned). Inactive candidates are dropped; a candidate with `mergedIntoId` is replaced by its target if present, else dropped.

- [ ] **Step 1: Failing tests:** `'alias wins over fuzzy'` ("sherry vin" alias → Sherry Vinegar, HIGH); `'exact name is HIGH'` ("Olive Oil Extra Virgin"); `'close guess is MEDIUM'` ("garlic" vs Garlic Peeled / Garlic Whole → best Garlic Peeled when it has more `usedInRecipes`, MEDIUM); `'nothing close is NONE but returns options'` ("pimentón" vs Smoked Paprika); `'prep recipes are candidates'` ("romesco" → recipe House Romesco); `'inactive and merged are never offered'` (Review Focus 3).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5:** Commit.

### Task 4: Reading the files with Claude

**Files:**
- Modify: `src/lib/invoice-ocr.ts` — `export` `resolveAnthropicKey` and `compressImageForClaude` (no behaviour change).
- Create: `src/lib/recipe-scan/to-text.ts`, `src/lib/recipe-scan/extract.ts`, `src/lib/recipe-scan/parse.ts`
- Modify: `package.json` (add `mammoth`)
- Test: `src/lib/__tests__/recipe-scan-parse.test.ts`

**Interfaces — Produces:**
```ts
// to-text.ts
export async function docxToText(buf: Buffer): Promise<string>          // mammoth.extractRawText
export function sheetToText(buf: Buffer): string                         // XLSX.read → each sheet as CSV, "## <sheet>" headers
// parse.ts
export function parseExtraction(input: unknown): ExtractedRecipe[]       // validates the tool input; drops recipes with no ingredients AND no steps; clamps minutes to 0..1440
export class NotARecipeError extends Error {}
// extract.ts
export const RECIPE_SCAN_MODEL = 'claude-sonnet-5-5'
export async function extractRecipes(src: { images?: Buffer[]; pdf?: Buffer; text?: string }): Promise<ExtractedRecipe[]>  // throws NotARecipeError when parse returns []
```
Approach: one `messages.create` call with a single tool `record_recipes` (input schema mirrors `ExtractedRecipe[]`) and `tool_choice: { type: 'tool', name: 'record_recipes' }`. Images via `compressImageForClaude`; PDF as a `document` base64 block (copy the shape from `extractInvoiceFromPdf`); text inline. The prompt must say: keep `raw` exactly as written; split method paragraphs into one action per step; name phases from the method ("Roast", "Peel & toast"); `minutesStated`/`waitStated` true only when the page gives that time; give `estimate` (grams or ml) for count words like clove/bunch/handful; every separate recipe is its own entry; `categoryHint` is a short word ("Sauces").

- [ ] **Step 1: Failing tests (parse only — no network):** `'parses a two-recipe payload'`; `'drops empty recipes and throws NotARecipeError when none left'` (Review Focus 1); `'clamps minutes and coerces numeric strings'` (`"15"` → 15, `-3` → 0, `99999` → 1440); `'missing raw falls back to name'`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement the three files; `npm i mammoth`. **Step 4:** Run → PASS; `npm run build` passes. **Step 5:** Commit.

### Task 5: Building a draft (pure) — method, matching, amounts, sibling hints

**Files:** Create `src/lib/recipe-scan/build-draft.ts`, `src/lib/recipe-scan/method.ts` · Test `src/lib/__tests__/recipe-scan-draft.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 types/functions; `newStepKey`, `validateMethod` (`src/lib/recipe-method.ts`).
```ts
// method.ts
export function toMethod(steps: ExtractedStep[]): { method: MethodStep[]; guessed: DraftData['guessed'] }
// build-draft.ts
export interface DraftContext { candidates: Candidate[]; aliases: Map<string, { kind: 'item' | 'recipe'; id: string }>; measures: Map<string, { word: string; qty: number; unit: string }> /* key `${itemId}:${word}` */; items: Map<string, AmountItem>; categories: { id: string; name: string }[]; revenueCenterId: string | null; siblingTitles: string[] }
export function buildDraft(r: ExtractedRecipe, ctx: DraftContext): DraftData
export function rematchDraft(d: DraftData, ctx: DraftContext): DraftData   // re-runs matching on NO_MATCH lines only; drops links whose id is no longer in ctx.candidates
```
Rules: `toMethod` copies `phase`, `minutes`, `wait` (`{ minutes, note }` when `waitMinutes ≥ 1`); `guessed[key].minutes = true` when `!minutesStated && minutes != null`, same for wait; if the last step has a wait, append `{ text: 'Label and date.', phase: <last phase> }`; result passes `validateMethod`. `buildDraft`: HIGH match → link + `resolveAmount`; MEDIUM → link + status `CHECK` (reason "Close guess — check"); NONE → `NO_MATCH`, `link: null`, `allergens: null`, and if `name` matches a `siblingTitles` entry (similarity ≥ 0.85) set `siblingHints[key]`. Yield: if missing, `yieldGuessed: true`, `yieldQty: null`. Category: case-insensitive match of `categoryHint` to `categories`, else null.

- [ ] **Step 1: Failing tests:** `'stated times are not guessed, estimated ones are'`; `'a trailing wait gets a Label and date step'` and the result passes `validateMethod`; `'medium match becomes CHECK'`; `'no match leaves allergens unchosen'` (`allergens === null`); `'sibling recipe gets a hint'` ("1 cup Aioli" with sibling "Aioli"); `'rematch links a saved sibling and drops a vanished item'` (Review Focus 4); `'unknown category stays null'`.
- [ ] **Step 2–5:** Run FAIL → implement → PASS → commit.

### Task 6: Scan routes, save transaction, learning

**Files:**
- Modify: `src/lib/uploadthing.ts` — add `recipeScanUploader` (image 16MB×10, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv`; middleware `await requireSession('MANAGER')`).
- Create: `src/lib/recipe-scan/save-rules.ts` (pure), `src/lib/recipe-scan/context.ts` (loads `DraftContext` from Prisma)
- Create routes:
  - `src/app/api/recipe-scans/route.ts` — `GET` (my open scans + drafts summary for the Reading list), `POST { files: {url,fileName,fileType}[], revenueCenterId }` → creates scan `READING`, fires `/process` without awaiting (as invoices do).
  - `src/app/api/recipe-scans/[id]/process/route.ts` — `POST`, `maxDuration = 300`: load files via `loadBuffer`, group (images together; each PDF/doc/sheet alone), `extractRecipes`, `buildDraft` per recipe with `siblingTitles` = all recipe names in the scan, write drafts, status `READY`; `NotARecipeError` or any error → `ERROR` with `error: "Couldn't read this — try again with the whole page in the frame."`. Stuck `READING` > 5 min → `ERROR` on the next `GET` (copy invoice rule).
  - `src/app/api/recipe-scans/[id]/route.ts` — `GET` scan + drafts + files; `DELETE` discards the scan (blobs deleted with `deleteFileBlobs` unless any recipe has `sourceScanId = id`).
  - `src/app/api/recipe-scans/drafts/[draftId]/route.ts` — `GET` (runs `rematchDraft` on load), `PATCH { data: DraftData }` (validated shape; 409 if not `OPEN`).
  - `src/app/api/recipe-scans/drafts/[draftId]/save/route.ts` — `POST`.
  - `src/app/api/recipe-scans/candidates/route.ts` — `GET ?q=` → `Candidate[]` (active items not PREPD + active PREP recipes, `boughtAs` from the item's purchase unit, top supplier from its primary offer, `usedInRecipes` count). MANAGER only.
  - `src/app/api/recipes/[id]/original/route.ts` — `GET`, `requireSession()` (any role): `{ files: {fileName,fileType,fileUrl}[] }` for `recipe.sourceScanId`, else 404.
- Tests: `src/lib/__tests__/recipe-scan-save-rules.test.ts`, `src/app/api/recipe-scans/__tests__/save.test.ts` (mock `@/lib/auth`, `@/lib/prisma`, `@/lib/recipeCosts`, `@/lib/prep-sync` with `vi.hoisted`, like `src/app/api/recipes/__tests__/delete-guard.test.ts`).

**Interfaces:**
```ts
// save-rules.ts
export function saveBlockers(d: DraftData, existingNames: string[]): string[]   // [] = can save
```
Blockers (exact copy): `"2 lines need a check"` (count of `CHECK`), `"Add the yield"`, `"Pick a category"`, `"Choose allergens for 1 unlinked line"` (count of `link === null && allergens === null`), `"A recipe called House Romesco already exists"` (case-insensitive).

Save route, in one `prisma.$transaction`: flip draft `OPEN → SAVED` with `updateMany({ where: { id, status: 'OPEN' } })` and 409 if count 0 (Review Focus 5); create the PREP recipe (same field rules and PREPD-item creation as `POST /api/recipes`, `sourceScanId`, `method`); create every `RecipeIngredient` (`inventoryItemId`/`linkedRecipeId` from `link`, else `customName = name`, `qtyBase` = `qty ?? 0` for linked lines, for unlinked lines `qtyBase = parseQty(qtyText) ?? 0` and `unit = qtyText` minus the number, `allergens` for unlinked lines, `notes = raw`); upsert `RecipeTextAlias` for every linked line whose match the chef changed or confirmed (`useCount += 1`); upsert `ItemCountMeasure` for every line where the chef edited a count-word weight (per-unit = qty ÷ count). After the transaction: `resyncPrepRecipe(recipe.id)`, `syncPrepItemFromRecipe(recipe.id)`, then `rematchDraft` + persist for the other `OPEN` drafts of the scan. Returns `{ recipeId }`.

- [ ] **Step 1: Failing tests:** save-rules — each blocker string above, and `[]` for a clean draft. Save route — `'MANAGER only'` (STAFF → 403); `'creates recipe, lines, aliases in one go'`; `'second save of the same draft is 409'`; `'unlinked line keeps its words and allergens'`; `'no-amount linked line saves qty 0'`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm run build` shows every new route as `ƒ (Dynamic)`.
- [ ] **Step 5:** Commit. **Then stop and ask Joshua** (plain English, risk first) before applying Task 1's migration to the live database.

### Task 7: Unlinked-line allergens and "no price yet" in costing

**Files:** Modify `src/lib/recipeCosts.ts` (`computeRecipeCost`, `fetchRecipeWithCost` union), `src/app/api/recipes/route.ts` (inline allergen union ~line 190), `src/app/api/recipes/[id]/ingredients/route.ts` + `[ingredientId]` PATCH if present (accept `allergens` on custom lines), `src/components/recipes/shared.tsx` (`IngredientRow`) · Test `src/lib/__tests__/recipeCosts.test.ts` (extend)

**Interfaces — Produces:** `IngredientWithCost.allergens` = `ing.allergens` for custom lines; new `IngredientWithCost.unpriced: boolean` (`true` when linked to an item whose `pricePerBaseUnit` is 0).

- [ ] **Step 1: Failing tests:** `'custom line allergens reach the recipe'` (custom "Pimentón" with `['Sulphites']` → recipe allergens include Sulphites, and so does `syncPrepToInventory`'s written set); `'unpriced item line is flagged'`.
- [ ] **Step 2–4:** FAIL → implement → PASS. In `IngredientRow` show a neutral pill "No price yet" when `unpriced`, and allergen tick-boxes for custom lines (managers only, same `ALLERGENS` list from `src/lib/allergens.ts`).
- [ ] **Step 5:** Commit.

### Task 8: Capture — Scan button, upload, phone scanner, Reading list

**Files:**
- Modify: `src/app/recipes/page.tsx` — "Scan recipe" button beside "New recipe", shown when `atLeast(role, 'MANAGER')` (`useUser` from `src/contexts/UserContext.tsx`, `atLeast` from `src/lib/roles.ts`); the Reading list above the recipe list when the manager has open scans.
- Modify: `src/hooks/useNativeScan.ts` — extract the upload half into `uploadScanPages(pages: string[], uploader: 'invoiceUploader' | 'recipeScanUploader')` so both features share it; invoice behaviour unchanged.
- Create: `src/components/recipes/scan/ScanCaptureSheet.tsx`, `src/components/recipes/scan/ScanReadingList.tsx`

Behaviour per design-system **ScanCapture**: phone → native scanner (`scanDocument()` from `src/lib/capacitor.ts`), web → `CameraCapture` multi-page, desktop → drop zone + Choose file (`useUploadThing('recipeScanUploader')`, images through `compressImageFile`). On upload → `POST /api/recipe-scans` with `revenueCenterId = useRc().activeRcId`. Reading list rows (ActionRow grammar): file name, pill READING / READY "6 recipes found" / ERROR "Couldn't read" + Retry; polls `GET /api/recipe-scans` every 4 s while any scan is `READING` (route sets `Cache-Control: no-store`). Each READY draft row links to `/recipes/scan/[draftId]`.

- [ ] **Step 1:** Build; `npm run build` passes; `npm test` still green (invoice scan tests unchanged).
- [ ] **Step 2:** In the browser (dev, `DEV_AUTH_BYPASS`): upload the two sample sources Joshua named — a cookbook-page photo and a Claude-written PDF — and see READY with the right recipe count. Screenshot.
- [ ] **Step 3:** Commit.

### Task 9: Review screen

**Files:**
- Create: `src/app/recipes/scan/[draftId]/page.tsx`, `src/components/recipes/scan/{ReviewHead,CostStrip,IngredientList,IngredientPicker,CreateItemForm,MethodReview,AllergenChoice}.tsx`

Behaviour (look = the design-system components of the same names):
- **ReviewHead**: crumbs `RECIPES · SCAN · <FILE> · <N> PAGES`, editable name, lede "Read **7 ingredients** and **5 steps**. **2 need you** before it can be costed." (green "Every line is sorted" when none), category pill (`GET /api/recipes/categories?type=PREP&rcId=`), yield qty + unit (`PREP_YIELD_UNITS`, CHECK pill when `yieldGuessed`), Discard, `→ Save recipe` disabled with the `saveBlockers` list shown under it.
- **CostStrip**: lines costed (matched & priced) / total, batch cost "so far" via `lineCost` on the client from candidate pricing returned by the draft GET, per yield unit.
- **IngredientList**: rows per IngredientMatchRow — index, item name, pill, `read as "…"`, cost or "—" + "not costed" / "no amount" / "no price yet", one CTA (gold "Pick item" on the first NO_MATCH, "Confirm" on CHECK, "Change" otherwise); editable amount; sibling hint text.
- **IngredientPicker**: bottom sheet on phone / expanded row on desktop per FuzzyPicker, search via `/api/recipe-scans/candidates?q=`; footer "Create item", "Keep uncosted".
- **CreateItemForm**: name (pre-filled) + unit select from `UOM_GROUPS`; `POST /api/inventory` with `dimension` from `dimensionOf(unit)`, a one-link chain in that unit, `pricing` omitted (DB default 0), `isStocked: true`; on success link the line (`createdItem: true`, cost shows "no price yet").
- **AllergenChoice**: for every unlinked line — the 11 `ALLERGENS` as tick chips + "No allergens"; writes `allergens` (`[]` for "No allergens").
- **MethodReview**: phases + steps per MethodStep (edit text/phase/minutes/wait, reorder, split, merge, delete); GUESSED warn pill on guessed times, "from page" meta otherwise; editing a guessed time clears its flag.
- **Original**: desktop right column `ImageViewerV2` with the scan's files; phone "See original" button opens it full-screen.
- Autosave: debounce 800 ms → `PATCH` draft. Save → `POST …/save` → toast "Recipe saved — House Romesco is in the Recipe Book and on the prep list." → navigate to `/recipes?item=<recipe inventoryItemId>`.

- [ ] **Step 1:** Build page and components; `npm run build` + `npm run lint` pass.
- [ ] **Step 2:** Browser check at desktop and mobile (375 px): the Romesco-style sample — fix one CHECK, pick an item for a NO MATCH, create an item, tick allergens on a kept-uncosted line, edit a guessed time, save. Confirm the recipe opens with its method phases, costs, "No price yet" on the new item, its allergens, and appears on the prep list. Screenshots.
- [ ] **Step 3:** Commit.

### Task 10: "See original" on saved recipes + wrap-up

**Files:** Modify `src/components/recipes/shared.tsx` (`RecipePanel`): when the recipe has `sourceScanId`, a "See original" link (all roles) that loads `GET /api/recipes/[id]/original` and opens `ImageViewerV2`. Ensure `GET /api/recipes` / recipe detail returns `sourceScanId`.

- [ ] **Step 1:** Route test `'any signed-in role can list originals'` (STAFF → 200) and `'404 without a scan'`.
- [ ] **Step 2–4:** FAIL → implement → PASS; browser check as STAFF (cook sees the link, no prices elsewhere).
- [ ] **Step 5:** `npm test`, `npm run build`, `npm run lint` all pass. Commit. Open the PR; explain to Joshua per CLAUDE.md (plain English, live / not live, one Before/After).
