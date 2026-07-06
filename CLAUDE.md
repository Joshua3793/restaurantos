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

`postinstall` runs `prisma generate && node scripts/copy-pdf-worker.cjs` — a fresh `npm install` is enough to get a working Prisma client and the pdf.js worker; if PDF preview breaks after a dependency change, suspect the worker copy.

## Architecture

**Fergie's OS** is a restaurant back-office platform: inventory management, recipe costing, invoice scanning, prep lists, stock counts, sales, and reports.

Stack: Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind CSS · Lucide icons · Recharts.

### Page → API map

| Page (`src/app/`) | API prefix |
|---|---|
| `/today` | mobile home, role-routed (`src/components/mobile/today/`); desktop bounces to `/pass` (manager) or `/count` (staff) |
| `/pass` | manager dashboard — `/api/insights/*`, `/api/invoices/alerts`, `/api/prep/items`, `/api/toast/sync-sales` |
| `/inventory` | `/api/inventory`, `/api/categories`, `/api/suppliers`, `/api/storage-areas` |
| `/invoices` | `/api/invoices/sessions` (multi-step upload → OCR → review → approve) |
| `/recipes` (PREP) | `/api/recipes?type=PREP` |
| `/menu` (MENU) | `/api/recipes?type=MENU` |
| `/prep` | `/api/prep/*` (tasks, items, logs, settings, generate, sync-from-recipes) |
| `/preshift` | `/api/prep/items` (+ `src/components/preshift/`) |
| `/count` | `/api/count/sessions` |
| `/sales` | `/api/sales` |
| `/temps` | `/api/temps/units`, `/api/temps/readings` (+ `src/components/temps/`) |
| `/end-of-day` | `/api/eod/*` (close, checklist, orders, handover, summary, email) |
| `/signals` | `/api/signals` (+ `/refresh`; rules in `src/lib/signals/rules.ts`) |
| `/variance` | `/api/insights/food-cost-variance` |
| `/reports` | `/api/reports/*` |
| `/wastage` | `/api/wastage` |
| `/setup` (ADMIN hub) | sub-pages `general` · `users` · `suppliers` · `categories` · `storage-areas` · `revenue-centers` · `uom` · `toast` · `eod-checklist` → `/api/settings/*`, `/api/suppliers`, `/api/categories`, `/api/storage-areas`, `/api/revenue-centers`, `/api/toast/*`, `/api/eod/checklist`, `/api/locations` |

Old URLs (`/settings`, `/suppliers`, `/revenue-centers`, `/inventory/count`, `/cost`, …) 308-redirect to the v2 IA via the `REDIRECTS` table at the top of `src/middleware.ts` — check there before concluding a route is gone.

### Key data flows

**Invoice processing** (multi-step workflow):
1. Upload files → `InvoiceSession` created (status: UPLOADING → PROCESSING)
2. `POST /api/invoices/sessions/[id]/process` — sends images to Claude OCR (`src/lib/invoice-ocr.ts`), stores raw results as `InvoiceScanItem` rows
3. Fuzzy matcher (`src/lib/invoice-matcher.ts`) correlates each scan item to an `InventoryItem`; learned rules cached in `InvoiceMatchRule`
4. User reviews matches in UI (status: REVIEW)
5. `POST /api/invoices/sessions/[id]/approve` — writes `InvoiceLineItem` rows, updates the matched item's `packChain`/`pricing` (only when the line's supplier is the item's primary offer), upserts the supplier offer, fires `PriceAlert` / `RecipeAlert` for impacted recipes

**Recipe costing** (`src/lib/recipeCosts.ts`):
- `fetchRecipeWithCost(id)` — fetches recipe + resolves linked-recipe costs
- `computeRecipeCost(recipe)` — maps each ingredient: `lineCost = convertQty(qtyBase, unit, inventoryItem.baseUnit) × pricePerBaseUnit`
- `syncPrepToInventory(recipeId)` — after any PREP recipe change, writes the linked `InventoryItem`'s `packChain`/`pricing` so the recipe's computed cost flows through when it is used as an ingredient in other recipes
- Returns `totalCost`, `costPerPortion`, `foodCostPct`, and per-ingredient `lineCost` + `ingredientBaseUnit`

