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

## Architecture

**Fergie's OS** is a restaurant back-office platform: inventory management, recipe costing, invoice scanning, prep lists, stock counts, sales, and reports.

Stack: Next.js 14 App Router · TypeScript · Prisma + PostgreSQL (Supabase) · Tailwind CSS · Lucide icons · Recharts.

### Page → API map

| Page (`src/app/`) | API prefix |
|---|---|
| `/inventory` | `/api/inventory`, `/api/categories`, `/api/suppliers`, `/api/storage-areas` |
| `/invoices` | `/api/invoices/sessions` (multi-step upload → OCR → review → approve) |
| `/recipes` (PREP) | `/api/recipes?type=PREP` |
| `/menu` (MENU) | `/api/recipes?type=MENU` |
| `/prep` | `/api/prep/items`, `/api/prep/logs`, `/api/prep/settings` |
| `/count` | `/api/count/sessions` |
| `/sales` | `/api/sales` |
| `/reports` | `/api/reports/*` |
| `/wastage` | `/api/wastage` |

### Key data flows

**Invoice processing** (multi-step workflow):
1. Upload files → `InvoiceSession` created (status: UPLOADING → PROCESSING)
2. `POST /api/invoices/sessions/[id]/process` — sends images to Claude OCR (`src/lib/invoice-ocr.ts`), stores raw results as `InvoiceScanItem` rows
3. Fuzzy matcher (`src/lib/invoice-matcher.ts`) correlates each scan item to an `InventoryItem`; learned rules cached in `InvoiceMatchRule`
4. User reviews matches in UI (status: REVIEW)
5. `POST /api/invoices/sessions/[id]/approve` — writes `InvoiceLineItem` rows, updates `pricePerBaseUnit` on each `InventoryItem` via `calcPricePerBaseUnit()`, fires `PriceAlert` / `RecipeAlert` for impacted recipes

**Recipe costing** (`src/lib/recipeCosts.ts`):
- `fetchRecipeWithCost(id)` — fetches recipe + resolves linked-recipe costs
- `computeRecipeCost(recipe)` — maps each ingredient: `lineCost = convertQty(qtyBase, unit, inventoryItem.baseUnit) × pricePerBaseUnit`
- `syncPrepToInventory(recipeId)` — after any PREP recipe change, writes computed cost back to the linked `InventoryItem` so it can be used as an ingredient in other recipes
- Returns `totalCost`, `costPerPortion`, `foodCostPct`, and per-ingredient `lineCost` + `ingredientBaseUnit`

**Unit of measure** — two parallel systems that must stay in sync:
- `src/lib/uom.ts` — `UOM_GROUPS` (Weight/Volume/Count), `convertQty()`, `getUnitGroup()` — used client-side and in recipe costing
- `src/lib/utils.ts` — `UNIT_CONV` map, `calcPricePerBaseUnit()`, `deriveBaseUnit()`, `getUnitDimension()` — used in inventory pricing and invoice approve

`pricePerBaseUnit` formula (must use `calcPricePerBaseUnit` — missing the unit conversion factor causes 1000× price inflation for L/kg items):
```
purchasePrice / (qtyPerPurchaseUnit × packSize × getUnitConv(packUOM))
```

### Shared components

`src/components/recipes/shared.tsx` — single large file containing `RecipeCard`, `RecipePanel`, `CategoryManager`, `IngredientRow`, and related types. Both the Recipe Book page and Menu page import from here.

`src/components/prep/` — feature folder: `PrepItemForm`, `PrepItemRow`, `PrepDetailPanel`, `PrepKpiStrip`, `PrepSettingsModal`.

### Important patterns

**Prisma singleton** — always import from `src/lib/prisma.ts`, never instantiate `PrismaClient` directly.

**API routes** — conventional REST shape: `GET/POST` at `/api/[resource]`, `GET/PATCH/DELETE` at `/api/[resource]/[id]`, action endpoints at `/api/[resource]/[id]/[verb]`.

**Recipe types** — a `Recipe` row has `type: 'PREP' | 'MENU'`. PREP recipes automatically create and sync a linked `InventoryItem` (via `syncPrepToInventory`) so they can be used as ingredients in other recipes. MENU recipes do not.

