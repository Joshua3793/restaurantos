# Inventory price audit — BC market comparison

**Scope:** every active inventory item (453) was priced from the pack-chain spine
(`pricePerBaseUnit`), normalised to $/kg, $/L or $/each, and compared against a
British Columbia price band.

- **395** purchased items compared against a BC benchmark (100% of food items;
  the two exclusions are a cleaning chemical and the $0 non-stocked "Water" utility row).
- **58** PREP-linked items derive their cost from a recipe, not a purchase
  price — market comparison does not apply, so they are checked for pack-format defects only.
- **53** items are flagged for manual revision.

**Benchmark sources**

| Tag | Meaning |
|---|---|
| `STATCAN` | Statistics Canada table 18-10-0245-01, *Monthly average retail prices for selected products*, GEO = British Columbia, **June 2026** (latest published). Retail is an upper bound on wholesale, so bands sit at roughly 0.4–1.0× the BC retail figure. |
| `FS` | BC/Vancouver foodservice distributor range (Sysco / Snow Cap / Legends Haul / Two Rivers class). Industry judgement, not a published quote — treat as "worth a look", not proof. |

A price is only flagged when it sits **more than 1.25× outside** the band, so
band-edge noise is excluded.

---

## ⚠️ Pack format conflicts — 26 items

Each item's `packChain` is compared with its primary supplier offer's stated
format (`packQty × packSize packUOM`).

**A disagreement does not by itself mean the cost is wrong.** The item's chain
always equals its primary offer's `packChain` (197/197 verified) — the format
triple is a separate record written from each invoice. So a mismatch means one of
the two is stale, and the data does not say which:

- the **chain** is stale when a supplier changed pack size — approve writes the
  new price over the old format, so the cost IS wrong by the ratio;
- the **triple** is stale when someone edited the item afterwards.

Compare `lastUpdated` on both and use the BC band as the tiebreaker. In this
snapshot the split was an even 16 / 16.

### 19 items where the two disagree on a PACK-priced item

### 7 items where the cost is fine but the pack total is not

These are **RATE**-priced ($/kg set directly), so the unit cost is right. The
wrong pack total corrupts count conversions and stock-on-hand instead.

| Item | Supplier | Offer says | Chain says | Rate (correct) |
|---|---|---|---|---|
| Beef Chuck Flat | Legends Haul | 6 × 4 kg | 1000 base | $27.00/kg |
| Fingerling Potatoes | Sysco | 1 × 12 lb | 453.592 base | $6.45/kg |
| Grana Padano | Sysco | 2 × 4 kg | 1000 base | $29.30/kg |
| Cheddar smoked | Sysco | 1 × 3.4 kg | 1000 base | $34.23/kg |
| Pork Back Ribs | Legends Haul | 1 × 7 kg | 4540 base | $15.90/kg |
| Ground Pork | Legends Haul | 3 × 5 lb | 7500 base | $13.65/kg |
| Flat Iron Peeled 1-2lb Filet LEGENDS | Legends Haul | 1 × 2 lb | 1000 base | $39.90/kg |

---

## 🔴 CRITICAL — 15 items

Cost math is provably wrong here: the item has no price at all, or it is off by
a multiple large enough that no supplier variation explains it.

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **PUFF PASTRY CROISSANT** | BREAD | $18.24/each | $0.8–$3.2/each <sub>FS</sub> | 5.7× over | $18.24/each is 5.7× the top of the BC band ($0.8–$3.2/each) |
| **Sugar icing** | DRY | $0.22/kg | $1–$4/kg <sub>STATCAN</sub> | 4.6× under | $0.22/kg is 4.6× BELOW the bottom of the BC band ($1–$4/kg) — under-costing risk |
| **Apple mustard** | DRY | $0.00/kg | — | — | price is $0 — every recipe using this item under-costs silently |
| **Cracked coriander seed** | DRY | $0.00/kg | — | — | price is $0 — every recipe using this item under-costs silently |
| **Kalamata olive brine** | DRY | $0.00/kg | — | — | price is $0 — every recipe using this item under-costs silently |
| **TRSM Spicy Pork Pepperoni, Cold Smoked** | DRY | $0.00/kg | — | — | price is $0 — every recipe using this item under-costs silently |
| **Yuzu juice** | DRY | $0.00/L | — | — | price is $0 — every recipe using this item under-costs silently |
| **Beef Fat Trim** | MEAT | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **duck fat** | MEAT | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **Farm Squash Zuchinni** | PROD | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **Fennel brew creek** | PROD | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **peaches** | PROD | $0.00/kg | — | — | price is $0 — every recipe using this item under-costs silently |
| **sunchokes** | PROD | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **sweet potato** | PROD | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |
| **thai vhilis** | PROD | $0.00/each | — | — | price is $0 — every recipe using this item under-costs silently |

---

