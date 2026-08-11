# Inventory price audit — BC market comparison

**Scope:** every active inventory item (454) was priced from the pack-chain spine
(`pricePerBaseUnit`), normalised to $/kg, $/L or $/each, and compared against a
British Columbia price band.

- **396** purchased items compared against a BC benchmark (100% of food items;
  the two exclusions are a cleaning chemical and the $0 non-stocked "Water" utility row).
- **58** PREP-linked items derive their cost from a recipe, not a purchase
  price — market comparison does not apply, so they are checked for pack-format defects only.
- **88** items are flagged for manual revision.

**Benchmark sources**

| Tag | Meaning |
|---|---|
| `STATCAN` | Statistics Canada table 18-10-0245-01, *Monthly average retail prices for selected products*, GEO = British Columbia, **June 2026** (latest published). Retail is an upper bound on wholesale, so bands sit at roughly 0.4–1.0× the BC retail figure. |
| `FS` | BC/Vancouver foodservice distributor range (Sysco / Snow Cap / Legends Haul / Two Rivers class). Industry judgement, not a published quote — treat as "worth a look", not proof. |

A price is only flagged when it sits **more than 1.25× outside** the band, so
band-edge noise is excluded.

---

## ⛔ Proven wrong by the app's own data — 32 items

No market judgement is involved here. Each item's `packChain` is compared
against its **primary supplier offer's own stated purchase format**
(`packQty × packSize packUOM`). Both are written by the same invoice-approve
path, so they must agree. Where they disagree, one of them is wrong — and for
PACK-priced items the chain total is the divisor, so the cost is off by exactly
that ratio.

### 26 items where the **$/unit cost is wrong**

| Item | Supplier | Offer says | Chain says | Error | Current | Should be |
|---|---|---|---|---|---|---|
| **Sugar icing** | Sysco | 1 × 1 kg @ $5.25 | 24000 base | **24.0× too low** | $0.22/kg | $5.25/kg |
| **Red Peppers** | Sysco | 1 × 24 each @ $70.86 | 1 base | **24.0× too high** | $70.86/each | $2.95/each |
| **Garlic Powder** | Sysco | 1 × 525 g @ $18.75 | 6300 base | **12.0× too low** | $2.98/kg | $35.71/kg |
| **Mirin Seasoning** | Sysco | 1 × 1 l @ $9 | 12000 base | **12.0× too low** | $0.75/L | $9.00/L |
| **Fingerling Potatoes** | Sysco | 1 × 12 lb @ $32.94 | 453.592 base | **12.0× too high** | $72.62/kg | $6.05/kg |
| **Baking Powder** | Snow Cap | 1 × 20 kg @ $112.83 | 3000 base | **6.7× too high** | $37.61/kg | $5.64/kg |
| **Tamari Soy Sauce** | Sysco | 1 × 1.89 l @ $27.46 | 11340 base | **6.0× too low** | $2.42/L | $14.53/L |
| **Figs Dried** | Snow Cap | 1 × 13.6 kg @ $246.25 | 2270 base | **6.0× too high** | $108.48/kg | $18.11/kg |
| **OYSTER N/SHELL ROYAL MIYAGI XSM** | Intercity | 1 × 5 dozen @ $9.85 | 12 base | **5.0× too high** | $0.82/each | $0.16/each |
| **Celery** | Sysco | 6 × 1 each @ $27.55 | 30 base | **5.0× too low** | $0.92/each | $4.59/each |
| **Star anise** | Sysco | 1 × 1 lb @ $25.92 | 2250 base | **5.0× too low** | $11.52/kg | $57.14/kg |
| **Lemon Juice** | Sysco | 1 × 3.8 l @ $36.35 | 946 base | **4.0× too high** | $38.42/L | $9.57/L |
| **Vanilla extract** | Snow Cap | 1 × 4 l @ $136.88 | 16000 base | **4.0× too low** | $8.55/L | $34.22/L |
| **CUCUMBER FRESH** | Sysco | 1 × 6 each @ $17.18 | 24 base | **4.0× too low** | $0.72/each | $2.86/each |
| **coconut milk** | Sysco | 6 × 2.841 l @ $119.89 | 4800 base | **3.6× too high** | $24.98/L | $7.03/L |
| **black seasame seed** | Sysco | 1 × 1 kg @ $30.36 | 3000 base | **3.0× too low** | $10.12/kg | $30.36/kg |
| **Cheddar whiite** | Sysco | 1 × 2.25 kg @ $48.57 | 4540 base | **2.0× too low** | $10.70/kg | $21.59/kg |
| **Mustard Dijon** | Sysco | 1 × 5 l @ $46.09 | 10000 base | **2.0× too low** | $4.61/L | $9.22/L |
| **PEPPER JALAPENO FRESH** | Sysco | 1 × 5 lb @ $29.61 | 4535.92 base | **2.0× too low** | $6.53/kg | $13.06/kg |
| **Vinegar Red Wine** | Sysco | 1 × 5 l @ $17.02 | 10000 base | **2.0× too low** | $1.70/L | $3.40/L |
| **Cucumber Long** | Sysco | 1 × 12 each @ $22.46 | 6 base | **2.0× too high** | $3.74/each | $1.87/each |
| **Cashews** | Snow Cap | 1 × 5 kg @ $99.06 | 3000 base | **1.7× too high** | $33.02/kg | $19.81/kg |
| **MUSHROOM CRIMINI UNSIZD FRESH** | Sysco | 1 × 5 lb @ $28.93 | 1360.776 base | **1.7× too high** | $21.26/kg | $12.76/kg |
| **Squash Butternut** | Sysco | 1 × 35 each @ $51.85 | 30 base | **1.2× too high** | $1.73/each | $1.48/each |
| **Lime Juice** | Sysco | 6 × 1 l @ $57.64 | 5443.103999999999 base | **1.1× too high** | $10.59/L | $9.61/L |
| **Heavy Cream 35%** | Sysco | 16 × 946 ml @ $111.26 | 16000 base | **1.1× too low** | $6.95/L | $7.35/L |