**Unit of measure** — single source of truth: `UNIT_FACTORS` in `src/lib/uom.ts` (canonical unit → base-unit factor + dimension). Everything else derives from it — `UOM_GROUPS` / `convertQty()` / `getUnitGroup()` (uom.ts) and `UNIT_CONV` / `getUnitConv()` / `getUnitDimension()` (utils.ts). **Add new units to `UNIT_FACTORS` only** — historically these were two independent tables that drifted, causing a latent 1000× cost error for L/kg items. `CONTAINER_UNITS` (case, box, …) have no fixed factor and only resolve to base units through an item's pack chain; spelling variants are mapped in `UOM_CANON`.

### The spine — chain-derived `pricePerBaseUnit`

Every cost in the app traces back to one value per item, but it is **computed, not stored**. The source of truth is two Json columns on `InventoryItem`:

- `packChain` — `PackLink[]`, outer→inner (e.g. case → bottle), leaf `per` expressed in the item's `baseUnit`
- `pricing` — `{mode:'PACK', purchasePrice}` (price per top chain link) or `{mode:'RATE', rate, rateUnit}` (catch-weight)

The stored `pricePerBaseUnit` **column has been deleted from the schema**. The canonical algorithm is `pricePerBaseUnit(item)` in [src/lib/item-model.ts](src/lib/item-model.ts) — that file also holds `lineCost`, `stockValue`, `basePerUnit`, `countQty`, `validateChainItem`, and the `PRICING_SELECT` Prisma select fragment. API routes attach the computed value to rows via `withPpb(row)` so client code can keep reading `item.pricePerBaseUnit` — but it is never a column read. Supplier-offer ppb likewise derives via `offerPricePerBase()` in `src/lib/supplier-offers.ts`.

**Rule of thumb when adding a cost number anywhere**: derive at query time from the chain (`withPpb` / `lineCost`); never store a computed price into a column. If you find yourself wanting to cache a cost on a recipe/menu/sales row, you're probably building a divergence bug. (`/api/inventory/repair-prices` is now a deprecated no-op for exactly this reason — a blind recompute would diverge from the chain.)

**Chain mutators** (the only places that write `packChain`/`pricing` on an item):
- [src/app/api/invoices/sessions/[id]/approve/route.ts](src/app/api/invoices/sessions/[id]/approve/route.ts) — **canonical writer**; the only mutation that fires recipe re-cost / alerts
- [src/app/api/inventory/route.ts](src/app/api/inventory/route.ts) / [src/app/api/inventory/[id]/route.ts](src/app/api/inventory/[id]/route.ts) — item create / manual edit (chain built from form input via `src/lib/item-model-form.ts`)
- [src/lib/primary-offer.ts](src/lib/primary-offer.ts) `syncPrimaryOfferToItem` / `setPrimaryOffer` — for items WITH supplier offers, the item's chain mirrors the **primary offer** (sticky, manually chosen). Invoice approve only re-prices when the line's supplier is the primary; switching the primary (inventory drawer) re-prices + re-costs. Items with no offers author their own pricing (these helpers no-op). Invariant enforced by a partial unique index `(inventoryItemId) WHERE isPrimary`.
- [src/lib/recipeCosts.ts](src/lib/recipeCosts.ts) `syncPrepToInventory` (+ `/api/inventory/sync-prepd`, PREP-create in `/api/recipes`) — keeps a PREP recipe's linked item chain in step with its computed cost
- [src/lib/inventory-import.ts](src/lib/inventory-import.ts) / [src/app/api/inventory/import/route.ts](src/app/api/inventory/import/route.ts) — CSV import

