# Prep Module — Design Spec
**Date:** 2026-04-14  
**App:** Fergie's Kitchen OS (Next.js 14 / Prisma / PostgreSQL)  
**Status:** Approved for implementation

---

## 1. Overview

A dedicated **Prep page** (`/prep`) that acts as the kitchen's daily production board. It answers:

- What needs to be prepped today?
- What is urgent (911)?
- What is low stock?
- What is blocked because ingredients are missing?
- What has already been done?

This module integrates with the existing Recipe Book and Inventory without modifying either.

---

## 2. Architecture Decision

**Approach B — Standalone PrepItem + PrepLog with loose recipe/inventory links.**

- Two new Prisma models: `PrepItem` (master record) and `PrepLog` (daily operational record)
- Existing models (`Recipe`, `InventoryItem`) are referenced but never mutated by prep logic
- Stock (`currentOnHand`) is derived at runtime from linked `InventoryItem.stockOnHand` — never stored in `PrepItem`
- The existing `Recipe.inventoryItemId` bridge is used to resolve inventory stock for recipe-linked items automatically

---

## 3. Data Model

### 3.1 `PrepItem` (new Prisma model)

Master definition of a managed prep item. One row per recurring prep task.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `name` | `String` | Display name |
| `linkedRecipeId` | `String?` | Optional link to `Recipe` |
| `linkedInventoryItemId` | `String?` | Optional direct link to `InventoryItem` for stock |
| `category` | `String @default("MISC")` | e.g. SAUCE, PROTEIN, BAKED, GARNISH |
| `station` | `String?` | e.g. Cold, Hot, Pastry |
| `parLevel` | `Decimal @default(0)` | Target batch quantity |
| `unit` | `String @default("batch")` | Unit for par/on-hand quantities |
| `minThreshold` | `Decimal @default(0)` | Threshold below which = Low Stock |
| `targetToday` | `Decimal?` | Optional today-specific target; overrides par for suggested qty |
| `shelfLifeDays` | `Int?` | Informational only |
| `notes` | `String?` | Chef notes |
| `manualPriorityOverride` | `String?` | `null \| '911' \| 'NEEDED_TODAY' \| 'LOW_STOCK' \| 'LATER'` |
| `isActive` | `Boolean @default(true)` | |
| `createdAt` | `DateTime @default(now())` | |
| `updatedAt` | `DateTime @updatedAt` | |
| **Relations** | `linkedRecipe Recipe?` | |
| | `linkedInventoryItem InventoryItem?` | |
| | `logs PrepLog[]` | |

### 3.2 `PrepLog` (new Prisma model)

One record per prep item per day. Created by "Generate Today's Prep" or on first status change.

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `prepItemId` | `String` | FK → `PrepItem` |
| `logDate` | `DateTime` | Midnight of the target date |
| `status` | `String @default("NOT_STARTED")` | See §5 |
| `requiredQty` | `Decimal?` | Snapshot of suggested qty at generation time |
| `actualPrepQty` | `Decimal?` | What was actually made |
| `assignedTo` | `String?` | Name/initials |
| `dueTime` | `String?` | e.g. "09:00" |
| `note` | `String?` | Per-day note |
| `blockedReason` | `String?` | Auto-populated from ingredient check |
| `inventoryAdjusted` | `Boolean @default(false)` | Whether inventory impact has been applied |
| `createdAt` | `DateTime @default(now())` | |
| `updatedAt` | `DateTime @updatedAt` | |
| **Relations** | `prepItem PrepItem` | |
| **Constraint** | `@@unique([prepItemId, logDate])` | One log per item per day |

---

## 4. Priority System

Priority is computed server-side at query time. Manual override always wins.

### Priority Levels

| Level | Code | Meaning |
|---|---|---|
| 🔴 911 | `'911'` | Urgent — service at risk |
| 🟠 Needed Today | `'NEEDED_TODAY'` | Important for today's service |
| 🟡 Low Stock | `'LOW_STOCK'` | Getting low — make soon |
| ⚪ Optional/Later | `'LATER'` | Healthy stock, no urgency |

