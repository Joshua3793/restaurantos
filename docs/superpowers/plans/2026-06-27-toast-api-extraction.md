# Toast API — Data Extraction Summary

_Written 2026-06-27. Supersedes the earlier SFTP/CSV pivot: REST API access is now available, so we pull sales directly from the Toast Orders API. The data model is already Toast-shaped (`ToastConnection`, `ToastItemMap`, `ToastSyncLog`, `RevenueCenter.toastGuid`) — this is wiring, not schema design._

## Decisions (locked)

- **Access:** Standard API access, **read-only**, client-credentials. Sufficient for sales pull.
- **Sync model:** Nightly **Vercel Cron** — pull prior business day's orders, write one `SalesEntry` per RC per day (matches existing daily granularity).
- **Food split:** Compute **precise food vs non-food** from line items (classify menu groups), replacing the flat `foodSalesPct = 0.7`.

## ⚠️ LIVE ACCESS SCOPE — verified against prod 2026-06-27

Probed our actual credentials against `ws-api.toasttab.com`. **The Config API is blocked;
the published Menus API is not.** This reshapes the item/RC mapping strategy (below).

| Endpoint | Status | Notes |
|---|---|---|
| `POST /authentication/v1/authentication/login` | ✅ 200 | token `expiresIn=86400`, but treated as ~1h (50min cap + 401-refresh) |
| `GET /restaurants/v1/restaurants/{guid}` | ✅ 200 | name **"Fergie's Café"**, tz **America/Los_Angeles** |
| `GET /orders/v2/ordersBulk` | ✅ 200 | the sales data — 86 orders on businessDate 20260626 |
| `GET /menus/v2/menus` | ✅ 200 | **published** menu: 6 menus / 21 groups / 180 items, each `guid`+`name` |
| `GET /menus/v2/metadata` | ✅ 200 | `lastUpdated` — cheap change-detection before re-pulling menus |
| `GET /cashmgmt/v1/entries` | ✅ 200 | bonus (deposits) — not needed for sales |
| `GET /config/v2/*` (menuItems, menuGroups, **revenueCenters**, diningOptions, salesCategories) | ❌ 403 | "not permitted to access this resource" |
| `GET /labor/*`, `GET /stock/*` | ❌ 403 | not granted |

**Verified GUID join:** order `selection.item.guid` (`525abc55…`) matches a `menuItem.guid`
in `/menus/v2/menus` exactly ("Side Sausage" / group "Sides" / menu "BRUNCH"). The item
identity link is sound.

**Verified RC GUID in orders:** `order.revenueCenter.guid = b853f7e2-048b-4c21-8f16-ebd90b98df61`
(one of CAFE/Catering — name not resolvable via API since `config/revenueCenters` is 403).

## The Toast APIs we actually use

| API | Endpoint | Purpose | Cadence |
|---|---|---|---|
| Authentication | `POST /authentication/v1/authentication/login` | OAuth2 token (client id/secret in body). `Toast-Restaurant-External-ID` header scopes each call. | Token refresh (~1h) |
| **Menus (published)** | `GET /menus/v2/menus` (+ `/metadata`) | MenuItem **GUIDs + names + group/menu structure** → seed `ToastItemMap` and food/bev classification. **Replaces the blocked Config API.** | On `metadata.lastUpdated` change |
| Orders | `GET /orders/v2/ordersBulk` | Actual sales: checks + line-item selections (qty, price); also the **only** source of revenue-center GUIDs | Nightly cron |

## `ordersBulk` mechanics

- Query: `businessDate=YYYYMMDD` (creation date) **or** `startDate`/`endDate` ISO 8601 (modification time — use this to catch late voids/edits).
- Pagination: `page` + `pageSize` (**max 100**); follow RFC-5988 `next` link headers.
- Rate limit: **5 requests / location / second**.
- Headers: `Authorization: Bearer <token>` + `Toast-Restaurant-External-ID: <restaurant GUID>`.

