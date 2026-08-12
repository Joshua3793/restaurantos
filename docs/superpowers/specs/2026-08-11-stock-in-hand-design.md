# Stock in Hand — inventory view + Excel export

**Date:** 2026-08-11
**Status:** Design approved, not implemented

## Problem

`/inventory` shows one stock number: theoretical on-hand, computed on read from the last
count plus every movement since (purchases, prep, wastage, sales depletion). It is the right
default for "what do we have right now", but it is not a number anyone has physically
verified, and there is currently no way to see the verified number instead.

Month-end valuation needs the verified number. The June/July merged count came to
$24,945.95 as counted, against a long-assumed "usual $19k" that was in fact an understated
$27k. A view that reports only what was physically counted — and makes the size of the
unverified remainder explicit — is what prevents that class of error.

## What this builds

A **Stock in Hand** view mode on `/inventory` that reports each item's last physically
counted quantity, valued at current prices, with no theoretical movement applied — plus an
Excel export of exactly that view, carrying the same KPIs and a record of the filters that
produced it.

## Decisions

Each of these was an explicit fork during design. Recorded so they are not silently
re-litigated during implementation.

| Decision | Choice | Rejected |
|---|---|---|
| Quantity source | `InventoryItem.lastCountQty` — frozen at count finalize, unmoved by anything since | `stockOnHand` (count anchor *plus* later manual adjustments) |
| Never-counted items | Shown, blank quantity, $0 value, counted in a Never Counted KPI | Hidden — makes the valuation gap invisible |
| Valuation price | Current `pricePerBaseUnit`, derived from the pack chain at read time | Frozen `InventorySnapshot.pricePerBaseUnit`; or both, with a restated delta |
| UI pattern | View mode, like the inactive-items switch | A pill (pills mean "fewer rows", not "different basis"); a separate route |
| Export scope | Exactly the filtered view, with the filters recorded on the KPI sheet | All active items regardless of filters |

`lastCountQty` is the right source because it is already treated as the physically verified
baseline elsewhere in the codebase — `api/inventory/[id]/stock-movements/route.ts` uses it
for precisely that, and count finalize, quick count, CSV import and declared opening stock
all stamp it.

## KPIs

Five, computed once and used identically by the on-screen strip and the export's KPI sheet.

| KPI | Definition |
|---|---|
| Stock in Hand Value | Σ `lastCountQty` × current `pricePerBaseUnit` |
| Coverage | items with a count / active items in view |
| Never Counted | items with no `lastCountQty` |
| Oldest Count | earliest `lastCountDate` in view |
| Unverified Movement | theoretical stock value − stock in hand value |

Unverified Movement is the load-bearing one: it states how much of the headline number on
`/inventory` is movement nobody has physically confirmed.

## Architecture

### Data

No new fetch for the table. `GET /api/inventory` already returns `lastCountQty`,
`lastCountDate`, `theoreticalStock` and `pricePerBaseUnit` on every row, and the page's
`InventoryItem` interface already declares them. The view mode is client-side derivation
over data the page holds — no round trip, no loading state.

### New modules

**`src/lib/stock-in-hand.ts`** — pure; no Prisma, no React; covered by `npm test`.

- `stockInHandQty(item): number | null` — `lastCountQty` in base units, `null` when never counted
- `stockInHandValue(item): number` — `qty × pricePerBaseUnit`, `0` when null
- `stockInHandKpis(items): { value, counted, total, neverCounted, oldestCountDate, theoreticalValue, unverifiedMovement }`

The page and the export route both call `stockInHandKpis`. Two copies of this arithmetic
would eventually disagree, and the spreadsheet is the copy that leaves the building.

**`src/lib/inventory-list.ts`** — the item-fetch currently inline in the `GET` handler of
`src/app/api/inventory/route.ts`, extracted verbatim: the RC-scoped path, the default-RC
path, the all-RCs aggregate, `resolveScopedRcIds` fail-closed behaviour, and
`getTheoreticalStockMap`. `GET` becomes a thin wrapper. The export route calls the same
function with the same params, so the rows in the file match the rows on screen by
construction rather than by two implementations happening to agree.

This extraction is in scope because without it the export must re-implement ~120 lines of
RC scoping, and any drift surfaces as a spreadsheet that quietly disagrees with the app.

## UI

A toggle beside the existing inactive-items switch. While on:

- **Stock column** — counted quantity, converted base → count UOM via `convertBaseToCountUom`.
  Never-counted rows show `—`, never `0`.