**Readers**: dozens of sites. Recipes/menu/prep/wastage/count/variance/sales/cost-chrome all use the derived value for display or `lineCost = convertQty(qty, unit, baseUnit) × pricePerBaseUnit`.

**Live aggregate endpoint**: [src/app/api/insights/cost-chrome/route.ts](src/app/api/insights/cost-chrome/route.ts) returns the four values shown in the app-shell cost chrome (WTD food cost %, target, 7d variance, on-hand). Clicking the value opens [src/components/layout/SpineAuditDrawer.tsx](src/components/layout/SpineAuditDrawer.tsx), powered by [src/app/api/insights/spine-audit/route.ts](src/app/api/insights/spine-audit/route.ts).

**Retained format fields (not legacy debt):** `InventorySupplierPrice.{packQty,packSize,packUOM}`
and `InvoiceMatchRule.invoicePack{Qty,Size,UOM}` are kept deliberately — they store the human
purchase format ("4 × 3 L") the normalized `packChain` collapses into base units. Costing always
derives from the chain; these are display/provenance/learned-format only. Do not "migrate" them to a chain.

### Other subsystems (one-liners — read the code/design doc before touching)

- **Revenue centers & scoping** — `RevenueCenter`, `Location`, `UserScope`, `ItemRevenueCenter`, `StockAllocation`, `StockTransfer` models; helpers in `src/lib/rc-scope.ts`, `rc-schedule.ts`, `rc-vocab.ts`, `rc-colors.ts`, `service-hours.ts`. Recipes/menu/sales/reports are RC-scoped.
- **Toast POS integration** — `/setup/toast` + `/api/toast/*` (sync-sales, sync-menu, items, revenue-centers); `ToastConnection`, `ToastItemMap`, `ToastRevenueCenterMap`, `ToastSyncLog` models.
- **End-of-day close** — `/end-of-day` + `/api/eod/*`; `EodClose`, `EodCheckItem`, `EodCheckEntry` models; `src/lib/eod-close.ts`, `eod-forecast.ts`; checklist configured at `/setup/eod-checklist`.
- **Temperature logging** — `/temps`; `TempUnit`, `TempReading` models; `src/components/temps/`.
- **Signals** — rule-driven operational alerts (`Signal` model, rules in `src/lib/signals/rules.ts`), surfaced at `/signals` and on `/pass`.
- **AI chat** — `src/components/AiChat.tsx`, `/api/chat`; `ChatConversation`/`ChatMessage` models (survive user deletion via `SetNull`).
- **Allergens** — `src/lib/allergens.ts` + `AllergenBadges`; allergens roll up from ingredients to recipes.
- **Mobile shell** — `mobile/` is a Capacitor 5 wrapper (appId `com.fergies.os`, iOS + Android projects, `capacitor-document-scanner` for invoice capture). Web-side glue in `src/lib/capacitor.ts` and `src/components/mobile/`. Commands: `cd mobile && npm run sync / open:ios / open:android`.

The Prisma schema has ~47 models — `prisma/schema.prisma` is the authoritative map when a name above is unfamiliar.

### Shared components

`src/components/recipes/shared.tsx` — single large file containing `RecipeCard`, `RecipePanel`, `CategoryManager`, `IngredientRow`, and related types. Both the Recipe Book page and Menu page import from here.

`src/components/prep/` — feature folder for the prep task board (`PrepTask`/`PrepTaskLog` models): `board/` (`PrepBoard`, `PrepBlock`, `PrepRow`, `PrepBoardDrawer`, `prep-board-utils.ts`) plus `PrepTaskList`, `PrepDrawer`, `PrepDoneSheet`, `PrepShiftBand`, `PrepGetAhead`, `PrepItemForm`, `PrepDetailPanel`, `PrepSettingsModal`, `RecipeCookAlongModal`. Design rationale in `docs/superpowers/plans/2026-06-01-prep-board-redesign.md`.

### Important patterns

