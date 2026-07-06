# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # dev server at http://localhost:3000
npm run build        # production build (also used to type-check)
npm run lint         # ESLint
npm run seed         # seed the database via prisma/seed.ts

# Database
npx prisma migrate dev --name <description>   # create + apply a migration
npx prisma migrate deploy                     # apply pending migrations (CI/prod)
npx prisma generate                           # regenerate client after schema changes
npx prisma studio                             # browse database in browser
```

There is no test suite — `npm run build` is the only automated correctness check. Run it after any non-trivial change.

`npm install` triggers a postinstall (`prisma generate && node scripts/copy-pdf-worker.cjs`). If Prisma types look stale after a branch switch, run `npx prisma generate`.

## Working style

Process skills (brainstorming, TDD, plan-writing ceremonies) are for multi-file features and gnarly bugs. For small fixes, direct questions, and audits, work directly — no ceremony. Debugging discipline and verification-before-completion always apply: verify every claim against the tree before asserting it, and never document a file, export, or route without checking it exists.

## Architecture

**Fergie's OS** is a restaurant back-office platform: inventory, recipe costing, invoice scanning, prep, stock counts, sales (with nightly Toast POS sync), temps, end-of-day close, and reports.

Stack: Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind CSS · Lucide icons · Recharts.

### Page → API map

| Page (`src/app/`) | API prefix / notes |
|---|---|
| `/today` | mobile home — role-routes to `TodayManager`/`TodayChef` (`src/components/mobile/today/`); desktop bounces to `/pass` (manager) or `/count` (staff) |
| `/pass` (MANAGER+) | manager dashboard — aggregates `/api/insights/*`, `/api/reports/*`, `/api/prep/items`, `/api/invoices/alerts` |
| `/inventory` | `/api/inventory`, `/api/categories`, `/api/suppliers`, `/api/storage-areas` |
| `/invoices` | `/api/invoices/sessions` (multi-step upload → OCR → review → approve) |
| `/recipes` (PREP) | `/api/recipes?type=PREP` |
| `/menu` (MENU) | `/api/recipes?type=MENU` |
| `/prep` | `/api/prep/{items,logs,settings,tasks,sync-from-recipes}` |
| `/preshift` | briefing view over `/api/prep/items` |
| `/count` | `/api/count/sessions` |
| `/sales` | `/api/sales`, `/api/toast/*` |
| `/reports` (MANAGER+) | `/api/reports/*` |
| `/variance` (MANAGER+) | `/api/insights/food-cost-variance` |
| `/signals` (MANAGER+) | `/api/signals` (+ `/refresh`) |
| `/end-of-day` (MANAGER+) | `/api/eod/*` (checklist, close, orders, handover, email, summary) |
| `/temps` | `/api/temps/units`, `/api/temps/readings` |
| `/wastage` | `/api/wastage` |
| `/setup/*` (ADMIN) | hub with 9 sub-pages: categories, storage-areas, suppliers, revenue-centers, users, uom, toast, eod-checklist, general |

### Key data flows

**Invoice processing** (multi-step workflow):
1. Upload files → `InvoiceSession` created (status: UPLOADING → PROCESSING)
2. `POST /api/invoices/sessions/[id]/process` — sends images to Claude OCR (`src/lib/invoice-ocr.ts`), stores raw results as `InvoiceScanItem` rows
3. Fuzzy matcher (`src/lib/invoice-matcher.ts`) correlates each scan item to an `InventoryItem`; learned rules cached in `InvoiceMatchRule`
4. User reviews matches in UI (status: REVIEW)
5. `POST /api/invoices/sessions/[id]/approve` — writes `InvoiceLineItem` rows, upserts `InventorySupplierPrice` offers, and — when the line's supplier is the item's primary offer, or the item has no offers — updates the item's `packChain`/`pricing`; fires `PriceAlert` / `RecipeAlert` and re-costs impacted PREP recipes

**Recipe costing** (`src/lib/recipeCosts.ts`):
- `fetchRecipeWithCost(id)` — fetches recipe + resolves linked-recipe costs
- `computeRecipeCost(recipe)` — maps each ingredient: `lineCost = convertQty(qtyBase, unit, ingredientBaseUnit) × pricePerBaseUnit` (computed — see spine)
- `syncPrepToInventory(recipeId)` — after any PREP recipe change, writes the computed cost back to the linked `InventoryItem` (canonical SI base unit + `{batch → base}` packChain) so it can be used as an ingredient in other recipes
- Returns `totalCost`, `costPerPortion`, `foodCostPct`, and per-ingredient `lineCost` + `ingredientBaseUnit`

**Unit of measure**:
- `src/lib/uom.ts` — `UNIT_FACTORS` is the ONE canonical unit→base conversion table; `convertQty()` canonicalizes units; `UOM_GROUPS` for dropdowns. Used everywhere.
- `src/lib/item-model.ts` — the pricing/pack model (see spine below).
- `src/lib/utils.ts` — legacy client-side helpers (`UNIT_CONV` derived from uom.ts, `calcPricePerBaseUnit`, `deriveBaseUnit`) — still used by the inventory page form. Server-side, `formToChain()` in `src/lib/item-model-form.ts` reproduces `calcPricePerBaseUnit` exactly and is the canonical form→chain path.

### The spine — `pricePerBaseUnit` (computed, not stored)

`pricePerBaseUnit` is still the **single value every cost in the app traces back to** — but it is **no longer a stored column**. `InventoryItem` stores `packChain` (Json array of `{unit, per}` links collapsing the purchase format into a canonical base unit) and `pricing` (Json: price + mode); the $/base-unit value derives from them at read time. [src/lib/item-model.ts](src/lib/item-model.ts) is the source of truth:

- `pricePerBaseUnit(item)` derives $/base from chain + pricing; `lineCost(item, qty, unit)` computes ingredient cost; `basePerUnit`, `stockValue`, `conversionFactor` build on the same chain.
- `PRICING_SELECT` is the Prisma select for the chain fields; `asChainItem(row)` normalizes a row; `withPpb(row)` attaches the computed `pricePerBaseUnit` so API responses still expose it as a field. If an API response contains `pricePerBaseUnit`, it was computed at read time.
- The one legitimate *stored* copy is `InventorySnapshot.pricePerBaseUnit` — a deliberate point-in-time valuation frozen at count finalize.
- Offers derive the same way: `offerPricePerBase()` in `src/lib/supplier-offers.ts` (the cached `InventorySupplierPrice.pricePerBaseUnit` column was dropped).

**Mutators** (the only places that write `InventoryItem.packChain`/`pricing`):
- [src/app/api/invoices/sessions/[id]/approve/route.ts](src/app/api/invoices/sessions/[id]/approve/route.ts) — **canonical writer**; the only spine-write that fires recipe re-cost / alerts. Also creates new items with a fresh chain.
- [src/app/api/invoices/sessions/route.ts](src/app/api/invoices/sessions/route.ts) — session DELETE rolls `pricing` back to each line's `previousPrice` (format untouched).
- [src/app/api/inventory/route.ts](src/app/api/inventory/route.ts) (create) and [src/app/api/inventory/[id]/route.ts](src/app/api/inventory/[id]/route.ts) (edit) — via `formToChain`.
- [src/lib/inventory-import.ts](src/lib/inventory-import.ts) + [src/app/api/inventory/import/route.ts](src/app/api/inventory/import/route.ts) — CSV import / migration.
- [src/app/api/recipes/route.ts](src/app/api/recipes/route.ts) + [src/app/api/inventory/sync-prepd/route.ts](src/app/api/inventory/sync-prepd/route.ts) — create/backfill the linked `InventoryItem` for PREP recipes.
- [src/lib/recipeCosts.ts](src/lib/recipeCosts.ts) `syncPrepToInventory` — writes a PREP recipe's computed cost + yield chain back to its linked item.
- [src/lib/primary-offer.ts](src/lib/primary-offer.ts) `syncPrimaryOfferToItem` / `setPrimaryOffer` — for items WITH supplier offers, the item's chain/pricing is the **primary offer's** value (sticky, manually chosen; invoice approve only re-prices when the line's supplier is primary). Items with no offers author their own pricing (these helpers no-op). Invariant enforced by a partial unique index `(inventoryItemId) WHERE isPrimary`.

**Readers**: everywhere — recipes/menu/prep/wastage/count/variance/sales/cost-chrome all read the computed value for display or `lineCost`. The live cost-chrome strip reads [src/app/api/insights/cost-chrome/route.ts](src/app/api/insights/cost-chrome/route.ts) (WTD food cost %, target, 7d variance, on-hand); clicking it opens [src/components/layout/SpineAuditDrawer.tsx](src/components/layout/SpineAuditDrawer.tsx) backed by [src/app/api/insights/spine-audit/route.ts](src/app/api/insights/spine-audit/route.ts).

**Rule of thumb when adding a cost number anywhere**: don't compute or store a parallel price — derive from the chain at query time (`withPpb` / `lineCost`). If you find yourself wanting to cache a cost on a recipe/menu/sales row, you're probably building a divergence bug. The schema now enforces this: there is no column to write.

**Retained format fields (not legacy debt):** `InventorySupplierPrice.{packQty,packSize,packUOM}` and `InvoiceMatchRule.invoicePack{Qty,Size,UOM}` are kept deliberately — they store the human purchase format the normalized `packChain` collapses into base units. Costing always derives from the chain; these are display/provenance/learned-format only. Do not "migrate" them to a chain.

### Shared components

`src/components/recipes/shared.tsx` — single large file containing `RecipeCard`, `RecipePanel`, `CategoryManager`, `IngredientRow`, and related types. Both the Recipe Book page and Menu page import from here.

`src/components/prep/` — redesigned as a task board: `board/` (`PrepBoard`, `PrepBlock`, `PrepRow`, `PrepLater`, `prep-board-utils.ts`), plus `PrepDrawer`, `PrepDetailPanel`, `PrepItemForm`, `PrepSettingsModal`, and checklist tasks (`PrepTaskList`, `PrepTaskLibrary` — backed by `PrepTask`/`PrepTaskLog`, deliberately OFF the cost spine; completing a task deletes its log).

### Important patterns

**Prisma singleton** — always import from `src/lib/prisma.ts`, never instantiate `PrismaClient` directly.

**API routes** — conventional REST shape: `GET/POST` at `/api/[resource]`, `GET/PATCH/DELETE` at `/api/[resource]/[id]`, action endpoints at `/api/[resource]/[id]/[verb]`.

**Recipe types** — a `Recipe` row has `type: 'PREP' | 'MENU'`. PREP recipes automatically create and sync a linked `InventoryItem` (via `syncPrepToInventory`) so they can be used as ingredients in other recipes. MENU recipes do not.

**PrepSettings singleton** — `PrepSettings` is a single-row table (`id = 'singleton'`); the GET route inserts the row only when it is missing. Categories and stations are stored as `String[]` columns. **Categories are managed by recipe sync** (`/api/prep/sync-from-recipes`) and are not user-editable; **only stations are user-editable** (via `PrepSettingsModal`). The prep item form has no category field — category is inherited from the linked recipe. Default values live in `src/lib/prep-utils.ts` (`PREP_CATEGORIES`, `PREP_STATIONS`) — import from there, never redefine locally.

**Client components** — all interactive pages use `'use client'`. Helper components defined inside a client component body will remount on every render and lose focus/state — always define sub-components at module scope.

**Prisma Decimal fields** — Prisma `Decimal` values (e.g. `variancePct`, `varianceCost`, snapshot `pricePerBaseUnit`) are serialized as **strings** in JSON API responses, not JavaScript numbers, even when the TypeScript interface types them as `number`. Always wrap with `Number()` before calling arithmetic methods like `.toFixed()` or doing comparisons.

### Auth & roles

Auth is **Supabase Auth**. `src/middleware.ts` protects every non-`/api` route: unauthenticated users → `/login`, deactivated users → `/login?error=deactivated`. `/login` and `/auth/*` are public. A `REDIRECTS` table maps legacy paths to the v2 layout (`/settings` → `/setup`, `/suppliers` → `/setup/suppliers`, …). Role gating reads `user_metadata`: `ADMIN_PREFIXES = ['/settings', '/setup']`; `MANAGER_PREFIXES = ['/reports', '/pass', '/cost', '/variance', '/signals', '/end-of-day']`. In non-production, `DEV_AUTH_BYPASS=true` skips auth entirely.

- **Roles** — `ADMIN > MANAGER > STAFF` (`Role` enum). Strength compared via `ROLE_RANK` in `src/lib/auth.ts`.
- **API route auth** — call `requireSession(minRole?)` from `src/lib/auth.ts`; it throws `AuthError(401|403)`. Catch it and return `NextResponse.json({ error }, { status })`. API routes are excluded from middleware, so each handler must guard itself.
- **Supabase clients** — `src/lib/supabase/server.ts` (SSR, cookie-bound), `client.ts` (browser), `admin.ts` (service-role, server-only, bypasses RLS — used for inviting users).
- **Two-store sync invariant** — every user is mirrored across **Supabase Auth** (`user_metadata.{role,isActive}`, read by middleware) and the **Prisma `User` row** (`{role,isActive}`, read by `requireSession`). Both stores must be written together on every lifecycle change or the account half-locks. Supabase-side helpers live in `src/lib/users.ts`.
- **User lifecycle** (ADMIN-only, `api/settings/users`) — invite is idempotent (pending accounts re-invited fresh, accepted ones reactivated in place); `PATCH {isActive}` deactivates/reactivates reversibly in both stores; `DELETE` is a permanent hard-delete (chat history survives via `ChatConversation.userId onDelete: SetNull`). The invite email flows through `/auth/callback` (verifies token, activates the Prisma row, → `/auth/set-password`); the Supabase "Invite user" template must emit a `{{ .TokenHash }}` link pointing at `/auth/callback`.

### Other subsystems

- **Toast POS sync** — `src/lib/toast/*`, `/api/toast/*`, nightly cron `/api/cron/toast-sync` (guarded by `CRON_SECRET`). Toast rows supersede same-day manual `SalesEntry` rows; connection + mappings live in `ToastConnection`/`ToastItemMap`/`ToastRevenueCenterMap`, configured in `/setup/toast`.
- **End-of-day close** — `/end-of-day`: recap, checklist with temps gate, sign-off, snapshot, handover (`EodClose`/`EodCheckItem`/`EodCheckEntry`). Business date is **Pacific local time, not UTC**. Checklist template CRUD lives in `/setup/eod-checklist`.
- **Temps** — `TempUnit`/`TempReading` models, `/api/temps/*`; feeds the EOD checklist gate.
- **Signals** — `Signal` model, `/api/signals` (+ `/refresh`); anomaly feed for `/signals` and the mobile home.
- **Scoping** — 2-level `Location` → `RevenueCenter` (leaf; the write boundary for stock). Access is global `Role` × `UserScope`. Item↔RC visibility via the `ItemRevenueCenter` join.
- **AI chat** — `/api/chat`, `ChatConversation`/`ChatMessage`.
- **Allergens** — Health Canada priority list (incl. Mustard, Sulphites; coconut is NOT a tree nut here); per-ingredient pills; PREP items inherit via `syncPrepToInventory`.
- **Mobile shell** — `src/components/mobile/` (`kit.tsx`, `MobileTabBar`, `today/`); `/today` is the mobile home.

### Where deeper docs live

Check these before re-deriving the intent of a subsystem — most features have a dated design doc:
- `docs/superpowers/plans/` + `docs/superpowers/specs/` — ~100 dated feature designs and specs (56 plans, 47 specs).
- `design-context/*.md` — design foundations, core components, and per-page design notes (`01-foundations` … `04-lib`).
- `docs/app-context-prompt.md` — product overview.
- `docs/design-refs/` — visual references.

### Infrastructure gotchas

- **Route handlers must be dynamic.** A `GET` route handler with no `request` parameter and no dynamic API usage is statically prerendered at build time — which makes every non-GET method on that route return **405**, and serves stale build-time data on GET. Any route with a mutating handler (or that must run live) must `export const dynamic = 'force-dynamic'`. Check `npm run build` output: API routes should show `ƒ (Dynamic)`, not `○ (Static)`.
- **pgBouncer transaction mode.** `DATABASE_URL` is a Supabase transaction-mode pooler — it does not support named prepared statements. Prisma ORM calls generally tolerate this, but writes to `text[]` array columns do not: never use `$executeRaw` tagged templates for array writes. Use `$executeRawUnsafe` / `$queryRawUnsafe` with hand-built literal SQL (see `toPgTextArray` in `src/app/api/prep/settings/route.ts`). When a route mixes ORM and raw SQL and fails intermittently in production, suspect this.

### Mobile UX patterns

Pages use a **dual-renderer** pattern for mobile vs desktop: a mobile layout block placed before the desktop block, both mounted simultaneously with CSS hiding the irrelevant one. Older pages split at `sm:` (`block sm:hidden` / `hidden sm:block`); redesigned pages (prep, count, today) split at `md:` — check the page you're editing before assuming the breakpoint.

**Bottom sheets** — `fixed inset-0 z-50 flex items-end sm:hidden` with a backdrop div (`fixed inset-0 z-40`) and content panel (`relative bg-white w-full rounded-t-2xl`). The `sm:hidden` on the fixed overlay suppresses it on desktop.

**`cardRefs` namespacing** (`src/app/count/page.tsx`) — when both a desktop and mobile renderer for the same list are mounted, they must write to different ref keys to avoid overwriting each other. Desktop uses `d-${id}`, mobile uses `m-${id}`; scroll-to-next logic selects the prefix at runtime from `window.innerWidth`.

(Component-specific styling fixes — stepper button sizing, left-accent card stripes, ⋯ menu placement — are documented as inline comments at their respective components.)

## Environment variables

```
DATABASE_URL                    # Supabase pgbouncer pool URL (Prisma at runtime — transaction mode)
DIRECT_URL                      # Direct PostgreSQL URL (Prisma migrations)
NEXT_PUBLIC_SUPABASE_URL        # Supabase project URL (auth — client & server)
NEXT_PUBLIC_SUPABASE_ANON_KEY   # Supabase anon key (auth — client & server)
SUPABASE_SERVICE_ROLE_KEY       # Supabase service-role key (server-only — user invites, bypasses RLS)
ANTHROPIC_API_KEY               # Claude API — invoice OCR + chat
UPLOADTHING_TOKEN               # File uploads (UPLOAD_PROVIDER selects the upload backend)
CRON_SECRET                     # Guards /api/cron/* (Toast nightly sync) — must be set in Vercel
RESEND_API_KEY                  # Email digests + EOD email
DIGEST_EMAIL                    # Recipient for the digest email
DIGEST_FROM                     # Digest sender address (must be a verified Resend domain)
NEXT_PUBLIC_APP_URL             # Public URL (used in emails/links and invite redirects)
DEV_AUTH_BYPASS                 # 'true' skips auth in non-production only
```

Environment variables are per-environment — values in local `.env` do **not** deploy. Production values must be set in the Vercel project settings, and a redeploy is required for new vars to take effect.
