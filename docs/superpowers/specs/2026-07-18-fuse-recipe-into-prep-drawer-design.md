# Fuse the recipe cook-along into the Prep item drawer

**Date:** 2026-07-18
**Status:** Approved, ready for implementation

## Problem

Prep currently has two separate surfaces for one job:

- **Item drawer** — mobile `PrepDrawer` (`md:hidden`) shows item context and links out to
  the recipe via a *"Recipe & method → Open recipe"* button; desktop `PrepBoardDrawer`
  (`hidden md:block`) inlines a *static* method + ingredients list. Neither lets the chef
  cook along.
- **Recipe drawer** — `RecipeCookAlongModal`, a centered modal with the rich cook-along:
  an upscale slider, checkable "gather ingredients" (scaled, with sub-recipe links),
  tickable method steps with progress, a cost line, and a "Done · add X" footer that
  completes the prep at the scaled yield.

The recipe modal is opened both from the mobile drawer's link and from the **"Recipe"
button** on rows (mobile + desktop). This means two overlapping surfaces and two separate
completion paths (the drawer's `suggestedQty` prompt vs. the modal's scaled slider yield).

## Goal

Fuse them into one experience: keep the item drawer, embed the full cook-along inside it
(ingredients, method, upscale), and route the Recipe button to the same drawer.

## Approach — one shared recipe section

Extract the cook-along's UI into a single self-contained component,
`src/components/prep/PrepRecipeSection.tsx` (Tailwind, sourced from `RecipeCookAlongModal`'s
body), and embed it in **both** drawers. One source of truth, identical behavior on both
breakpoints, and a straight migration of already-de-risked code.

Rejected alternative: reimplement the cook-along natively in each drawer's idiom (the board
drawer uses semantic CSS classes, the mobile drawer uses Tailwind) — duplicative and
divergence-prone. The board drawer keeps its outer chrome/CSS; the recipe block sits inside
a `.dr-sec` as a self-contained Tailwind island (the cook-along was already Tailwind).

## `PrepRecipeSection` — responsibilities

Renders, migrated from `RecipeCookAlongModal`:

- **Upscale slider** — "Making X {unit} · ×N of base" (0.25×–5× base yield).
- **Cost line** — this-batch $, $/yield, tub count. Skeleton while cost loads.
- **Gather ingredients** — checkable rows, quantities scaled by the slider factor,
  check-all/uncheck-all, out-of-stock pills, sub-recipe links (→ `RecipeViewModal`).
- **Method · tick as you go** — checkable steps with a progress bar. Skeleton while steps load.

**State ownership:**

- The **drawer (parent)** owns `makeQty` (the slider value) because it drives the footer's
  completion action. `PrepRecipeSection` receives `makeQty` + `onMakeQtyChange` (controlled).
- Ingredient checks and step ticks stay **internal** to `PrepRecipeSection` (they don't
  affect completion).
- All of it resets on item/recipe change.

Props (approx): `recipe: RecipeStepsData | null`, `ingredients: IngredientAvailability[]`,
`loading: boolean`, `unit: string`, `makeQty: number`, `onMakeQtyChange(qty)`,
`onOpenSubRecipe?(recipeId, name)`.

## Fused drawer anatomy

Both drawers keep their existing chrome and footers; the recipe **replaces** today's
placeholder treatment.

- **Mobile `PrepDrawer`:** remove the *"Recipe & method → Open recipe"* link **and** the
  separate static "Ingredients" section; embed `PrepRecipeSection` in their place. Keep
  header, impact strip, blocked banner, status row, and stock-context tiles.
- **Desktop `PrepBoardDrawer`:** replace the current static "Method · N steps" and
  "Ingredients" sections with `PrepRecipeSection`. Keep the suggest/par bar, priority
  override, recent history, and footer.

## Unified completion

The upscale slider is the single source of the made-quantity, folding the two completion
paths into one:

- Footer primary action reads **"Done · add {makeQty} {unit}"** and completes at the slider
  value — no separate numeric qty prompt.
- Status rule preserved: `makeQty ≥ suggestedQty → DONE`, else `PARTIAL` (same rule as
  today's `logQty`).
- The standalone **"Log partial"** button is **removed** — the slider covers making
  less/more.
- Otherwise each footer is unchanged: mobile keeps **Start / Stop / Remove / Reopen**;
  desktop keeps **Start / Stop / Edit / Priority override**, and smart-view keeps
  **Add to today** (recipe shown, no "Done" in smart view — matches current behavior).

## Data flow

- `openDrawer` is upgraded to fetch **both** `/api/prep/items/[id]` (ingredient
  availability + stock) **and** `/api/recipes/[id]` (steps, cost, base yield) — exactly what
  `openRecipeModal` does today, folded in, reusing the existing `recipeCache` ref for
  instant paint (item header/stock render immediately; recipe section shows skeletons until
  steps/cost arrive).
- The **Recipe button** on rows (`onOpenRecipe`) is repointed to `openDrawer` so it opens
  the same fused drawer.
- **Sub-recipe peek** (`RecipeViewModal`) is kept, now triggered from inside the drawer and
  stacked above it (z-index above the drawer).

## Retired after fusion

- `RecipeCookAlongModal.tsx` — body migrates into `PrepRecipeSection`; the modal is deleted.
- Page state/handlers: `recipeModal` state, `openRecipeModal`, `onRecipeComplete`,
  `onRecipeStop`, and the modal's render.

Net: one recipe experience, one completion path, fewer moving parts.

## Verification

- `npm run build` (type-check + dynamic-route check).
- Browser preview: open a linked-recipe prep item's drawer on desktop and mobile widths;
  confirm slider scales ingredients + cost, method/ingredient check-off works, sub-recipe
  peek opens, Recipe button opens the drawer, and "Done · add X" completes at the slider qty
  (DONE vs PARTIAL by the suggestedQty rule).