**Prisma singleton** — always import from `src/lib/prisma.ts`, never instantiate `PrismaClient` directly.

**API routes** — conventional REST shape: `GET/POST` at `/api/[resource]`, `GET/PATCH/DELETE` at `/api/[resource]/[id]`, action endpoints at `/api/[resource]/[id]/[verb]`.

**Recipe types** — a `Recipe` row has `type: 'PREP' | 'MENU'`. PREP recipes automatically create and sync a linked `InventoryItem` (via `syncPrepToInventory`) so they can be used as ingredients in other recipes. MENU recipes do not.

**PrepSettings singleton** — `PrepSettings` is a single-row table (`id = 'singleton'`); the GET route inserts the row only when it is missing. Categories and stations are stored as `String[]` columns. **Categories are managed by recipe sync** (`/api/prep/sync-from-recipes`) and are not user-editable; **only stations are user-editable** (via `PrepSettingsModal`). The prep item form has no category field — category is inherited from the linked recipe. Default values live in `src/lib/prep-utils.ts` (`PREP_CATEGORIES`, `PREP_STATIONS`) — import from there, never redefine locally.

**Client components** — all interactive pages use `'use client'`. Helper components defined inside a client component body will remount on every render and lose focus/state — always define sub-components at module scope.

**Prisma Decimal fields** — Prisma `Decimal` values (e.g. `variancePct`, `varianceCost`, `pricePerBaseUnit`) are serialized as **strings** in JSON API responses, not JavaScript numbers, even when the TypeScript interface types them as `number`. Always wrap with `Number()` before calling arithmetic methods like `.toFixed()` or doing comparisons. Never call `.toFixed()` on a raw Prisma Decimal field from an API response.

### Auth & roles

Auth is **Supabase Auth**. `src/middleware.ts` protects every non-`/api` route: unauthenticated users are redirected to `/login`, deactivated users to `/login?error=deactivated`. `/login` and `/auth/*` are public. Role gating is read from `user_metadata`: ADMIN-only prefixes are `/setup` (and legacy `/settings`); MANAGER+ prefixes are `/reports`, `/pass`, `/cost`, `/variance`, `/signals`, `/end-of-day` — the authoritative lists are the `ADMIN_PREFIXES` / `MANAGER_PREFIXES` constants at the top of the middleware. Setting `DEV_AUTH_BYPASS=true` skips auth entirely in local dev (hard-gated to non-production; `requireSession` honors the same flag).

- **Roles** — `ADMIN > MANAGER > STAFF` (`Role` enum). Strength compared via `ROLE_RANK` in `src/lib/auth.ts`.
- **API route auth** — call `requireSession(minRole?)` from `src/lib/auth.ts`; it throws `AuthError(401|403)`. Catch it and return `NextResponse.json({ error }, { status })`. API routes are excluded from middleware, so each handler must guard itself.
- **Supabase clients** — `src/lib/supabase/server.ts` (SSR, cookie-bound), `client.ts` (browser), `admin.ts` (service-role, server-only, bypasses RLS — used for inviting users).
- **Two-store sync invariant** — every user is mirrored across **Supabase Auth** (`user_metadata.{role,isActive}`, read by middleware) and the **Prisma `User` row** (`{role,isActive}`, read by `requireSession`). Both stores must be written together on every lifecycle change or the account half-locks (active in one, blocked by the other). `src/lib/users.ts` holds the Supabase-side helpers.
- **User lifecycle** (all ADMIN-only, in `api/settings/users`): invite is **idempotent** (pending account → delete + fresh re-invite; accepted account → reactivate in place, keeps password); `PATCH {isActive}` deactivates/reactivates in both stores (reversible); `DELETE` is a *permanent* hard-delete of both stores (chat history survives via `ChatConversation.userId onDelete: SetNull`). Invite emails flow through `/auth/callback` → `/auth/set-password`; the Supabase "Invite user" template must emit a `{{ .TokenHash }}` link to `/auth/callback`. Full flow details: `docs/superpowers/plans/2026-04-23-auth-multiuser.md` and the callback route.