## Field extraction → app mapping

| Toast field | → App | Notes |
|---|---|---|
| `order.businessDate` (int yyyymmdd) | `SalesEntry.date` | convert to DateTime |
| `order.revenueCenter.guid` | `RevenueCenter` via `toastGuid` | location/RC link |
| `check.guestCount` | `SalesEntry.covers` | sum across checks in window |
| `selection.item.guid` | `ToastItemMap.toastItemGuid` → `recipeId` | **identity link** (stable across renames) |
| `selection.itemGroup.guid` | menu-group classification | drives food/non-food split |
| `selection.displayName` | `ToastItemMap.toastName` | human ref / unmatched display |
| `selection.quantity` | `SaleLineItem.qtySold` | aggregate per recipe per day |
| `selection.price` | per-line net revenue (post-discount, pre-tax) | menu-engineering $ |
| `check.amount` | `SalesEntry.totalRevenue` basis | net-sales starting point |

## Net sales rules (Toast bakes most in)

Start from `check.amount` (already net of discounts + service charges; **excludes** tax + gratuity), then:

- **Skip orders** where `voided` / `deleted` / `excessFood` is true.
- **Skip voided checks.**
- Subtract: deferred items (`deferred=true`, gift cards), `selectionType=HOUSE_ACCOUNT_PAY_BALANCE`, fundraising service charges (`serviceChargeCategory=FUNDRAISING_CAMPAIGN`), and `refund.refundAmount` (exclude `tipRefundAmount`).

## Two real problems (rest is mechanical)

1. **Identity = GUID, not name.** Replace the fuzzy name matcher in `src/app/api/sales/import/route.ts` with GUID lookup via `ToastItemMap`. First sync seeds the map from the **Menus API** (`/menus/v2/menus`, since Config is 403); reuse the existing fuzzy matcher as a **one-time suggestion engine** for an admin "map these items" review. After mapping, the GUID link is permanent. Items sold but no longer on the published menu are caught from order traffic (upsert `toastName` from `displayName`, `lastSeenAt`).

2. **Food/non-food split.** Classify Toast menu **groups/menus** (`selection.itemGroup`, resolved to a name via the Menus API) as food vs non-food. Live data makes this concrete: food groups = Brunch/Sides/Sauces/Kids/Features/Breakfast/Snacks/Lunch/Dinner/Weddings; non-food = Hot Drinks/Juice/Soda/Non-Alc/Cocktails/Draught/Wine/Spirits/Liqueur/Beverage. Compute real food sales per day → replaces flat `foodSalesPct`. Needs group→class storage.

3. **RC names not in API.** `config/revenueCenters` is 403, so we only ever see RC **GUIDs** in order traffic. The mapping UI must list distinct `revenueCenter.guid` values discovered from recent orders and let the admin label each → `RevenueCenter.toastGuid`. Only ~2 (CAFE/Catering).

## Proposed sync architecture (for the implementation plan)