### Auto-Priority Logic

```
if manualPriorityOverride is set → use it

else if onHand <= 0 AND parLevel > 0             → '911'
else if targetToday set AND onHand < targetToday → '911'
else if onHand < parLevel                        → 'NEEDED_TODAY'
else if onHand < minThreshold                    → 'LOW_STOCK'
else                                             → 'LATER'
```

`minThreshold` is the *early warning* level — set it **above** par to get a Low Stock heads-up before running below par. Typical usage: `minThreshold = 1.5 × parLevel`.

`onHand` resolution order:
1. `linkedInventoryItemId` → read `InventoryItem.stockOnHand`
2. `linkedRecipeId` → read `Recipe.inventoryItem.stockOnHand` (via `Recipe.inventoryItemId`)
3. Fallback → `0` (treat as unknown / not tracked)

### Suggested Prep Qty

```
base = parLevel - onHand
if targetToday is set: base = max(targetToday - onHand, base)
suggestedPrepQty = max(base, 0)
```

---

## 5. Status System

Status lives on `PrepLog` (today's record). Default is `NOT_STARTED`.

| Status | Label | Colour |
|---|---|---|
| `NOT_STARTED` | Not Started | Gray |
| `IN_PROGRESS` | In Progress | Blue |
| `DONE` | Done | Green |
| `PARTIAL` | Partial | Amber |
| `BLOCKED` | Blocked | Red |
| `SKIPPED` | Skipped | Muted |

Transition actions available per item: **Start → Mark Done / Mark Partial / Mark Blocked / Skip**

---

## 6. Blocked / Ingredient Check

When a `PrepItem` has `linkedRecipeId`:
1. Load recipe ingredients from `RecipeIngredient` with joined `InventoryItem`
2. For each ingredient with `inventoryItemId`, check `InventoryItem.stockOnHand`
3. If any ingredient has `stockOnHand <= 0`, the item is **potentially blocked**
4. `blockedReason` = `"Low stock: [item1, item2]"`
5. This is surfaced as a warning indicator — chef can override and mark as not blocked

---

## 7. Inventory Impact on Completion

When a `PrepLog` transitions to `DONE` or `PARTIAL` **and** `inventoryAdjusted = false`, the system applies a **prep completion transaction** — a single atomic database update that keeps inventory accurate.

This only fires if `PrepItem.linkedRecipeId` is set.

### 7.1 Scale Factor

The recipe defines a canonical batch (e.g. yields 10 kg of smoked brisket from a list of ingredients).  
The prep log records how many units were actually made (`actualPrepQty` in `PrepItem.unit`).

```
If PrepItem.unit = 'batch':
  scale = actualPrepQty                  // 1 batch = 1× the recipe

If PrepItem.unit matches Recipe.yieldUnit:
  scale = actualPrepQty / Recipe.baseYieldQty   // e.g. 7 kg / 10 kg = 0.7×

Otherwise (unit mismatch — no automatic scaling):
  scale = 1  (apply one full batch, surface a warning in the UI)
```

For `PARTIAL`, `actualPrepQty` must be entered by the chef before confirming. The same scale logic applies — it just results in a partial ingredient deduction and a partial yield credit.

### 7.2 Ingredient Deduction

For each `RecipeIngredient` on the linked recipe that has an `inventoryItemId`:

```
deductQty = ingredient.qtyBase × scale
InventoryItem.stockOnHand -= deductQty
```

Sub-recipe ingredients (where `linkedRecipeId` is set on the ingredient) are **not** deducted in v1 — only direct inventory items. This avoids recursive complexity while still covering the common case.

### 7.3 Output Credit

If `Recipe.inventoryItemId` is set (the recipe output is tracked as an inventory item):

```
creditQty = Recipe.baseYieldQty × scale   // in Recipe.yieldUnit
InventoryItem.stockOnHand += creditQty
```

Example: Raw brisket recipe yields 10 kg → `scale = 0.7` → credit 7 kg of "Smoked Brisket" to inventory, deduct all raw ingredients × 0.7.

### 7.4 Idempotency

`inventoryAdjusted` is set to `true` after the transaction. The endpoint checks this flag — re-marking an already-adjusted log as DONE a second time does **not** re-apply the transaction. To re-apply (e.g. chef corrects `actualPrepQty`), there is a **Revert & Reapply** action in the detail panel that:
1. Reverses the previous adjustment (adds ingredients back, subtracts output)
2. Re-applies with the corrected qty
3. Requires the previous `actualPrepQty` to be stored (it is, on the log)

### 7.5 Guardrails

- If `actualPrepQty` is null when marking DONE, prompt the chef to enter qty first
- If a deduction would push `stockOnHand` below zero, still apply it but show a warning ("Inventory went negative — check your stock")
- All adjustments are applied in a single Prisma `$transaction` — partial failures roll back entirely

---

## 8. API Routes

All under `/api/prep/`.

| Method | Route | Action |
|---|---|---|
| `GET` | `/api/prep/items` | List all PrepItems with derived priority, onHand, suggestedQty, today's log |
| `POST` | `/api/prep/items` | Create PrepItem |
| `GET` | `/api/prep/items/[id]` | Single item — full detail with ingredient availability |
| `PUT` | `/api/prep/items/[id]` | Update PrepItem settings |
| `DELETE` | `/api/prep/items/[id]` | Soft-delete (set `isActive = false`) |
| `POST` | `/api/prep/generate` | Generate today's `PrepLog` rows for all active items (idempotent — skips existing) |
| `GET` | `/api/prep/logs` | Get logs for a date (`?date=YYYY-MM-DD`, defaults to today) |
| `POST` | `/api/prep/logs` | Create or upsert a log entry for an item+date |
| `PUT` | `/api/prep/logs/[id]` | Update log status, qty, note, assignedTo — triggers inventory transaction on DONE/PARTIAL |
| `POST` | `/api/prep/logs/[id]/revert` | Reverse a previous inventory adjustment and re-apply with corrected qty |

---

## 9. Page Layout (`/prep`)

### 9.1 Header
- Title: **Prep** | Subtitle: *Daily kitchen production board*
- Buttons: `Generate Today's Prep` · `+ Add Prep Item`

### 9.2 KPI Summary Strip (6 cards)
Total Items · 911 · Needed Today · Low Stock · Done Today · Blocked

### 9.3 Filters
- Search (by name)
- Filter by Priority (`All | 911 | Needed Today | Low Stock | Later`)
- Filter by Status (`All | Not Started | In Progress | Done | Blocked | Partial`)
- Filter by Category
- Filter by Station
- Toggle: Active only (default on)
- Toggle: Today / All Items / Needs Action Only

### 9.4 Main Prep List

Four collapsible priority sections rendered in order:

1. 🔴 **911** — `bg-red-50`, red left border, bold heading
2. 🟠 **Needed Today** — `bg-orange-50`, orange
3. 🟡 **Low Stock** — `bg-amber-50`, amber
4. ⚪ **Optional / Later** — white/gray, muted

Each row displays:
- Item name + linked recipe badge (clickable)
- Category badge · Station chip
- On Hand · Par · Suggested Qty (three numeric chips)
- Priority badge
- Status button (quick-tap to cycle: Not Started → In Progress → Done)
- Blocked indicator (🚫 + tooltip with reason)
- `···` action menu: Start · Mark Done · Mark Partial · Mark Blocked · Skip · Change Priority · Edit · View Recipe

### 9.5 Side Detail Panel (right drawer on row click)
- Name + priority badge
- Status with action buttons (Start / Mark Done / Mark Partial / Mark Blocked / Skip)
- **Actual Prep Qty input** — required before marking Done or Partial (triggers inventory transaction)
- On Hand / Par / Suggested Qty
- Linked recipe (with open button)
- Ingredient availability summary (green ✓ / red ✗ per ingredient, with qty deduction preview)
- **Inventory impact preview**: "Completing this will deduct X kg brisket, credit 7 kg smoked brisket"
- `inventoryAdjusted` indicator: green badge "Inventory Updated" after completion
- **Revert & Reapply** button (appears after adjustment is applied, if qty needs correcting)
- Notes field (editable inline)
- Last prepared date
- Blocked reason (if any)
- Edit Prep Settings button

---

## 10. Creating Prep Items

### Manual (Add Prep Item button)
Form fields:
- Name (required)
- Link to Recipe (optional — searchable dropdown of PREP recipes)
- Link to Inventory Item (optional — if not using recipe link)
- Category
- Station
- Par Level + Unit
- Min Threshold
- Target Today (optional)
- Shelf Life Days (optional)
- Notes

### From Recipe Book (future)
A "Create Prep Item from this recipe" shortcut in the Recipe Book. Out of scope for v1 but the link field makes it trivially addable later.

---

## 11. Navigation

### Desktop Sidebar
Add **Prep** (icon: `ChefHat` or `FlameKindling`) after Count in the kitchen ops cluster.

```
Dashboard
Inventory
Count
→ Prep  ← new
Invoices
...
```

### Mobile
Add **Prep** to the "More" drawer alongside Recipes, Menu, Sales, etc.

---

## 12. Design / Visual System

Follow the existing design system exactly:
- White card panels with `border border-gray-100 shadow-sm rounded-xl`
- `bg-white` for content, section headers use subtle coloured backgrounds per priority level
- Typography: `text-sm`, `font-medium`, `text-gray-800/500/400` scale
- Buttons: `bg-blue-600 text-white` for primary, outline for secondary
- Category badges: reuse `<CategoryBadge />` component
- Priority colours:
  - 911: `bg-red-100 text-red-700` badge, `border-l-4 border-red-500` row
  - Needed Today: `bg-orange-100 text-orange-700`, `border-l-4 border-orange-400`
  - Low Stock: `bg-amber-100 text-amber-700`, `border-l-4 border-amber-400`
  - Later: `bg-gray-100 text-gray-500`, no coloured border

---

## 13. Out of Scope for v1

- Weather / reservation-based forecasting
- Complex labour planning
- Recipe Book "Create Prep Item" shortcut button (schema supports it, UI deferred)
- Bulk status update
- Print prep list
- Push notifications / alerts

---

## 14. Files to Create

### Prisma
- `prisma/schema.prisma` — add `PrepItem` and `PrepLog` models (with `inventoryAdjusted` field)

### API Routes
- `src/app/api/prep/items/route.ts`
- `src/app/api/prep/items/[id]/route.ts`
- `src/app/api/prep/generate/route.ts`
- `src/app/api/prep/logs/route.ts`
- `src/app/api/prep/logs/[id]/route.ts` — includes inventory transaction on DONE/PARTIAL
- `src/app/api/prep/logs/[id]/revert/route.ts` — revert & reapply inventory adjustment

### Pages / Components
- `src/app/prep/page.tsx`
- `src/components/prep/PrepItemRow.tsx`
- `src/components/prep/PrepDetailPanel.tsx`
- `src/components/prep/PrepItemForm.tsx`
- `src/components/prep/PrepKpiStrip.tsx`

### Navigation
- `src/components/Navigation.tsx` — add Prep link

---

## 14. Safe Integration Checklist

- [ ] No existing model is altered (only additions to schema)
- [ ] No existing API route is modified
- [ ] No existing page is modified (except Navigation.tsx)
- [ ] Prep uses existing Prisma client (`@/lib/prisma`)
- [ ] Prep follows existing `'use client'` + fetch pattern
- [ ] Inventory adjustments wrapped in `prisma.$transaction` — atomic, no partial writes
- [ ] `inventoryAdjusted` flag prevents double-application
- [ ] Prisma migration run via `npx prisma db push`
