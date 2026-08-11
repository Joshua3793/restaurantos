# Inventory price audit — BC market comparison

**Scope:** every active inventory item (453) was priced from the pack-chain spine
(`pricePerBaseUnit`), normalised to $/kg, $/L or $/each, and compared against a
British Columbia price band.

- **395** purchased items compared against a BC benchmark (100% of food items;
  the two exclusions are a cleaning chemical and the $0 non-stocked "Water" utility row).
- **58** PREP-linked items derive their cost from a recipe, not a purchase
  price — market comparison does not apply, so they are checked for pack-format defects only.
- **86** items are flagged for manual revision.

**Benchmark sources**

| Tag | Meaning |
|---|---|
| `STATCAN` | Statistics Canada table 18-10-0245-01, *Monthly average retail prices for selected products*, GEO = British Columbia, **June 2026** (latest published). Retail is an upper bound on wholesale, so bands sit at roughly 0.4–1.0× the BC retail figure. |
| `FS` | BC/Vancouver foodservice distributor range (Sysco / Snow Cap / Legends Haul / Two Rivers class). Industry judgement, not a published quote — treat as "worth a look", not proof. |

A price is only flagged when it sits **more than 1.25× outside** the band, so
band-edge noise is excluded.

---

## ⚠️ Pack format conflicts — 32 items

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

### 25 items where the two disagree on a PACK-priced item

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

## 🔴 CRITICAL — 16 items

Cost math is provably wrong here: the item has no price at all, or it is off by
a multiple large enough that no supplier variation explains it.

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **PUFF PASTRY CROISSANT** | BREAD | $18.24/each | $0.8–$3.2/each <sub>FS</sub> | 5.7× over | $18.24/each is 5.7× the top of the BC band ($0.8–$3.2/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 10 each) |
| **Sugar icing** | DRY | $0.22/kg | $1–$4/kg <sub>STATCAN</sub> | 4.6× under | $0.22/kg is 4.6× BELOW the bottom of the BC band ($1–$4/kg) — under-costing risk |
| **Mirin Seasoning** | DRY | $0.75/L | $3–$12/L <sub>FS</sub> | 4.0× under | $0.75/L is 4.0× BELOW the bottom of the BC band ($3–$12/L) — under-costing risk |
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