1. **Toast client** (`src/lib/toast/client.ts`) — ✅ **BUILT + live-verified 2026-06-27**. auth + token cache (50min cap, 401-refresh), `Toast-Restaurant-External-ID` header, throttle (250ms ≈ 4/s), paginated `ordersBulk`, menus (`fetchMenus`/`fetchMenuMetadata`/`flattenMenuItems`), `testConnection()`. Verify route `GET /api/toast/test` (ADMIN).
2. **Menu sync + RC discovery** — ✅ **BUILT + live-verified 2026-06-27**. `src/lib/toast/menu-sync.ts`: `syncToastMenu()` pulls `/menus/v2/menus` → upserts `ToastItemMap` (GUID+name+group+menu, `recipeId` preserved); `menuChangedSince()` gates re-pull on `/menus/v2/metadata.lastUpdated`; `discoverRevenueCenters()` sweeps recent orders → persists distinct RC GUIDs to **`ToastRevenueCenterMap`**; `setRevenueCenterMappings()` labels them. Food/non-food classifier in `src/lib/toast/food-classify.ts`. Routes: `POST /api/toast/sync-menu`, `GET|POST /api/toast/revenue-centers` (all ADMIN). **Live result: 178 items seeded; 3 RC GUIDs persisted (all unmapped).**
3. **Mapping review UI** — ✅ **BUILT + browser-verified 2026-06-27**. `/setup/toast` (ADMIN): live connection card, RC mapping (all 3 → CAFE, editable), menu-sync button, and item→recipe list with food/bev tags, fuzzy/exact suggestions, search, filters (Food-to-map / Unmapped / Mapped / All), per-row select + "Accept all suggestions". Shared matcher extracted to `src/lib/recipe-match.ts` (sales import refactored to use it). Lib `src/lib/toast/item-mapping.ts`; route `GET|PATCH /api/toast/items`. Setup hub gained a Toast card. Verified: PATCH persists (mapped 0→1, counts update live). ⚠️ schema change requires dev-server restart (stale Prisma client → 500).
4. **Nightly cron** (`/api/cron/toast-sync`) — ✅ **BUILT + live-verified 2026-06-27**. `src/lib/toast/sales-sync.ts`: `syncBusinessDay(yyyymmdd)` pulls orders, skips voided/deleted/excessFood orders + voided/deleted checks + voided/deferred/ignore selections, nets selection prices (post-discount, pre-tax), splits food via `classifyGroup(item→toastGroup)`, routes by `ToastRevenueCenterMap`, upserts one `SalesEntry`(source='toast') + `SaleLineItem`s per RC, writes `ToastSyncLog` + `ToastConnection`. LA-tz date helpers (`priorBusinessDateInt`). Cron auth via `CRON_SECRET` bearer or ADMIN session. `vercel.json` cron `0 13 * * *` (≈5–6am LA, after 4am closeout). **Live result (2026-06-26): 86 orders → CAFE $6944.98, 83.2% food, idempotent (3 runs = 1 row).** ⚠️ covers=0 (Toast guestCount not populated). ⚠️ DEPLOY: set `CRON_SECRET` in Vercel env.
5. **Backfill + manual controls** — ✅ **BUILT + browser-verified 2026-06-27**. `runToastBackfill(fromInt,toInt)` + `GET /api/cron/toast-sync?from=&to=` (or `?date=`). `/setup/toast` "Sales sync" card: last-sync status badge (from `GET /api/toast/status` → ToastConnection + last log), "Sync yesterday" button, and backfill date-range inputs. Verified: clicking Sync yesterday re-ran 2026-06-26 → "CAFE: $6,944.98 · 83.2% food · 1 lines · 65 unmatched", status timestamp updated.

## STATUS: Phases 1–5 COMPLETE. Only deploy step remains: set `CRON_SECRET` in Vercel env so the scheduled cron authenticates.

## Connection facts (confirmed 2026-06-27)

- **Auth:** `POST https://ws-api.toasttab.com/authentication/v1/authentication/login`
  with body `{ clientId, clientSecret, userAccessType: "TOAST_MACHINE_CLIENT" }` → Bearer token,
  **1h TTL** (cache + refresh on 401).
- **clientId:** `fGlURKVh0Cs1P9ekVyAVRr5TnGPOfdxA` (secret in env only).
- **Structure:** **single Toast restaurant**, CAFE/Catering are **internal revenue centers**.
  → one `Toast-Restaurant-External-ID`; sync once/night and split orders by
  `order.revenueCenter.guid`, mapped to app `RevenueCenter.toastGuid`. Discover the RC GUIDs
  from the Config API on first connect; confirm mapping in UI.
- **Env vars:** `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_API_HOST`, `TOAST_RESTAURANT_GUID`.

## Open items to resolve during planning