### 6 items where the cost is fine but the pack total is not

These are **RATE**-priced ($/kg set directly), so the unit cost is right. The
wrong pack total corrupts count conversions and stock-on-hand instead.

| Item | Supplier | Offer says | Chain says | Rate (correct) |
|---|---|---|---|---|
| Beef Chuck Flat | Legends Haul | 6 × 4 kg | 1000 base | $27.00/kg |
| Grana Padano | Sysco | 2 × 4 kg | 1000 base | $29.30/kg |
| Cheddar smoked | Sysco | 1 × 3.4 kg | 1000 base | $34.23/kg |
| Pork Back Ribs | Legends Haul | 1 × 7 kg | 4540 base | $15.90/kg |
| Ground Pork | Legends Haul | 3 × 5 lb | 7500 base | $13.65/kg |
| Flat Iron Peeled 1-2lb Filet LEGENDS | Legends Haul | 1 × 2 lb | 1000 base | $39.90/kg |

---

## 🔴 CRITICAL — 18 items

Cost math is provably wrong here: the item has no price at all, or it is off by
a multiple large enough that no supplier variation explains it.

| Item | Category | Current | BC benchmark | Drift | What looks wrong |
|---|---|---|---|---|---|
| **Puff pastry sheet(pepridge farm)** | BREAD | $0.01/each | $1.5–$8/each <sub>FS</sub> | 106.5× under | $0.01/each is 106.5× BELOW the bottom of the BC band ($1.5–$8/each) — under-costing risk<br>pack format is malformed: HUGE_PACK(7000 each per purchase unit) |
| **Fingerling Potatoes** | PROD | $72.62/kg | $3–$9/kg <sub>FS</sub> | 8.1× over | $72.62/kg is 8.1× the top of the BC band ($3–$9/kg) |
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

70 COUNT-dimension items have no `eachMeasure`. They cost correctly when a
recipe calls for them by the each, but a recipe or invoice that expresses them
by weight cannot be converted. Not a price defect — listed for completeness in
`inventory-price-audit.csv`.