## 🟠 HIGH — 10 items

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **Oysters Kusshi** | FISH | $0.20/each | $0.7–$2.4/each <sub>FS</sub> | 3.5× under | $0.20/each is 3.5× BELOW the bottom of the BC band ($0.7–$2.4/each) — under-costing risk |
| **CHEESE CURD** | DRY | $3.42/kg | $12–$22/kg <sub>FS</sub> | 3.5× under | $3.42/kg is 3.5× BELOW the bottom of the BC band ($12–$22/kg) — under-costing risk |
| **CABBAGE RED FDSVC** | PROD | $12.70/each | $1.5–$5/each <sub>STATCAN</sub> | 2.5× over | $12.70/each is 2.5× the top of the BC band ($1.5–$5/each) |
| **BLUEBERRY CULTIVATED IQF CAN** | FROZEN | $29.77/kg | $5–$12/kg <sub>FS</sub> | 2.5× over | $29.77/kg is 2.5× the top of the BC band ($5–$12/kg) |
| **Chilli Red Thai** | PROD | $93.82/kg | $12–$40/kg <sub>FS</sub> | 2.3× over | $93.82/kg is 2.3× the top of the BC band ($12–$40/kg) |
| **Cucumber Long** | PROD | $3.74/each | $0.5–$1.6/each <sub>STATCAN</sub> | 2.3× over | $3.74/each is 2.3× the top of the BC band ($0.5–$1.6/each) |
| **SPINACH BABY FRESH** | PROD | $42.47/kg | $8–$20/kg <sub>FS</sub> | 2.1× over | $42.47/kg is 2.1× the top of the BC band ($8–$20/kg) |
| **Pineapple** | PROD | $13.63/each | $2.5–$6.5/each <sub>FS</sub> | 2.1× over | $13.63/each is 2.1× the top of the BC band ($2.5–$6.5/each) |
| **TRSM Sour Tuscan Salami** | DRY | $22.08/each | $14–$75/each <sub>FS</sub> | — | item is priced per each but the BC benchmark for this product is per kg — dimension mismatch, likely the wrong dimension on the item |
| **Red Peppers** | PROD | $70.86/each | $3–$9/each <sub>STATCAN</sub> | — | item is priced per each but the BC benchmark for this product is per kg — dimension mismatch, likely the wrong dimension on the item |

---