- **Timezone:** restaurant is **America/Los_Angeles**. The nightly cron's "yesterday" and any
  `businessDate` math must be computed in LA local time, not the server's UTC — else we pull the
  wrong day near midnight. (Toast `businessDate` is already restaurant-local.)
- Where menu-group food/non-food classification lives (new column vs config table). Live groups
  listed above give a concrete seed list.
- Unmatched-item handling: still credit `SalesEntry.totalRevenue`, hold line items until mapped (don't silently drop sold qty).
- RC labelling UX: discover distinct `revenueCenter.guid` from recent orders → admin labels each.
- Idempotency: re-running a day must upsert, not duplicate (unique `(date, revenueCenterId, source, periodType)` already enforces this for `source='toast'`).

## Resolved 2026-06-27 (live)

- ✅ `TOAST_RESTAURANT_GUID` = `841b94fe-b36a-43b5-b7f3-4998fd1daa0a` ("Fergie's Café", Brackendale BC,
  currency **CAD**, **closeoutHour=4** (4am LA), firstBusinessDate **20250908**), in `.env`.
- ✅ Env vars set: `TOAST_CLIENT_ID`, `TOAST_CLIENT_SECRET`, `TOAST_API_HOST`, `TOAST_RESTAURANT_GUID`.
- ✅ Toast client built + verified against prod (auth, restaurant, menus, ordersBulk all 200).
- ✅ Phase 2 built + verified: 178 `ToastItemMap` rows; 3 `ToastRevenueCenterMap` rows.

## ⚠️ Revenue-center reality (found Phase 2)

**3 Toast revenue centers, not 2.** 90-day sweep (7,962 orders) → exactly 3 RC GUIDs, all active daily,
all café brunch/coffee patterns (none distinctly catering):
- `b853f7e2-048b-4c21-8f16-ebd90b98df61` — 90d:3850 / 14d:381
- `3459ef85-27ff-4cc7-a62d-7a0d90b9bb70` — 90d:2499 / 14d:528
- `212406cd-22bf-4cc2-9c86-9fc490163140` — 90d:1568 / 14d:504

App has 2 RCs (CAFE, CATERING) → mapping is **many-to-one** → new join table
**`ToastRevenueCenterMap`** (toastGuid unique → revenueCenterId nullable); `RevenueCenter.toastGuid`
single column **superseded** (retained, unused, drop later).

✅ **RESOLVED 2026-06-27 (user):** the 3 Toast revenue centers are just physical locations/areas of the
café — **all 3 → CAFE** (mapped live). **CATERING stays MANUAL** (PDF invoices + manual entry); the Toast
sync must NEVER write CATERING `SalesEntry` rows. So the nightly cron aggregates all 3 Toast RC GUIDs into
a single CAFE `SalesEntry` per day (`source='toast'`), leaving CATERING's `source='manual'` untouched.

## Migrations applied (live, via `prisma db execute` + `migrate resolve`)

- `20260627120000_toast_item_map_group` — `ToastItemMap.toastGroup`, `toastMenu`
- `20260627130000_toast_revenue_center_map` — new `ToastRevenueCenterMap` table

## Sources

- [Authentication & restaurant access](https://doc.toasttab.com/doc/devguide/authentication.html)
- [Standard API access](https://doc.toasttab.com/doc/devguide/devApiAccessUserGuide.html)
- [Orders API overview](https://doc.toasttab.com/doc/devguide/portalOrdersApiOverview.html)
- [Get multiple orders / ordersBulk](https://doc.toasttab.com/doc/devguide/apiOrdersGetDetailedInfoAboutMultipleOrders.html)
- [Order object summary](https://doc.toasttab.com/doc/devguide/apiOrdersOrderObjectSummary.html)
- [Net sales calculation](https://doc.toasttab.com/doc/devguide/apiOrdersNetSalesCalculation.html)
- [Configuration API / menu info](https://doc.toasttab.com/doc/devguide/menu_information_config_api.html)