### Infrastructure gotchas

- **Route handlers must be dynamic.** A `GET` route handler with no `request` parameter and no dynamic API usage is statically prerendered at build time — which makes every non-GET method on that route return **405**, and serves stale build-time data on GET. Any route with a mutating handler (or that must run live) must `export const dynamic = 'force-dynamic'`. Check `npm run build` output: API routes should show `ƒ (Dynamic)`, not `○ (Static)`.
- **pgBouncer transaction mode.** `DATABASE_URL` is a Supabase transaction-mode pooler — it does not support named prepared statements. Prisma ORM calls generally tolerate this, but writes to `text[]` array columns do not: never use `$executeRaw` tagged templates for array writes. Use `$executeRawUnsafe` / `$queryRawUnsafe` with hand-built literal SQL (see `toPgTextArray` in `src/app/api/prep/settings/route.ts`). When a route mixes ORM and raw SQL and fails intermittently in production, suspect this.

### Mobile UX patterns

Pages use a **dual-renderer** pattern for mobile vs desktop: a mobile layout block (`block sm:hidden` / `flex sm:hidden`) is placed before the desktop block (`hidden sm:block` / `hidden sm:flex`). Both are mounted in the DOM simultaneously; CSS hides the irrelevant one. Changes to one renderer do not affect the other.

**Bottom sheets** — `fixed inset-0 z-50 flex items-end sm:hidden` with a backdrop div (`fixed inset-0 z-40`) and content panel (`relative bg-white w-full rounded-t-2xl`). The `sm:hidden` on the fixed overlay suppresses it on desktop.

**`cardRefs` namespacing** (`src/app/count/page.tsx`) — when both a desktop and mobile renderer for the same list are mounted, they must write to different ref keys to avoid overwriting each other. Desktop uses `d-${id}`, mobile uses `m-${id}`. Scroll-to-next logic selects the correct prefix at runtime via `window.innerWidth < 640`.

(Component-specific styling fixes — stepper button sizing, left-accent card stripes, ⋯ menu placement — are documented as inline comments at their respective components.)

## Where deeper docs live

Don't re-derive a subsystem's intent from code alone — check for its design doc first:

- `docs/superpowers/plans/` — dated implementation plans for every major feature (~35 files, named `YYYY-MM-DD-<feature>.md`)
- `docs/superpowers/specs/` — the matching design specs (`…-design.md`)
- `design-context/` — UI reference: `01-foundations.md` (tokens, app shell), `02*-components-*.md`, `03*-pages-*.md`, `04-lib.md`
- `docs/app-context-prompt.md` — product overview / positioning (paste-into-AI context doc)
- `docs/design-refs/` — behavioral design references (e.g. end-of-day)

## Environment variables

```
DATABASE_URL                    # Supabase pgbouncer pool URL (Prisma at runtime — transaction mode)
DIRECT_URL                      # Direct PostgreSQL URL (Prisma migrations)
NEXT_PUBLIC_SUPABASE_URL        # Supabase project URL (auth — client & server)
NEXT_PUBLIC_SUPABASE_ANON_KEY   # Supabase anon key (auth — client & server)
SUPABASE_SERVICE_ROLE_KEY       # Supabase service-role key (server-only — user invites, bypasses RLS)
ANTHROPIC_API_KEY               # Claude API — invoice OCR
UPLOADTHING_TOKEN               # File uploads
RESEND_API_KEY                  # Email digests
DIGEST_EMAIL                    # Recipient for the digest email
DIGEST_FROM                     # Digest sender address (must be a verified Resend domain)
NEXT_PUBLIC_APP_URL             # Public URL (used in emails/links and invite redirects)
```

Environment variables are per-environment — values in local `.env` do **not** deploy. Production values must be set in the Vercel project settings, and a redeploy is required for new vars to take effect.
