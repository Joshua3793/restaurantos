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

**PrepSettings singleton** — `PrepSettings` is a single-row table (upserted on every read). Categories and stations are stored as `String[]` columns. Default values live in `src/lib/prep-utils.ts` (`PREP_CATEGORIES`, `PREP_STATIONS`) — import from there, never redefine locally.

**Client components** — all interactive pages use `'use client'`. Helper components defined inside a client component body will remount on every render and lose focus/state — always define sub-components at module scope.

## Environment variables

```
DATABASE_URL          # Supabase pgbouncer pool URL (used by Prisma at runtime)
DIRECT_URL            # Direct PostgreSQL URL (used by Prisma for migrations)
ANTHROPIC_API_KEY     # Claude API — invoice OCR
UPLOADTHING_TOKEN     # File uploads
RESEND_API_KEY        # Email digests
DIGEST_EMAIL          # Recipient for daily digest emails
NEXT_PUBLIC_APP_URL   # Public URL (used in emails/links)
```
