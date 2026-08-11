# Inventory price audit

A read-only audit of every active `InventoryItem`: each item is priced off the
pack-chain spine (`pricePerBaseUnit`), normalised to $/kg · $/L · $/each, and
compared against British Columbia price bands.

Nothing here writes to the database.

## What to read

| File | What it is |
|---|---|
| `index.html` | The interactive review tool — filter by severity/category, search, tick items off. Open it in a browser. |
| `PRICE-REVIEW.md` | The same findings as a readable document. |
| `price-drift-report.csv` | The flagged items, for sorting in a spreadsheet. |
| `inventory-price-audit.csv` | Every item with its computed price, pack chain and anomalies. |

The `*.json` files are pipeline intermediates and are gitignored — they are
inputs to the page build, not deliverables. Re-run the pipeline to recreate them.

## The three checks

**1. Pack chain vs supplier offer** (`audit-offer-pack-mismatch.ts`) — the only
check that involves no market judgement. An item's `packChain` is compared with
its primary `InventorySupplierPrice.{packQty,packSize,packUOM}`. Both are written
by the same invoice-approve path, so they must agree; where they disagree, one is
wrong. For **PACK**-priced items the chain total is the cost divisor, so the
$/unit is off by exactly that ratio. For **RATE**-priced items the rate sets the
price directly — the cost is *correct* and only counts/stock are affected. The
two are reported separately; do not "fix" a RATE item's price.

**2. Market bands** (`market-benchmarks-bc.ts`, `audit-price-drift.ts`) — ordered
regex → price band per product class. Each band is tagged with its provenance:

- `STATCAN` — Statistics Canada table 18-10-0245-01, *Monthly average retail
  prices for selected products*, GEO = British Columbia. Retail is an upper bound
  on foodservice wholesale, so bands sit near 0.4–1.0× the retail figure. Refresh
  with `curl -sSL https://www150.statcan.gc.ca/n1/tbl/csv/18100245-eng.zip`, then
  update `BENCHMARK_MONTH` in `build-audit-page.ts`.
- `FS` — BC foodservice distributor range. Industry judgement, not a published
  quote. Treat an `FS` flag as worth a look, not as proof.

Only departures of more than **1.25×** outside a band are flagged, so band-edge
noise stays out of the list.

⚠️ Benchmark matching is first-match-wins over an ordered regex list. Generic
patterns must be anchored and specific overrides must come first — "cocoa butter"
once matched a `butter` lettuce pattern, "OIL GRAPESEED" matched `grape`, and
"SWT POTATO" matched `potato`. Add new entries to the overrides block at the top.

**3. Pack-format defects** (`audit-inventory-prices.ts`,
`audit-count-unit-collision.ts`) — structural problems independent of price
level. The significant one is `COUNT_UNIT_COLLISION`: a chain level named with
the same token as the base unit (`each`) shadows the base unit in
`levelBaseUnits()`, so `basePerUnit(item, 'each')` returns the pack size instead
of 1. Valuation is unaffected (`stockValue` uses `pricePerBaseUnit ×
stockOnHand`), which is why it never surfaced on a cost report — but count
screens divide the true quantity by the pack size. Fix by renaming the middle
level to a container token (`case`, `pack`, `tray`).

## Regenerating

Needs `DATABASE_URL`. Run in order — each step reads the previous step's output:

```bash
D=docs/audits
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-inventory-prices.ts $D
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-price-drift.ts $D
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-offer-pack-mismatch.ts $D
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-count-unit-collision.ts $D
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/audit-price-drift-report.ts $D
TS_NODE_PROJECT=tsconfig.scripts.json npx ts-node -r tsconfig-paths/register scripts/build-audit-page.ts $D
```

The page markup lives in `scripts/templates/audit-page.template.html`; the build
step injects the data at the `__DATA__` placeholder. The page must stay
self-contained — a published Artifact runs under a CSP that blocks every external
request, so no CDN fonts, scripts or images.

⚠️ When trimming numbers for the page payload, use significant figures, not fixed
decimals. Rounding a drift ratio to 3 decimals once turned a 106.5× drift into a
displayed 111.1×.
