# End-of-Day Phase 3 & 4 Implementation Plan

> Execute via subagent-driven-development. Branch `feat/end-of-day-phase34` off main (has Phase 1+2).

**Goal:** Replace the End-of-day page's remaining placeholders with real features: **Phase 3** (prep-for-tomorrow queue → prep board; below-par order suggestions) and **Phase 4** (naive net-sales forecast → real vs-forecast delta; manual close-out numbers → labour %/prime cost + day-summary gross/comps/discounts; print + email report).

**Feasibility (from exploration):**
- **Prep-for-tomorrow:** zero new backend. `GET /api/prep/items` returns per-item `priority`/`suggestedQty`/`onHand`/`parLevel`/`isOnList` (RC-scoped to session). Queue = `PUT /api/prep/items/{id}` `{isOnList:true}` fanned out (existing "Add all" pattern).
- **Forecast:** ~26wk daily `SalesEntry.totalRevenue` per RC → naive trailing same-weekday avg for **net sales** is feasible. **Covers can't** be forecast (2% populated) — skip.
- **Labour/comps/discounts:** ZERO data source (Toast doesn't supply them) → **manual entry at close**, stored on `EodClose`.
- **Email:** reuse `/api/digest/route.ts` Resend pattern (`new Resend(RESEND_API_KEY)` → `resend.emails.send({from: DIGEST_FROM ?? default, to: DIGEST_EMAIL, subject, html})`, ADMIN-gated).
- **Print:** current button is bare `window.print()` (prints app chrome). Add an `@media print` block + `print:hidden` on chrome (borrow `src/components/recipes/shared.tsx` pattern).
- **Daypart "sales vs forecast":** no intra-day data (SalesEntry is daily) → stays a labelled stub.
- **Order suggestions:** below-par InventoryItem grouped by supplier (see Task 5 — grounded by the purchasing map).

**Tech/verify:** No test suite — `npm run build` + preview verification. node path: `/Users/joshua/Desktop/node-install/node-v20.19.0-darwin-x64/bin`. Restart dev server after `prisma generate`. Migration via pooler workaround (diff → db execute → resolve), additive-only.

---

### Task 1: Schema — manual close-out numbers on EodClose
Add nullable Decimals to `EodClose`: `labourCost`, `grossSales`, `compsVoids`, `discounts` (manager-entered at close). Migration additive-only. `prisma validate` + `generate`.

### Task 2: Forecast lib
`src/lib/eod-forecast.ts` — `netSalesForecast(revenueCenterId, date)`: average `SalesEntry.totalRevenue` for the last 4 matching same-weekday dates strictly before `date` for that RC (UTC-bracketed like reports/dashboard). Return `{ forecast: number|null, basis: number }` (null if <2 basis points).

### Task 3: Summary + close API extensions
- Extend `GET /api/eod/summary` to include `netSalesForecast` (call the lib for the active RC when rcId present; null otherwise).
- Extend `PATCH /api/eod/close` to accept + persist `{ labourCost?, grossSales?, compsVoids?, discounts? }`; include them in `GET /api/eod/close`'s `close` object.

### Task 4: Order-suggestions API
`GET /api/eod/orders?rcId=` — below-par active stocked InventoryItems (on-hand < par) grouped by supplier, each line `{ id, name, onHand, par, unit, suggestedQty, unitPrice, lineCost, supplierName }`; plus per-supplier + grand totals. Read-only. (Grounded by purchasing map.)

### Task 5: Email + print report API
`POST /api/eod/email` (ADMIN) — reuse Resend; build an inline-HTML EOD summary (net sales, covers, food cost, checklist, handover) for the active RC/today; send to `DIGEST_EMAIL`. Print: add `@media print` CSS to the EOD page isolating the report.

### Task 6: EOD page — prep-for-tomorrow + order-suggestions cards
New `CloseDown`-sibling section "Sets up tomorrow": PrepForTomorrow card (fetch /api/prep/items, filter `priority!=='LATER' && !isOnList`, list w/ "Queue to board" bulk PUT) + OrderSuggestions card (fetch /api/eod/orders, grouped by supplier, "Draft order → email/print").

### Task 7: EOD page — forecast delta + manual close numbers
- Net-sales KPI shows vs-forecast delta from `netSalesForecast`.
- Labour KPI + day-summary gross/comps/discounts become editable inputs (seeded from close), debounced PATCH; compute labour % (labourCost/foodSales) + prime cost (foodCost% + labour%). Remove the "est"/placeholder tags for these. Daypart stays a labelled stub.
- Wire Print (clean) + Email buttons.

### Task 8: Pass + verification
Ensure no regressions; full preview verification of all new features.