**PrepSettings singleton** — `PrepSettings` is a single-row table (`id = 'singleton'`); the GET route inserts the row only when it is missing. Categories and stations are stored as `String[]` columns. **Categories are managed by recipe sync** (`/api/prep/sync-from-recipes`) and are not user-editable; **only stations are user-editable** (via `PrepSettingsModal`). The prep item form has no category field — category is inherited from the linked recipe. Default values live in `src/lib/prep-utils.ts` (`PREP_CATEGORIES`, `PREP_STATIONS`) — import from there, never redefine locally.

**Client components** — all interactive pages use `'use client'`. Helper components defined inside a client component body will remount on every render and lose focus/state — always define sub-components at module scope.

**Prisma Decimal fields** — Prisma `Decimal` values (e.g. `variancePct`, `varianceCost`, `pricePerBaseUnit`) are serialized as **strings** in JSON API responses, not JavaScript numbers, even when the TypeScript interface types them as `number`. Always wrap with `Number()` before calling arithmetic methods like `.toFixed()` or doing comparisons. Never call `.toFixed()` on a raw Prisma Decimal field from an API response.

### Auth & roles

Auth is **Supabase Auth**. `src/middleware.ts` protects every non-`/api` route: unauthenticated users are redirected to `/login`, deactivated users to `/login?error=deactivated`. `/login` and `/auth/*` are public. Role gating is read from `user_metadata`: `/settings` is ADMIN-only, `/reports` is MANAGER+.

- **Roles** — `ADMIN > MANAGER > STAFF` (`Role` enum). Strength compared via `ROLE_RANK` in `src/lib/auth.ts`.
- **API route auth** — call `requireSession(minRole?)` from `src/lib/auth.ts`; it throws `AuthError(401|403)`. Catch it and return `NextResponse.json({ error }, { status })`. API routes are excluded from middleware, so each handler must guard itself.
- **Supabase clients** — `src/lib/supabase/server.ts` (SSR, cookie-bound), `client.ts` (browser), `admin.ts` (service-role, server-only, bypasses RLS — used for inviting users).
- **Invite flow** — `POST /api/settings/users` calls `inviteUserByEmail` with `redirectTo` → `/auth/callback`. The callback verifies the token (`verifyOtp` for `token_hash`, or `exchangeCodeForSession` for `code`), buffers the emitted cookies and attaches them to the redirect response, activates the Prisma `User` row, then redirects to `/auth/set-password`. The Supabase "Invite user" email template must emit a `{{ .TokenHash }}` link pointing at `/auth/callback`.

### Infrastructure gotchas

- **Route handlers must be dynamic.** A `GET` route handler with no `request` parameter and no dynamic API usage is statically prerendered at build time — which makes every non-GET method on that route return **405**, and serves stale build-time data on GET. Any route with a mutating handler (or that must run live) must `export const dynamic = 'force-dynamic'`. Check `npm run build` output: API routes should show `ƒ (Dynamic)`, not `○ (Static)`.
- **pgBouncer transaction mode.** `DATABASE_URL` is a Supabase transaction-mode pooler — it does not support named prepared statements. Prisma ORM calls generally tolerate this, but writes to `text[]` array columns do not: never use `$executeRaw` tagged templates for array writes. Use `$executeRawUnsafe` / `$queryRawUnsafe` with hand-built literal SQL (see `toPgTextArray` in `src/app/api/prep/settings/route.ts`). When a route mixes ORM and raw SQL and fails intermittently in production, suspect this.

### Mobile UX patterns

Pages use a **dual-renderer** pattern for mobile vs desktop: a mobile layout block (`block sm:hidden` / `flex sm:hidden`) is placed before the desktop block (`hidden sm:block` / `hidden sm:flex`). Both are mounted in the DOM simultaneously; CSS hides the irrelevant one. Changes to one renderer do not affect the other.

**Bottom sheets** — `fixed inset-0 z-50 flex items-end sm:hidden` with a backdrop div (`fixed inset-0 z-40`) and content panel (`relative bg-white w-full rounded-t-2xl`). The `sm:hidden` on the fixed overlay suppresses it on desktop.

**`cardRefs` namespacing** (`src/app/count/page.tsx`) — when both a desktop and mobile renderer for the same list are mounted, they must write to different ref keys to avoid overwriting each other. Desktop uses `d-${id}`, mobile uses `m-${id}`. Scroll-to-next logic selects the correct prefix at runtime via `window.innerWidth < 640`.

(Component-specific styling fixes — stepper button sizing, left-accent card stripes, ⋯ menu placement — are documented as inline comments at their respective components.)

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
