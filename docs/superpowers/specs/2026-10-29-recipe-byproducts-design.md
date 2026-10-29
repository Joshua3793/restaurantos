# Recipe By-products ("Comes off this batch") — design

Date: 2026-10-29 · Owner: Joshua · Status: draft for approval

## Why

A prep recipe often makes more than one useful thing. A 13 kg raw brisket (Brisket AAA, $256.10) becomes 6 kg of Smoked Brisket, but the same brisket also gives fat (rendered into Beef Tallow → Beef Tallow Aioli) and trim (cooked into Braised Brisket → Brisket Poutine). Today the whole $256.10 lands on the 6 kg of smoked slices, so the Texas Brisket sandwich ($8.29 cost, 29.6 % on a $28 menu price) and Brisket & Eggs are over-costed.

There is a second problem. Brisket Trim ($10.00/kg) and Beef Fat Trim ($3.50/kg) are never bought — no invoice line has ever touched them — yet they carry hand-typed prices that Braised Brisket and Beef Tallow pay. So the same dollar is counted twice: once in the sandwich (via the whole brisket) and again in the poutine (via the trim).

Success: the chef opens Smoked Brisket, adds "2 kg Brisket Trim" and "1.5 kg Beef Fat Trim" under a new **Comes off this batch** box in a few seconds, sees the credit and the new cost per kg straight away, and every dish downstream (sandwich, Brisket & Eggs, poutine, tallow aioli) costs correctly with each dollar counted once.

Example (weights are illustrative — the chef enters the real ones):

| | Before | After |
|---|---|---|
| Smoked Brisket per kg | $43.13 | $38.92 |
| Texas Brisket sandwich | $8.29 | $7.72 |
| Food cost % | 29.6 % | 27.6 % |

(Credits: 2 kg trim × $10.00 + 1.5 kg fat × $3.50 = $25.25; $258.79 − $25.25 = $233.54 ÷ 6 kg.)

## Goals