## 🟠 HIGH — 40 items

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **Figs Dried** | DRY | $108.48/kg | $3–$30/kg <sub>FS</sub> | 3.6× over | $108.48/kg is 3.6× the top of the BC band ($3–$30/kg) |
| **Oysters Kusshi** | FISH | $0.20/each | $0.7–$2.4/each <sub>FS</sub> | 3.5× under | $0.20/each is 3.5× BELOW the bottom of the BC band ($0.7–$2.4/each) — under-costing risk |
| **CHEESE CURD** | DRY | $3.42/kg | $12–$22/kg <sub>FS</sub> | 3.5× under | $3.42/kg is 3.5× BELOW the bottom of the BC band ($12–$22/kg) — under-costing risk |
| **Baking Powder** | DRY | $37.61/kg | $4–$14/kg <sub>FS</sub> | 2.7× over | $37.61/kg is 2.7× the top of the BC band ($4–$14/kg) |
| **CABBAGE RED FDSVC** | PROD | $12.70/each | $1.5–$5/each <sub>STATCAN</sub> | 2.5× over | $12.70/each is 2.5× the top of the BC band ($1.5–$5/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 3 each) |
| **coconut milk** | DRY | $24.98/L | $3–$10/L <sub>FS</sub> | 2.5× over | $24.98/L is 2.5× the top of the BC band ($3–$10/L) |
| **BLUEBERRY CULTIVATED IQF CAN** | FROZEN | $29.77/kg | $5–$12/kg <sub>FS</sub> | 2.5× over | $29.77/kg is 2.5× the top of the BC band ($5–$12/kg) |
| **Chilli Red Thai** | PROD | $93.82/kg | $12–$40/kg <sub>FS</sub> | 2.3× over | $93.82/kg is 2.3× the top of the BC band ($12–$40/kg) |
| **Cucumber Long** | PROD | $3.74/each | $0.5–$1.6/each <sub>STATCAN</sub> | 2.3× over | $3.74/each is 2.3× the top of the BC band ($0.5–$1.6/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 6 each) |
| **SPINACH BABY FRESH** | PROD | $42.47/kg | $8–$20/kg <sub>FS</sub> | 2.1× over | $42.47/kg is 2.1× the top of the BC band ($8–$20/kg) |
| **Pineapple** | PROD | $13.63/each | $2.5–$6.5/each <sub>FS</sub> | 2.1× over | $13.63/each is 2.1× the top of the BC band ($2.5–$6.5/each) |
| **grapefruit** | PROD | $3.60/each | $0.6–$1.8/each <sub>FS</sub> | 2.0× over | $3.60/each is 2.0× the top of the BC band ($0.6–$1.8/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 6 each) |
| **MELON CANTALOUPE FRESH** | PROD | $9.58/each | $2–$5/each <sub>STATCAN</sub> | 1.9× over | $9.58/each is 1.9× the top of the BC band ($2–$5/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 3 each) |
| **Pears** | PROD | $2.30/each | $0.4–$1.3/each <sub>STATCAN</sub> | 1.8× over | $2.30/each is 1.8× the top of the BC band ($0.4–$1.3/each)<br>pack format is malformed: COUNT_UNIT_ORPHAN(case) |
| **Apples** | PROD | $1.89/each | $0.35–$1.1/each <sub>STATCAN</sub> | 1.7× over | $1.89/each is 1.7× the top of the BC band ($0.35–$1.1/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 12 each) |
| **Leeks Fresh** | PROD | $4.58/each | $1–$3.5/each <sub>FS</sub> | 1.3× over | $4.58/each is 1.3× the top of the BC band ($1–$3.5/each)<br>pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 12 each) |
| **GF Brioche Bun** | BREAD | $1.69/each | $0.4–$2/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(pack) |
| **GF ENGLISH MUFFIN** | BREAD | $1.69/each | $0.4–$2/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(pack) |
| **Naan Bread Round 8 in** | BREAD | $0.89/each | $0.4–$1.6/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(pack) |
| **Pastry shell chocolate** | BREAD | $2.10/each | $0.3–$3/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 60 each) |
| **Pita Bread** | BREAD | $0.27/each | $0.15–$0.8/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(pack) |
| **Yellow corn Tortillas** | BREAD | $0.11/each | $0.06–$0.35/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(pack) |
| **Granny Smith apple** | DRY | $0.46/each | $0.35–$1.1/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 113 each) |
| **Nori sheets** | DRY | $0.45/each | $0.1–$1/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 100 each) |
| **Tomato Crushed San Benito** | DRY | $3.30/kg | $1.8–$6/kg <sub>STATCAN</sub> | — | compared across kg/L assuming density ≈ 1 g/ml<br>pack format is malformed: UNIT_LABEL_CONTRADICTION(chain says 1 oz = 2834.95 g, but 1 oz is 28.3495 g) |
| **TRSM Sour Tuscan Salami** | DRY | $22.08/each | $14–$75/each <sub>FS</sub> | — | item is priced per each but the BC benchmark for this product is per kg — dimension mismatch, likely the wrong dimension on the item |
| **OYSTER N/SHELL ROYAL MIYAGI XSM** | FISH | $0.82/each | $0.7–$2.4/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 12 each) |
| **SABLEFISH FLT B/I LG 2/2.8 LB PREM VR LONGLINES (NOT SPECIFIED)** | FISH | $54.90/kg | $45–$90/kg <sub>FS</sub> | — | pack format is malformed: UNIT_LABEL_CONTRADICTION(chain says 1 lb = 4535.92 g, but 1 lb is 453.592 g) |
| **Pigs Blood** | MEAT | $6.31/kg | $2–$10/kg <sub>FS</sub> | — | pack format is malformed: UNIT_LABEL_CONTRADICTION(chain says 1 lb = 2267.96 g, but 1 lb is 453.592 g) |
| **Avocado** | PROD | $0.94/each | $0.7–$2.5/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 70 each) |
| **Celery** | PROD | $0.92/each | $0.6–$4.2/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 6 each) |
| **Ciucumber Medium** | PROD | $1.67/each | $0.5–$1.6/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_ORPHAN(case) |
| **Cucumber Blossoms - NEW!!!** | PROD | $0.50/each | $0.2–$40/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 12 each) |
| **Eggplant** | PROD | $2.93/each | $1–$3.2/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 24 each) |
| **Kale** | PROD | $2.38/each | $1.2–$3.5/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 24 each) |
| **Lemons** | PROD | $0.48/each | $0.3–$1.1/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 140 each) |
| **Red Peppers** | PROD | $70.86/each | $3–$9/each <sub>STATCAN</sub> | — | item is priced per each but the BC benchmark for this product is per kg — dimension mismatch, likely the wrong dimension on the item |
| **Squash Butternut** | PROD | $1.73/each | $1.2–$5/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 30 each) |
| **tuscan lettuce** | PROD | $2.05/each | $1.2–$3.4/each <sub>STATCAN</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 24 each) |
| **Violas - Edible Flowers (20)** | PROD | $0.34/each | $0.2–$40/each <sub>FS</sub> | — | pack format is malformed: COUNT_UNIT_COLLISION(counting in 'each' resolves to 20 each) |