- **Value column** — `lastCountQty × pricePerBaseUnit`.
- **KPI strip** — swaps to the five KPIs above, on both the mobile strip and the desktop row.
- **Basis line under the header, always visible:** "Showing last physically counted
  quantities at current prices. No sales, prep, wastage or purchase movement applied."
  The entire risk of this feature is a counted number being read as a live number; this label
  is the mitigation and is not optional.
- Search, category, supplier, storage area, RC and the pills keep working unchanged.
- The `stock` and `value` sort comparators read the counted basis while the mode is on, so
  sorting sorts what is visible.
- Hidden while the inactive view is on — that view already replaces the KPI row.

### Known limitation: cross-RC

`lastCountQty` is a single global field on `InventoryItem`. An RC-scoped count writes it but
deliberately leaves that RC's `StockAllocation` alone, so on a non-default RC this reads
"last count of this item anywhere", not "last count in this RC".

Making it per-RC means reading `InventorySnapshot` / count lines per RC. That is out of
scope. The limitation is stated in the basis line and in the export provenance rather than
shown silently as an RC-specific number.

## Export

`/api/inventory/export?view=stock-in-hand`, plus the same filter params the list accepts
(`search`, `category`, `supplierId`, `storageAreaId`, `rcId`, `isDefault`,
`includeNonStocked`). One route, one auth guard, one provenance block, branching only on
which sheets it builds. Uses `xlsx`, already a dependency.

**Sheet 1 — KPI Summary**

- Title and generated timestamp
- Basis statement, verbatim from the UI
- Filters applied: search term, category, supplier, storage area, revenue centre and active
  pill, each printed as its resolved name or `all`
- The five KPIs

**Sheet 2 — Stock in Hand**

Item · Category · Supplier · Storage Area · Count Unit · Stock in Hand (count unit) ·
Base Unit · Stock in Hand (base) · Price/Base Unit · Stock in Hand Value · Last Count Date ·
Counted? · Theoretical Stock (base) · Unverified Movement Value

Counted? is `Yes` or `Never`. The last two columns make the headline KPI auditable row by
row. Never-counted rows carry an empty quantity and `Never`, so they read as gaps rather
than as zeros.

Filename: `stock-in-hand-YYYY-MM-DD.xlsx`.

## Auth

`/api/inventory/export` has **no auth guard at all** today — no `requireSession`, no role
check. API routes bypass middleware, so anyone who can reach the URL gets the full priced
catalogue as a spreadsheet. This is the same class of leak as PR #79.

- `requireSession('MANAGER')` on `/api/inventory/export`, covering both views.
- Export button hidden below MANAGER via `useUser()` + `atLeast`, matching `CostChrome`,
  including its default-deny while `role` is null so the button cannot flash during load.
- No new gating on the page's existing KPI cards — see below.

### Flagged, not in scope

`/inventory` carries no `minRole` in `src/lib/nav-items.ts`, so STAFF can reach the page, and
its KPI row already shows Theoretical Stock Value to them. PR #79 fixed the chrome bar, not
the page's own cards. Pre-existing; fixing it is a separate decision.

## Edge cases

- `lastCountQty` is in base units. Quantity display converts to count UOM; value does not.
  Mixing those is the ×1000 unit-magnitude class of bug this codebase has hit before.
- `lastCountQty` is a Prisma `Decimal`, serialized as a string over JSON — `Number()` at the
  boundary, per the project-wide rule.
- Never counted: `—` in the table, blank in the sheet, counted in Never Counted, contributes
  `0` to value.
- Oldest Count is computed over the filtered set only, so it tracks what is on screen.
- Empty view: KPIs render `$0` / `0 / 0` / `—` without crashing.

## Testing

- `src/lib/__tests__/stock-in-hand.test.ts` under vitest: null handling, coverage
  arithmetic, unverified-movement sign, empty set, base-vs-count-unit separation.
- `npm run build` for type-checking, in an isolated worktree — building in the main checkout
  while `next dev` runs produces bogus failures.
- Browser verification of the toggle, the KPI swap and a real downloaded file before the PR
  is called done. PR #80 is still unverified; this should not become the second.

## Out of scope

- Per-RC `lastCountQty` (see cross-RC limitation).
- Frozen `InventorySnapshot` valuation and as-counted-vs-restated comparison.
- Any change to how theoretical stock itself is computed.
- Role-gating the page's existing theoretical KPI cards.