1. A PREP recipe can list **by-products**: an inventory item + quantity + unit that the batch also produces.
2. Each by-product is credited at **what it would cost to buy** (Joshua's decision): its credit = that item's own current price × quantity, using the same costing as an ingredient line.
3. The recipe's cost (the number every other recipe, report and count reads for that prep) is **ingredients − credits**.
4. Adding a by-product is as easy as adding an ingredient: same item search, same qty/unit inputs, price fills itself in.
5. A **yield bar** shows where the raw weight went (main yield · each by-product · lost), so a typo stands out.
6. Each dollar counts once: the by-product's price is the one number both sides read — the credit on the brisket and the cost in the poutine/tallow.

## Non-goals (v1)

- **Stock movement** (Joshua's decision: costing first, stock next). Finishing a Smoked Brisket batch does NOT yet add trim/fat to stock. That is phase 2, designed separately.
- By-products on MENU dishes. Only PREP recipes. *(My call — dishes don't produce leftovers worth crediting.)*
- Other valuation methods (same $/kg as the main item, or free). Joshua chose "cost to buy".
- A by-product that is itself the output of another prep recipe (e.g. crediting "Braised Brisket"). Only plain inventory items. *(My call — prevents loops where two recipes price each other.)*

## Anti-goals (a failure even if it "works")

- A second, stored price for the by-product. The credit reads the by-product item's live price, exactly as an ingredient line does (the app's spine rule: derive, never store a parallel price).
- A prep recipe whose cost goes below $0 or silently hides credits bigger than the batch.
- A by-product credit that some screens apply and others don't (the recipe editor says $38.92/kg but a report still uses $43.13/kg).
- Anyone below MANAGER able to change a by-product or its price.

## How it works

### Data

New table `RecipeByproduct` (one row per by-product line):

- `id`, `recipeId` (cascade delete with the recipe), `inventoryItemId` (required), `qty` (Decimal), `unit` (String), `sortOrder`, `notes` (optional).

No price column — the credit is derived at read time from the item's chain, like every other cost.

### Valuation — "cost to buy"

- `credit = lineCost(byproductItem, qty, unit)` — the identical function an ingredient line uses (unit conversion, each↔weight bridge, density, dimension-conflict guard). A dimension conflict credits $0 and shows the same warning an ingredient does.
- The price shown in the box is the item's own price. **Editing it from the box edits the item's price** (one number, not a copy):
  - item with **no supplier offers** (Brisket Trim, Beef Fat Trim today): the box shows "$10.00 / kg" editable; saving writes the item's pricing the same way the inventory edit screen does.
  - item **with supplier offers** (it is sometimes bought): the price is read-only in the box, labelled with the supplier ("$10.00/kg · Sysco"), because the primary offer owns it.
- If the item has no price at all, the box asks for one ("What would you pay per kg?") — a $0 credit is never silent.

### Cost maths

- Batch cost shown in the editor: **Ingredients $258.79 − Credits $25.25 = Smoked Brisket $233.54**, then $/kg and $/portion off the net.
- `computeRecipeCost` gains the by-product lines and returns `grossCost`, `byproductCredit`, and `totalCost` = gross − credit. `costPerPortion` and `foodCostPct` use the net. Every reader of `totalCost` therefore gets the net with no change; any reader that sums ingredient `lineCost` itself must be moved to `totalCost` (see "Every cost path" below).
- `syncPrepToInventory` writes the **net** to the linked item, so the spine value every other recipe reads (Smoked Brisket $/g in the sandwich) is the net.
- **Guard:** credits may not exceed the ingredient cost. The recipe editor saves every edit straight away (there is no Save button), so the guard has two halves:
  - adding or editing a by-product row so that credits would exceed the ingredient cost is **rejected** by the server (400, "Credits $X are more than the batch costs $Y — check the weights"), and the row shows that message;
  - if an *ingredient* edit or a price drop later makes credits exceed the cost, the edit still saves, the net is **floored at $0.00**, and the editor shows the same red line until fixed. *(My call — blocking an ingredient edit because of a by-product would be confusing.)*

### Keeping it fresh

- When a by-product item's price changes (box edit, inventory edit, invoice approve), every PREP recipe that lists it as a by-product re-costs, the same way recipes re-cost when an ingredient's price changes (`propagatePrepCostChanges` must find recipes by by-product as well as by ingredient).
- When the main ingredient's price changes (a new Brisket AAA invoice), the smoked brisket absorbs it; the credits stay at the trim/fat item prices. *(Standard by-product costing — the main product carries the swing.)*

### The editor (UX)

In the recipe editor, PREP recipes only, directly under the Ingredients list (MANAGER+):

```
COMES OFF THIS BATCH                                   − $25.25
  Brisket Trim        2   kg    $10.00/kg        − $20.00   ✕
  Beef Fat Trim       1.5 kg    $3.50/kg         −  $5.25   ✕
  + Add a by-product

  Where the 13.3 kg went
  [██████████ Smoked 6 kg ███|█ Trim 2 ██|█ Fat 1.5 █|░░ Lost 3.8 ░░]

  Ingredients $258.79 − credits $25.25 = $233.54 · $38.92/kg
```

- **Empty state:** a single quiet line "+ Something else comes off this batch (fat, trim, bones…)" so recipes without by-products don't grow a big empty box.
- **Adding a row** reuses the ingredient search (inventory items only — prep recipe outputs are filtered out) with the same qty + unit inputs. Unit defaults to the recipe's yield unit (kg here).
- **Create new from the box:** if "Beef Bones" doesn't exist, the search offers "Create 'Beef Bones'", which makes a plain item (weight, no supplier, in the recipe's kitchen) and asks for its $/kg on the row. It is created **not counted** (`isStocked = false`) so cooks don't see it on the count with an expected zero; phase 2 switches it on when by-products start entering stock. *(My call — saves a trip to inventory.)*
- **Yield bar:** shown when the ingredients and outputs are weights (or volumes) that can be added up. Input = sum of weighed ingredients; outputs = main yield + by-products; Lost = the difference. If outputs are more than inputs the bar turns red: "More comes out than goes in — check the weights." Hidden for count-based recipes. *(Bar shape and colours follow the Controla design system.)*
- **Cost summary** at the bottom of the editor shows the three-part sum above; the recipe list/card shows the net.
- **Where it's used, the other side:** in Braised Brisket's ingredient row for Brisket Trim, a small tag "comes off Smoked Brisket" so the chef can see why the trim has a price. *(My call.)*
- Phone: the box stacks like the ingredient list does today.

### Who

- **Seeing:** by-products behave exactly like the rest of the recipe today. The recipe screens hide no money from anyone, so credits are visible wherever ingredient costs already are. *(My call — hiding only the credit is pointless while the net total next to it shows; hiding recipe money from staff is a separate build, if wanted.)*
- **Editing:** adding, changing or removing a by-product, and editing its price from the box, are MANAGER+ (server-enforced), like editing an inventory item's price.

### Which price basis

The editor shows recipe costs on the 30-day average price; the cost written to the prep's own item (what the sandwich, reports and counts read) uses the last price. That gap exists today and is **not** closed by this build. Credits follow the same basis as the ingredients in each place, so each view is self-consistent. The server guard and the $0 floor are computed on the **stored** (last-price) number, because that is the one every dish reads. *(My call.)*

## Data repair alongside

- **Beef Tallow** lists its fat as "1300 each" of Beef Fat Trim. The cost happens to come out right ($4.55) because the each is read as grams, but the unit is wrong. Change it to 1300 g. ⚠️ Live data — needs Joshua's yes at the time.
- Brisket Trim and Beef Fat Trim prices ($10.00/kg, $3.50/kg) were hand-typed. Joshua confirms or corrects them when he first fills the box.

## Every cost path must agree

`computeRecipeCost` (`src/lib/recipeCosts.ts`) is pure — it only sees what the caller loads. Applying the credit there covers the readers that go through `fetchRecipeWithCost`, but not those with their own query or their own sum. The full list, from reading the code:

| Path | Today | Needed |
|---|---|---|
| `fetchRecipeWithCost` / `prefetchRecipes` (`RECIPE_COST_INCLUDE`) | loads ingredients | load by-products (with the item's pricing fields) |
| AVG_30D basis (`costContext`, `prefetchRecipes`) | collects ingredient item ids into `ctx.prices` | also collect by-product item ids, so credits use the same basis as the ingredients |
| `syncPrepToInventory` | writes `totalCost` | none — writes the net automatically once `totalCost` is net |
| Recipe list `GET /api/recipes` | own include → `computeRecipeCost` | add by-products to its include |
| Global search `src/app/api/search/route.ts` | own include → `computeRecipeCost` | add by-products to its include |
| `recalculateRecipeCosts` (`src/lib/recipe-costs.ts`, makes RecipeAlerts on invoice approve / delete) | sums its own lines; finds recipes by ingredient only | subtract credits; also find recipes whose by-product item moved |
| `propagatePrepCostChanges` | reverse index by ingredient + linked recipe | also index by by-product item (`addConsumer(bp.inventoryItemId, r.id)`) |
| Theoretical cost, menu engineering, analytics, signals, linked-prep spine reads | via `fetchRecipeWithCost` or the synced item | none |
| Chat + email digest hand-rolled sums | MENU dishes only, skip linked preps | out of scope (by-products live on PREP recipes; existing gap, unchanged) |
| Recipe Scan drafts | drafts have no by-products | none |
| Recipe scale view `/api/recipes/[id]/scale` | multiplies `totalCost` | none (scales the net); also scale the by-product lines it returns |
| Prep item screen `/api/prep/items/[id]` | shows ingredients and stock, no cost | none |

Write paths that must carry by-products:
- **Save-scale** (`/api/recipes/[id]/save-scale`) copies ingredients scaled by a factor — copy by-products scaled the same way.
- **Recipe delete** — by-product rows cascade with the recipe.
- **Item merge** (`src/lib/item-merge.ts`, `item-merge-exec.ts`) — re-points by-product rows from the merged-away item to the survivor, like ingredient rows.
- **Item delete-if-used check** — an item that is some recipe's by-product counts as "in use" (blocks hard delete, same as an ingredient reference).
- **Editor totals** — the panel recomputes `totalCost = Σ lineCost` in the browser after ingredient edit/delete/swap and never reloads. That would show the gross. The client total must subtract credits (or take the server's recomputed recipe from the response).
- The smaller **PrepRecipeModal** editor shows `totalCost / baseYieldQty` — it reads the net automatically; it does not need the by-product box. *(My call.)*

### API

Following the ingredient endpoints (each edit writes straight away):
- `POST /api/recipes/[id]/byproducts` `{ inventoryItemId, qty, unit }`
- `PATCH /api/recipes/[id]/byproducts/[bpId]` `{ qty?, unit?, notes? }`
- `DELETE /api/recipes/[id]/byproducts/[bpId]`
- Each: `requireSession('MANAGER')`, PREP recipes only (400 on MENU), item must be a plain inventory item (not a prep output, not the recipe's own output), guard above, then `resyncPrepRecipe(id)` and return the recomputed recipe (`fetchRecipeWithCost(id, { basis: 'AVG_30D' })`) so the panel replaces its state.
- Price edit from the box goes through the existing inventory item edit (which already re-costs consumers via `inventory-post-update.ts`), restricted to items with no supplier offers.
- `export const dynamic = 'force-dynamic'` on the new routes.

## Phase 2 (not this build) — stock

When a cook logs a Smoked Brisket batch as done, add the by-products to stock (theoretical) at their credited value, so Braised Brisket's prep suggestion and the count know about the trim. Designed after phase 1 is live and the costs look right.

## Left to the builder

- Component structure inside the recipe editor, following the existing ingredient-row patterns.
- Tests: pure cost maths (credit, guard, net per kg, dimension conflict), propagation by by-product.