---

## 🟡 MEDIUM — 30 items

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **MELON WATERMELON SDLS FRESH** | PROD | $27.52/each | $5–$14/each <sub>FS</sub> | 2.0× over | $27.52/each is 2.0× the top of the BC band ($5–$14/each) |
| **Salad Mix O/S** | PROD | $50.68/kg | $9–$26/kg <sub>STATCAN</sub> | 1.9× over | $50.68/kg is 1.9× the top of the BC band ($9–$26/kg) |
| **Lemon Juice** | DRY | $38.42/L | $4–$20/L <sub>FS</sub> | 1.9× over | $38.42/L is 1.9× the top of the BC band ($4–$20/L) |
| **Carrots** | PROD | $7.36/kg | $1.2–$4/kg <sub>STATCAN</sub> | 1.8× over | $7.36/kg is 1.8× the top of the BC band ($1.2–$4/kg) |
| **BLUEBERRY FRESH** | PROD | $32.62/kg | $5–$18/kg <sub>FS</sub> | 1.8× over | $32.62/kg is 1.8× the top of the BC band ($5–$18/kg) |
| **MUSHROOM CRIMINI UNSIZD FRESH** | PROD | $21.26/kg | $4–$12/kg <sub>STATCAN</sub> | 1.8× over | $21.26/kg is 1.8× the top of the BC band ($4–$12/kg) |
| **Ground Venison** | MEAT | $79.32/kg | $22–$45/kg <sub>FS</sub> | 1.8× over | $79.32/kg is 1.8× the top of the BC band ($22–$45/kg) |
| **Sage** | PROD | $79.01/kg | $9–$45/kg <sub>FS</sub> | 1.8× over | $79.01/kg is 1.8× the top of the BC band ($9–$45/kg) |
| **poppy seed** | DRY | $34.75/kg | $3–$20/kg <sub>STATCAN</sub> | 1.7× over | $34.75/kg is 1.7× the top of the BC band ($3–$20/kg) |
| **TOFU EXTRA FIRM ORGANIC** | DRY | $23.32/kg | $4–$14/kg <sub>STATCAN</sub> | 1.7× over | $23.32/kg is 1.7× the top of the BC band ($4–$14/kg) |
| **Chives FARM** | PROD | $123.46/kg | $25–$75/kg <sub>FS</sub> | 1.6× over | $123.46/kg is 1.6× the top of the BC band ($25–$75/kg) |
| **Almond slices** | DRY | $48.94/kg | $12–$30/kg <sub>STATCAN</sub> | 1.6× over | $48.94/kg is 1.6× the top of the BC band ($12–$30/kg) |
| **Beets** | PROD | $8.90/kg | $1.8–$5.5/kg <sub>FS</sub> | 1.6× over | $8.90/kg is 1.6× the top of the BC band ($1.8–$5.5/kg) |
| **Cheddar smoked** | DAIRY | $34.23/kg | $11–$22/kg <sub>STATCAN</sub> | 1.6× over | $34.23/kg is 1.6× the top of the BC band ($11–$22/kg) |
| **Green Onions O/S — bunch, Rootdown Farm in Pemberton, BC (organic)** | PROD | $4.39/each | $0.8–$3/each <sub>FS</sub> | 1.5× over | $4.39/each is 1.5× the top of the BC band ($0.8–$3/each) |
| **Flaked SkipJack Tuna** | DRY | $18.38/kg | $26–$55/kg <sub>FS</sub> | 1.4× under | $18.38/kg is 1.4× BELOW the bottom of the BC band ($26–$55/kg) — under-costing risk |
| **Baby Mixed Greens** | PROD | $35.16/kg | $9–$26/kg <sub>STATCAN</sub> | 1.4× over | $35.16/kg is 1.4× the top of the BC band ($9–$26/kg) |
| **Golf Ball Onions** | PROD | $6.72/kg | $1.2–$5/kg <sub>STATCAN</sub> | 1.3× over | $6.72/kg is 1.3× the top of the BC band ($1.2–$5/kg) |
| **Garlic Powder** | DRY | $2.98/kg | $4–$70/kg <sub>FS</sub> | 1.3× under | $2.98/kg is 1.3× BELOW the bottom of the BC band ($4–$70/kg) — under-costing risk |
| **Limes** | PROD | $9.15/kg | $2.5–$7/kg <sub>STATCAN</sub> | 1.3× over | $9.15/kg is 1.3× the top of the BC band ($2.5–$7/kg) |
| **ONION FRESH CIPPOLINI** | PROD | $16.76/kg | $5–$13/kg <sub>FS</sub> | 1.3× over | $16.76/kg is 1.3× the top of the BC band ($5–$13/kg) |
| **Brioche French Toast Slice** | PREPD | $1.50/each | — | — | pack format is malformed on a recipe-linked item |
| **Buttermilk Biscuits** | PREPD | $0.47/each | — | — | pack format is malformed on a recipe-linked item |
| **English Muffins (Sourdough Whole Wheat)** | PREPD | $0.37/each | — | — | pack format is malformed on a recipe-linked item |
| **Scones** | PREPD | $0.42/each | — | — | pack format is malformed on a recipe-linked item |
| **Sourdough Bread** | PREPD | $0.21/each | — | — | pack format is malformed on a recipe-linked item |
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
| Apples | 12× | 150 each | 12.50 each | `[{"per":1,"unit":"each"},{"per":12,"unit":"each"}]` |
| Avocado | 70× | 98 each | 1.40 each | `[{"per":1,"unit":"case"},{"per":70,"unit":"each"}]` |
| CABBAGE RED FDSVC | 3× | 5 each | 1.67 each | `[{"per":1,"unit":"case"},{"per":3,"unit":"each"}]` |
| Celery | 6× | 7 each | 1.17 each | `[{"per":5,"unit":"case"},{"per":6,"unit":"each"}]` |
| Cucumber Blossoms - NEW!!! | 12× | 0 each | 0.00 each | `[{"per":1,"unit":"dozen"},{"per":12,"unit":"each"}]` |
| Cucumber Long | 6× | 0 each | 0.00 each | `[{"per":1,"unit":"each"},{"per":6,"unit":"each"}]` |
| Eggplant | 24× | 0 each | 0.00 each | `[{"per":1,"unit":"each"},{"per":24,"unit":"each"}]` |
| Granny Smith apple | 113× | 0 each | 0.00 each | `[{"per":1,"unit":"case"},{"per":113,"unit":"each"}]` |
| grapefruit | 6× | 0 each | 0.00 each | `[{"per":1,"unit":"each"},{"per":6,"unit":"each"}]` |
| Kale | 24× | 8 each | 0.33 each | `[{"per":1,"unit":"case"},{"per":24,"unit":"each"}]` |
| Leeks Fresh | 12× | 0 each | 0.00 each | `[{"per":1,"unit":"each"},{"per":12,"unit":"each"}]` |
| Lemons | 140× | 112 each | 0.80 each | `[{"per":1,"unit":"case"},{"per":140,"unit":"each"}]` |
| MELON CANTALOUPE FRESH | 3× | 0 each | 0.00 each | `[{"per":1,"unit":"case"},{"per":3,"unit":"each"}]` |
| Nori sheets | 100× | 0 each | 0.00 each | `[{"per":1,"unit":"pack"},{"per":100,"unit":"each"}]` |
| OYSTER N/SHELL ROYAL MIYAGI XSM | 12× | 0 each | 0.00 each | `[{"per":1,"unit":"DZ"},{"per":12,"unit":"each"}]` |
| Pastry shell chocolate | 60× | 0 each | 0.00 each | `[{"per":1,"unit":"each"},{"per":60,"unit":"each"}]` |
| PUFF PASTRY CROISSANT | 10× | 10 each | 1.00 each | `[{"per":1,"unit":"each"},{"per":10,"unit":"each"}]` |
| Squash Butternut | 30× | 24 each | 0.80 each | `[{"per":30,"unit":"each"},{"per":1,"unit":"each"}]` |
| tuscan lettuce | 24× | 0 each | 0.00 each | `[{"per":24,"unit":"each"},{"per":1,"unit":"each"}]` |
| Violas - Edible Flowers (20) | 20× | 0 each | 0.00 each | `[{"per":1,"unit":"case"},{"per":20,"unit":"each"}]` |