## 🟡 MEDIUM — 28 items

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **grapefruit** | PROD | $3.60/each | $0.6–$1.8/each <sub>FS</sub> | 2.0× over | $3.60/each is 2.0× the top of the BC band ($0.6–$1.8/each) |
| **MELON WATERMELON SDLS FRESH** | PROD | $27.52/each | $5–$14/each <sub>FS</sub> | 2.0× over | $27.52/each is 2.0× the top of the BC band ($5–$14/each) |
| **Salad Mix O/S** | PROD | $50.68/kg | $9–$26/kg <sub>STATCAN</sub> | 1.9× over | $50.68/kg is 1.9× the top of the BC band ($9–$26/kg) |
| **MELON CANTALOUPE FRESH** | PROD | $9.58/each | $2–$5/each <sub>STATCAN</sub> | 1.9× over | $9.58/each is 1.9× the top of the BC band ($2–$5/each) |
| **Carrots** | PROD | $7.36/kg | $1.2–$4/kg <sub>STATCAN</sub> | 1.8× over | $7.36/kg is 1.8× the top of the BC band ($1.2–$4/kg) |
| **BLUEBERRY FRESH** | PROD | $32.62/kg | $5–$18/kg <sub>FS</sub> | 1.8× over | $32.62/kg is 1.8× the top of the BC band ($5–$18/kg) |
| **Pears** | PROD | $2.30/each | $0.4–$1.3/each <sub>STATCAN</sub> | 1.8× over | $2.30/each is 1.8× the top of the BC band ($0.4–$1.3/each) |
| **MUSHROOM CRIMINI UNSIZD FRESH** | PROD | $21.26/kg | $4–$12/kg <sub>STATCAN</sub> | 1.8× over | $21.26/kg is 1.8× the top of the BC band ($4–$12/kg) |
| **Ground Venison** | MEAT | $79.32/kg | $22–$45/kg <sub>FS</sub> | 1.8× over | $79.32/kg is 1.8× the top of the BC band ($22–$45/kg) |
| **Sage** | PROD | $79.01/kg | $9–$45/kg <sub>FS</sub> | 1.8× over | $79.01/kg is 1.8× the top of the BC band ($9–$45/kg) |
| **poppy seed** | DRY | $34.75/kg | $3–$20/kg <sub>STATCAN</sub> | 1.7× over | $34.75/kg is 1.7× the top of the BC band ($3–$20/kg) |
| **Apples** | PROD | $1.89/each | $0.35–$1.1/each <sub>STATCAN</sub> | 1.7× over | $1.89/each is 1.7× the top of the BC band ($0.35–$1.1/each) |
| **TOFU EXTRA FIRM ORGANIC** | DRY | $23.32/kg | $4–$14/kg <sub>STATCAN</sub> | 1.7× over | $23.32/kg is 1.7× the top of the BC band ($4–$14/kg) |
| **Chives FARM** | PROD | $123.46/kg | $25–$75/kg <sub>FS</sub> | 1.6× over | $123.46/kg is 1.6× the top of the BC band ($25–$75/kg) |
| **Almond slices** | DRY | $48.94/kg | $12–$30/kg <sub>STATCAN</sub> | 1.6× over | $48.94/kg is 1.6× the top of the BC band ($12–$30/kg) |
| **Beets** | PROD | $8.90/kg | $1.8–$5.5/kg <sub>FS</sub> | 1.6× over | $8.90/kg is 1.6× the top of the BC band ($1.8–$5.5/kg) |
| **Cheddar smoked** | DAIRY | $34.23/kg | $11–$22/kg <sub>STATCAN</sub> | 1.6× over | $34.23/kg is 1.6× the top of the BC band ($11–$22/kg) |
| **Green Onions O/S — bunch, Rootdown Farm in Pemberton, BC (organic)** | PROD | $4.39/each | $0.8–$3/each <sub>FS</sub> | 1.5× over | $4.39/each is 1.5× the top of the BC band ($0.8–$3/each) |
| **Flaked SkipJack Tuna** | DRY | $18.38/kg | $26–$55/kg <sub>FS</sub> | 1.4× under | $18.38/kg is 1.4× BELOW the bottom of the BC band ($26–$55/kg) — under-costing risk |
| **Baby Mixed Greens** | PROD | $35.16/kg | $9–$26/kg <sub>STATCAN</sub> | 1.4× over | $35.16/kg is 1.4× the top of the BC band ($9–$26/kg) |
| **Golf Ball Onions** | PROD | $6.72/kg | $1.2–$5/kg <sub>STATCAN</sub> | 1.3× over | $6.72/kg is 1.3× the top of the BC band ($1.2–$5/kg) |
| **Leeks Fresh** | PROD | $4.58/each | $1–$3.5/each <sub>FS</sub> | 1.3× over | $4.58/each is 1.3× the top of the BC band ($1–$3.5/each) |
| **Limes** | PROD | $9.15/kg | $2.5–$7/kg <sub>STATCAN</sub> | 1.3× over | $9.15/kg is 1.3× the top of the BC band ($2.5–$7/kg) |
| **ONION FRESH CIPPOLINI** | PROD | $16.76/kg | $5–$13/kg <sub>FS</sub> | 1.3× over | $16.76/kg is 1.3× the top of the BC band ($5–$13/kg) |
| **LETTUCE BOSTON /BUTTER FRESH** | PROD | $2.41/each | $1.2–$3.4/each <sub>STATCAN</sub> | — | duplicate item — another active row carries the same product name |
| **LETTUCE BOSTON /BUTTER FRESH** | PROD | $2.41/each | $1.2–$3.4/each <sub>STATCAN</sub> | — | duplicate item — another active row carries the same product name |
| **LETTUCE ROMAINE HEART OF FRSH** | PROD | $1.67/each | $1.2–$3.2/each <sub>STATCAN</sub> | — | duplicate item — another active row carries the same product name |
| **LETTUCE ROMAINE HEART OF FRSH** | PROD | $3.24/each | $1.2–$3.2/each <sub>STATCAN</sub> | — | duplicate item — another active row carries the same product name |

---

## Weird pack formats

These are structural defects in the pack chain, independent of price level.

### `COUNT_UNIT_COLLISION` — counts are silently divided by the case size

A chain level is named with the **same token as the base unit** (`each`), so
`levelBaseUnits()` keys that level by `each` and `basePerUnit(item, 'each')`
resolves to the **pack size instead of 1**. Valuation is unaffected
(`stockValue` uses `pricePerBaseUnit × stockOnHand`), which is why this has
never shown up on a cost report — but every count screen shows the wrong number.

| Item | Divisor | True on hand | Count screen shows | Chain |
|---|---|---|---|---|

**Fix:** rename the intermediate chain level to a container token (`case`,
`pack`, `tray`, `sleeve`) so it stops shadowing `each`.

### `UNIT_LABEL_CONTRADICTION` — the level's name disagrees with its own arithmetic

| Item | Chain | Contradiction |
|---|---|---|

### Duplicate product rows

| Item | Price | Note |
|---|---|---|
| LETTUCE BOSTON /BUTTER FRESH | $2.41/each | duplicate item — another active row carries the same product name |
| LETTUCE BOSTON /BUTTER FRESH | $2.41/each | duplicate item — another active row carries the same product name |
| LETTUCE ROMAINE HEART OF FRSH | $1.67/each | duplicate item — another active row carries the same product name |
| LETTUCE ROMAINE HEART OF FRSH | $3.24/each | duplicate item — another active row carries the same product name |

---

## Advisory — items with no count↔weight bridge

69 COUNT-dimension items have no `eachMeasure`. They cost correctly when a
recipe calls for them by the each, but a recipe or invoice that expresses them
by weight cannot be converted. Not a price defect — listed for completeness in
`inventory-price-audit.csv`.