**Fix:** rename the intermediate chain level to a container token (`case`,
`pack`, `tray`, `sleeve`) so it stops shadowing `each`.

### `UNIT_LABEL_CONTRADICTION` — the level's name disagrees with its own arithmetic

| Item | Chain | Contradiction |
|---|---|---|
| Tomato Crushed San Benito | `1 cs = 6 oz → 1 oz = 2834.95 g` | UNIT_LABEL_CONTRADICTION(chain says 1 oz = 2834.95 g, but 1 oz is 28.3495 g) |
| SABLEFISH FLT B/I LG 2/2.8 LB PREM VR LONGLINES (NOT SPECIFIED) | `1 lb = 4535.92 g` | UNIT_LABEL_CONTRADICTION(chain says 1 lb = 4535.92 g, but 1 lb is 453.592 g) |
| Pigs Blood | `1 lb = 2267.96 g` | UNIT_LABEL_CONTRADICTION(chain says 1 lb = 2267.96 g, but 1 lb is 453.592 g) |
| Brioche French Toast Slice | `1 batch = 57 each` | UNIT_LABEL_CONTRADICTION(chain says 1 batch = 57 each, but 1 batch is 1 each) |
| Buttermilk Biscuits | `1 batch = 55 each` | UNIT_LABEL_CONTRADICTION(chain says 1 batch = 55 each, but 1 batch is 1 each) |
| English Muffins (Sourdough Whole Wheat) | `1 batch = 72 each` | UNIT_LABEL_CONTRADICTION(chain says 1 batch = 72 each, but 1 batch is 1 each) |
| Scones | `1 batch = 25 each` | UNIT_LABEL_CONTRADICTION(chain says 1 batch = 25 each, but 1 batch is 1 each) |
| Sourdough Bread | `1 batch = 72 each` | UNIT_LABEL_CONTRADICTION(chain says 1 batch = 72 each, but 1 batch is 1 each) |

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
