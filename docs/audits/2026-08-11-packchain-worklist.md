# Pack-format worklist

43 active items where the stored pack format and the invoice's pack
disagree by more than the 25% tolerance in `packFormatsDisagree`.

**Nothing here can be auto-repaired.** Either side may be the stale one and the
data does not say which — that is why `approve` skips the price write instead of
guessing. Each entry gives both claims, what the spine reads under each, and what
is riding on the answer. Decide per item, then fix the losing side.

Total spend through these items: $7511.84

## Triage

| verdict | items | spend |
|---|---|---|
| **Item format likely stale — fix the OFFER** | 15 | $2476.82 |
| **Invoice likely understated — fix the LINE / teach the format** | 17 | $1970.84 |
| **Supplier pack changed — read by date** | 6 | $2660.02 |
| **Needs the physical pack in hand** | 5 | $404.16 |

Every one of these items has a **primary supplier offer**, so the durable fix is on
the OFFER's format — `syncPrimaryOfferToItem` rewrites the item chain from it, and an
item-only edit will be silently overwritten on the next approve.

**15 of 43 are buying from a supplier that is NOT the primary offer**
($3089.72). For those the two packs may both be correct —
each for its own supplier — and the real defect is that the item's format is inherited from a
supplier you have stopped buying from. Check that before touching any format.

---

## 1. Cream whipped  <sub>DAIRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 16 each · 1 each = 946 ml → **15136 ml** per case | $0.0072/ml |
| **invoice** ×1 | 1 × 946 ml → **946 ml** | $0.12/ml |
| | <sub>Sysco Canada, Inc. · 2026-05-19 → 2026-05-19 · $35.05 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 16 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 16-pack**
- disagreement: **16.00×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $109.71 → $1755.36 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c9224de244e004fdbaaf0c47`

## 2. Liquid Egg Yolk  <sub>DAIRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 cs = 12 kg · 1 kg = 1000 g → **12000 g** per case | $0.0086/g |
| **invoice** ×2 | 1 × 1 kg → **1000 g** | $0.10/g |
| | <sub>Sysco Canada, Inc., Sysco Canada, Inc. - Vancouver · 2026-06-06 → 2026-06-10 · $149.60 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 12 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 12-pack**
- disagreement: **12.00×** (item ÷ invoice)
- riding on it: **7 recipe lines** · stock value $111.86 → $1342.38 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=ce4cfeb29051842b286dbd1d`

## 3. Cheddar smoked  <sub>DAIRY · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1000 g → **1000 g** per case | $0.0342/g |
| **invoice** ×8 | 1 × 3.4 kg → **3400 g** | unchanged |
| | <sub>Sysco Canada, Inc. - Vancouver, Sysco Canada, Inc., SYSCO Canada, Inc. - Vancouver · 2026-06-10 → 2026-08-01 · $1826.62 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |
| **invoice** ×1 | 2 × 3.4 kg → **6800 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-06-12 → 2026-06-12 · $227.81</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **0.29×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **3 recipe lines** · stock value $321.76 → $321.76 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cd1ab4731eef84b7fb557e6e`

## 4. Yellow potato  <sub>PROD · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1 each · 1 each = 22679.6 g → **22679.6 g** per case | $0.0016/g |
| **invoice** ×2 | 1 × 10 lb → **4535.92 g** | $0.0081/g |
| | <sub>Independent (Hector's YIG Garibaldi Highlands) · 2025-07-26 → 2025-07-26 · $177.00 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 5 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 5-pack**
- disagreement: **5.00×** (item ÷ invoice)
- riding on it: **2 recipe lines** · stock value $221.70 → $1108.50 if the invoice claim wins
- ⚠︎ **you are buying from Independent (Hector's YIG Garibaldi Highlands), but the primary offer is Sysco**.
  The item's format comes from Sysco, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Sysco's format.
- `id=c0eec111399b84c76bbc5662`

## 5. Vinegar apple cider  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 6 each · 1 each = 4000 ml → **24000 ml** per case | $0.0023/ml |
| **invoice** ×4 | 1 × 4 l → **4000 ml** | $0.0138/ml |
| | <sub>SYSCO Canada, Inc. - Vancouver, Sysco Canada, Inc. · 2026-06-15 → 2026-07-11 · $75.70 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 6 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 6-pack**
- disagreement: **6.00×** (item ÷ invoice)
- riding on it: **16 recipe lines** · stock value $110.52 → $663.12 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cf644f72a64424d5984df632`

## 6. pork belly  <sub>MEAT · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1000 g → **1000 g** per case | $0.0125/g |
| **invoice** ×4 | 1 × 4.5 kg → **4500 g** | unchanged |
| | <sub>Acecard Food Group LTD, Acecard Food Group LTD (Legends Haul) · 2026-07-03 → 2026-07-27 · $596.50 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 4.50× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.22×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, Acecard Food Group LTD (Legends Haul), but the primary offer is Intercity**.
  The item's format comes from Intercity, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Intercity's format.
- `id=c9a34699da84e40b2ba96236`

## 7. LETTUCE ROMAINE HEART OF FRSH  <sub>PROD · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 4 pack · 1 pack = 12 each → **48 each** per case | $1.67/each |
| **invoice** ×2 | 1 × 12 each → **12 each** | $6.67/each |
| | <sub>SYSCO Canada, Inc. - Vancouver, Sysco Canada, Inc. · 2026-07-15 → 2026-07-28 · $42.22 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |
| **invoice** ×1 | 24 × 1 car → **24 each** | $3.33/each |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-15 → 2026-06-15 · $48.12</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $79.99 → $319.96 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmq8zjdhk0001vlm6r99hy1fr`

## 8. Brisket AAA  <sub>MEAT · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 28000 g → **28000 g** per case | $0.0197/g |
| **invoice** ×1 | 1 × 7 kg → **7000 g** | unchanged |
| | <sub>Acecard Food Group LTD · 2026-07-03 → 2026-07-03 · $478.71 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **2 recipe lines** · stock value $683.00 → $683.00 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Legends Haul**.
  The item's format comes from Legends Haul, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Legends Haul's format.
- `id=c90ce7fb4dc4d4e0b986f788`

## 9. Sausage BaconPorkHerb RTL 8x4/cs LEGENDS  <sub>MEAT · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 7000 g → **7000 g** per case | $0.0159/g |
| **invoice** ×1 | 1 × 1 kg → **1000 g** | unchanged |
| | <sub>Acecard Food Group LTD · 2026-06-05 → 2026-06-05 · $457.77 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 7 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 7-pack**
- disagreement: **7.00×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **2 recipe lines** · stock value $558.25 → $558.25 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Legends Haul**.
  The item's format comes from Legends Haul, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Legends Haul's format.
- `id=cmphb5wgz0001lv2zseteucnt`

## 10. Chives  <sub>PROD · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 453.592 g → **453.59 g** per case | $0.0731/g |
| **invoice** ×1 | 1 × 4 oz → **113.4 g** | $0.29/g |
| | <sub>The Brew Creek Farm · 2026-06-24 → 2026-06-24 · $42.00 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $66.30 → $265.20 if the invoice claim wins
- ⚠︎ **you are buying from The Brew Creek Farm, but the primary offer is Sysco**.
  The item's format comes from Sysco, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Sysco's format.
- `id=c60497b6a46a4479bb1f0c80`

## 11. Extra Virgin Olive Oil  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 4 each · 1 each = 3000 ml → **12000 ml** per case | $0.0117/ml |
| **invoice** ×2 | 1 × 3 l → **3000 ml** | $0.0466/ml |
| | <sub>SYSCO Canada, Inc., Sysco Canada, Inc. - Vancouver · 2026-06-18 → 2026-06-25 · $110.25 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **48 recipe lines** · stock value $52.48 → $209.92 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmnmloj0m000lhgf0lluupb29`

## 12. Beef Chuck Flat  <sub>MEAT · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1000 g → **1000 g** per case | $0.0270/g |
| **invoice** ×2 | 6 × 4 kg → **24000 g** | unchanged |
| | <sub>Acecard Food Group LTD, Acecard Food Group LTD (Legends Haul) · 2026-07-03 → 2026-07-15 · $420.12</sub> | |

- **the invoice's container is 24.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.04×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, Acecard Food Group LTD (Legends Haul), but the primary offer is Legends Haul**.
  The item's format comes from Legends Haul, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Legends Haul's format.
- `id=cmnmloj0u000thgf01tphsbgh`

## 13. Cilantro  <sub>PROD · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 4 each · 1 each = 453.592 g → **1814.37 g** per case | $0.0225/g |
| **invoice** ×4 | 1 × 1 lb → **453.59 g** | $0.0901/g |
| | <sub>SYSCO Canada, Inc., Sysco Canada, Inc., SYSCO Canada, Inc. - Vancouver · 2026-06-20 → 2026-06-30 · $62.72 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **3 recipe lines** · stock value $51.10 → $204.40 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cf6784a8d636149a79225e58`

## 14. Pork Back Ribs  <sub>MEAT · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1 each · 1 each = 4540 g → **4540 g** per case | $0.0159/g |
| **invoice** ×1 | 1 × 7 kg → **7000 g** | unchanged |
| | <sub>Acecard Food Group LTD · 2026-07-27 → 2026-07-27 · $341.85 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 1.54× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.65×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Legends Haul**.
  The item's format comes from Legends Haul, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Legends Haul's format.
- `id=ca035ee4aefe7457aa3479aa`

## 15. MUSHROOM CRIMINI UNSIZD FRESH  <sub>PROD · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1 each · 1 each = 1360.776 g → **1360.78 g** per case | $0.0213/g |
| **invoice** ×4 | 1 × 5 lb → **2267.96 g** | $0.0128/g |
| | <sub>Sysco Canada, Inc., Sysco Canada, Inc. - Vancouver · 2026-06-22 → 2026-07-21 · $302.04 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 1.67× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.60×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmqd2rx0r0005m7sn48ce1a1d`

## 16. Cashews  <sub>DRY · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2 each · 1 each = 1500 g → **3000 g** per case | $0.0330/g |
| **invoice** ×1 | 1 × 5 kg → **5000 g** | $0.0198/g |
| | <sub>Snow Cap Enterprises Ltd. · 2026-06-25 → 2026-06-25 · $99.06 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 1.67× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.60×** (item ÷ invoice)
- riding on it: **3 recipe lines** · stock value $247.65 → $148.59 if the invoice claim wins
- primary offer: **Snow Cap** — edit that offer's format
- `id=cfc6167f00af24c0ea1820e2`

## 17. Veal Bones  <sub>MEAT · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 1 each · 1 each = 22679.6 g → **22679.6 g** per case | $0.0068/g |
| **invoice** ×1 | 1 × 501 lb → **227249.59 g** | $0.0007/g |
| | <sub>Acecard Food Group LTD · 2026-07-29 → 2026-07-29 · $0.00 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 10.02× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.10×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $153.34 → $15.30 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Sysco**.
  The item's format comes from Sysco, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Sysco's format.
- `id=c9315393165714bc6b7fa299`

## 18. Cream cheese  <sub>DAIRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 6 each · 1 each = 1500 g → **9000 g** per case | $0.0154/g |
| **invoice** ×1 | 1 × 1.5 kg → **1500 g** | $0.0925/g |
| | <sub>Sysco Canada, Inc. · 2026-06-08 → 2026-06-08 · $26.25 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 6 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 6-pack**
- disagreement: **6.00×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $23.12 → $138.72 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c93b5d280ea294b2298c5236`

## 19. BLUEBERRY CULTIVATED IQF CAN  <sub>FROZEN · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1 each · 1 each = 2500 g → **2500 g** per case | $0.0298/g |
| **invoice** ×2 | 1 × 5 kg → **5000 g** | $0.0149/g |
| | <sub>Snow Cap Enterprises Ltd. · 2026-06-22 → 2026-07-20 · $58.50 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 2.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.50×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $148.86 → $74.43 if the invoice claim wins
- ⚠︎ **you are buying from Snow Cap Enterprises Ltd., but the primary offer is Sysco**.
  The item's format comes from Sysco, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Sysco's format.
- `id=cmq8sgwl30001b1ht1idlu6sn`

## 20. Star anise  <sub>DRY · UNCLEAR</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 1 each · 1 each = 2250 g → **2250 g** per case | $0.0115/g |
| **invoice** ×1 | 1 × 1 lb → **453.59 g** | $0.0571/g |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-07-03 → 2026-07-03 · $77.76 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item is 4.96× the invoice — neither a clean multiple nor smaller; needs the physical pack**
- disagreement: **4.96×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $14.98 → $74.29 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c6c79704e4a74479db3a0749`

## 21. Baking Powder  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 20000 g → **20000 g** per case | $0.0056/g |
| **invoice** ×1 | 1 × 5 kg → **5000 g** | $0.0226/g |
| | <sub>Snow Cap Enterprises Ltd. · 2026-07-27 → 2026-07-27 · $37.53 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **2 recipe lines** · stock value $25.95 → $103.80 if the invoice claim wins
- primary offer: **Snow Cap** — edit that offer's format
- `id=cbe532f0f92f847e0a0db495`

## 22. Ground Pork  <sub>MEAT · UNCLEAR</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 7500 g → **7500 g** per case | $0.0137/g |
| **invoice** ×1 | 1 × 5 lb → **2267.96 g** | unchanged |
| | <sub>Acecard Food Group LTD · 2026-06-24 → 2026-06-24 · $181.27 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item is 3.31× the invoice — neither a clean multiple nor smaller; needs the physical pack**
- disagreement: **3.31×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **1 recipe line** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Legends Haul**.
  The item's format comes from Legends Haul, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Legends Haul's format.
- `id=c4005fb9f5e3f4abe829e6e3`

## 23. Havarti cheese  <sub>DAIRY · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 3250 g → **3250 g** per case | $0.0219/g |
| **invoice** ×1 | 10 × 250 g → **2500 g** | unchanged |
| | <sub>SYSCO Canada, Inc. · 2026-07-01 → 2026-07-01 · $111.92</sub> | |
| **invoice** ×1 | 1 × 1 kg → **1000 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-07-04 → 2026-07-04 · $57.71 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **1.30×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **3 recipe lines** · stock value $61.21 → $61.21 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c591a45cd3d1c4db598005cc`

## 24. Fingerling Potatoes  <sub>PROD · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 bag = 453.592 g → **453.59 g** per case | $0.0065/g |
| **invoice** ×2 | 1 × 12 lb → **5443.1 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-06-26 → 2026-07-31 · $98.82 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |
| **invoice** ×1 | 1 × 5 lb → **2267.96 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-07-31 → 2026-07-31 · $65.88 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **0.08×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmq78d50c0001grtm3araah6g`

## 25. CABBAGE RED FDSVC  <sub>PROD · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 3 each → **3 each** per case | $12.70/each |
| **invoice** ×1 | 1 × 2 each → **2 each** | $19.05/each |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-15 → 2026-06-15 · $20.38 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |
| **invoice** ×1 | 2 × 3 each → **6 each** | $6.35/each |
| | <sub>SYSCO Canada, Inc. · 2026-06-20 → 2026-06-20 · $74.78</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **1.50×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $63.48 → $95.23 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmprb28d10003w1gff2ez3rvw`

## 26. Cheddar whiite  <sub>DAIRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2 each · 1 each = 2270 g → **4540 g** per case | $0.0107/g |
| **invoice** ×1 | 1 × 2.25 kg → **2250 g** | $0.0216/g |
| | <sub>Sysco Canada, Inc. - Vancouver · 2026-07-27 → 2026-07-27 · $48.57 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 2 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 2-pack**
- disagreement: **2.02×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $53.49 → $107.93 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cb02bff96e04441bebf78c62`

## 27. Garlic Powder  <sub>DRY · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 525 g → **525 g** per case | $0.0357/g |
| **invoice** ×2 | 1 × 3 kg → **3000 g** | $0.0062/g |
| | <sub>Snow Cap Enterprises Ltd. · 2026-06-22 → 2026-08-04 · $150.00 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 5.71× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.17×** (item ÷ invoice)
- riding on it: **8 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Snow Cap Enterprises Ltd., but the primary offer is Sysco**.
  The item's format comes from Sysco, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Sysco's format.
- `id=c332fd346c712464688a9bda`

## 28. OYSTER N/SHELL ROYAL MIYAGI XSM  <sub>FISH · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 DZ = 12 each → **12 each** per case | $0.82/each |
| **invoice** ×2 | 1 × 5 dozen → **60 each** | $0.16/each |
| | <sub>INTERCITY PACKERS LTD · 2026-07-03 → 2026-07-04 · $147.75 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 5.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.20×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Intercity** — edit that offer's format
- `id=cmqkabg670001yke4w4lx4noj`

## 29. Grana Padano  <sub>DAIRY · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1000 g → **1000 g** per case | $0.0293/g |
| **invoice** ×1 | 2 × 4 kg → **8000 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-07-02 → 2026-07-02 · $139.47</sub> | |

- **the invoice's container is 8.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.13×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **1 recipe line** · stock value $187.52 → $187.52 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=ceae4f06c40aa40c6b0e8fa9`

## 30. Tamari Soy Sauce  <sub>DRY · PACK_CHANGED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 6 each · 1 each = 1890 ml → **11340 ml** per case | $0.0024/ml |
| **invoice** ×1 | 1 × 3.79 l → **3790 ml** | $0.0072/ml |
| | <sub>SYSCO Canada, Inc. · 2026-06-22 → 2026-06-22 · $30.84 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |
| **invoice** ×1 | 1 × 1.89 l → **1890 ml** | $0.0145/ml |
| | <sub>Sysco Canada, Inc. - Vancouver · 2026-06-29 → 2026-06-29 · $54.92 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **invoices disagree with each other (2 distinct packs) — read them by date**
- disagreement: **2.99×** (item ÷ invoice)
- riding on it: **4 recipe lines** · stock value $11.44 → $34.23 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c06d7b5a6ade54e299898072`

## 31. Mustard Dijon  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2 each · 1 each = 5000 ml → **10000 ml** per case | $0.0080/ml |
| **invoice** ×1 | 1 × 5 l → **5000 ml** | $0.0160/ml |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-27 → 2026-06-27 · $46.09 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 2 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 2-pack**
- disagreement: **2.00×** (item ÷ invoice)
- riding on it: **8 recipe lines** · stock value $32.00 → $63.99 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c504b6bb3690142078df755a`

## 32. Celery  <sub>PROD · UNCLEAR</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 5 pack · 1 pack = 6 each → **30 each** per case | $0.92/each |
| **invoice** ×2 | 6 × 1 each → **6 each** | $4.59/each |
| | <sub>SYSCO Canada, Inc., Sysco Canada, Inc. · 2026-07-01 → 2026-07-31 · $52.17</sub> | |

- **item is 5.00× the invoice — neither a clean multiple nor smaller; needs the physical pack**
- disagreement: **5.00×** (item ÷ invoice)
- riding on it: **4 recipe lines** · stock value $6.43 → $32.14 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c228c1efff67145dca2936f4`

## 33. Sesame Seeds  <sub>DRY · UNCLEAR</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 1 each · 1 each = 5000 g → **5000 g** per case | $0.0053/g |
| **invoice** ×1 | 2 × 1.5 kg → **3000 g** | $0.0088/g |
| | <sub>Sysco Canada, Inc. · 2026-07-15 → 2026-07-15 · $64.92</sub> | |

- **item is 1.67× the invoice — neither a clean multiple nor smaller; needs the physical pack**
- disagreement: **1.67×** (item ÷ invoice)
- riding on it: **3 recipe lines** · stock value $23.63 → $39.38 if the invoice claim wins
- ⚠︎ **you are buying from Sysco Canada, Inc., but the primary offer is Snow Cap**.
  The item's format comes from Snow Cap, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Snow Cap's format.
- `id=c9a5420c9ee1d4d0299192fa`

## 34. PEPPER JALAPENO FRESH  <sub>PROD · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 1 each · 1 each = 4535.92 g → **4535.92 g** per case | $0.0065/g |
| **invoice** ×3 | 1 × 5 lb → **2267.96 g** | $0.0131/g |
| | <sub>SYSCO Canada, Inc. - Vancouver, SYSCO Canada, Inc. · 2026-06-15 → 2026-07-14 · $90.48 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 2 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 2-pack**
- disagreement: **2.00×** (item ÷ invoice)
- riding on it: **3 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmprb2djl0007w1gfkqbcdd5g`

## 35. KALE BABY  <sub>PROD · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2 pack · 1 pack = 680.3879999999999 g → **1360.78 g** per case | $0.0247/g |
| **invoice** ×1 | 1 × 5 LB → **2267.96 g** | $0.0148/g |
| | <sub>Sysco Canada, Inc. · 2026-06-06 → 2026-06-06 · $33.07 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 1.67× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.60×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $67.16 → $40.30 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmq8rjsnn00073d2p65abfoe9`

## 36. Vinegar Red Wine  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2 each · 1 each = 5000 ml → **10000 ml** per case | $0.0017/ml |
| **invoice** ×1 | 1 × 5 l → **5000 ml** | $0.0034/ml |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-15 → 2026-06-15 · $34.04 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 2 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 2-pack**
- disagreement: **2.00×** (item ÷ invoice)
- riding on it: **5 recipe lines** · stock value $25.53 → $51.06 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c25d4c95f893948fa9f9412a`

## 37. CUCUMBER FRESH  <sub>PROD · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 24 each · 1 each = 1 each → **24 each** per case | $0.72/each |
| **invoice** ×1 | 1 × 6 each → **6 each** | $2.86/each |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-15 → 2026-06-15 · $68.72 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 4 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 4-pack**
- disagreement: **4.00×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmprb2h2u000bw1gfnborryjv`

## 38. Cucumber Long  <sub>PROD · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 6 each → **6 each** per case | $3.74/each |
| **invoice** ×2 | 1 × 12 each → **12 each** | $1.87/each |
| | <sub>Sysco Canada, Inc. · 2026-06-23 → 2026-07-11 · $67.38 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 2.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.50×** (item ÷ invoice)
- riding on it: **1 recipe line** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c9a24953627b446fbb652693`

## 39. Pigs Blood  <sub>MEAT · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 2267.96 g → **2267.96 g** per case | $0.0063/g |
| **invoice** ×1 | 1 × 20 kg → **20000 g** | unchanged |
| | <sub>Acecard Food Group LTD · 2026-07-22 → 2026-07-22 · $55.56 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 8.82× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.11×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **1 recipe line** · stock value $126.10 → $126.10 if the invoice claim wins
- ⚠︎ **you are buying from Acecard Food Group LTD, but the primary offer is Two Rivers**.
  The item's format comes from Two Rivers, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite Two Rivers's format.
- `id=ce92005751788448a83de619`

## 40. Cucumbers, Lebanese O/S  <sub>PROD · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 453.592 g → **453.59 g** per case | $0.0097/g |
| **invoice** ×1 | 1 × 10 lb → **4535.92 g** | unchanged |
| | <sub>Sysco Canada, Inc. · 2026-06-23 → 2026-06-23 · $49.52 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 10.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.10×** (item ÷ invoice)
- this item is **rate-priced**, so the chain does NOT set its $/base — the wrong
  format instead corrupts the count readout and how much each receipt credits.
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from Sysco Canada, Inc., but the primary offer is North Arm Farms**.
  The item's format comes from North Arm Farms, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite North Arm Farms's format.
- `id=cmq8qbmpl0007byt8nm771omr`

## 41. black seasame seed  <sub>DRY · OCR_UNDERSTATED</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 each = 1 each · 1 each = 3000 g → **3000 g** per case | $0.0101/g |
| **invoice** ×1 | 1 × 1 kg → **1000 g** | $0.0304/g |
| | <sub>Sysco Canada, Inc. · 2026-07-29 → 2026-07-29 · $30.36 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item = exactly 3 × the invoice's container, and every line reads packQty 1 — the invoice is describing ONE unit of a 3-pack**
- disagreement: **3.00×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=c7865d109448a4fc58e5ceae`

## 42. Heavy Cream 35%  <sub>DAIRY · UNCLEAR</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 16 each · 1 each = 1000 ml → **16000 ml** per case | $0.0070/ml |
| **invoice** ×1 | 1 × 946 ml → **946 ml** | $0.12/ml |
| | <sub>SYSCO Canada, Inc. - Vancouver · 2026-06-27 → 2026-06-27 · $28.04 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **item is 16.91× the invoice — neither a clean multiple nor smaller; needs the physical pack**
- disagreement: **16.91×** (item ÷ invoice)
- riding on it: **15 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- primary offer: **Sysco** — edit that offer's format
- `id=cmnmloj0g000fhgf0b7qb7fm9`

## 43. Violas - Edible Flowers (20)  <sub>PROD · ITEM_STALE</sub>

| | claim | reads as |
|---|---|---|
| **item chain** | 1 case = 20 each → **20 each** per case | $0.34/each |
| **invoice** ×1 | 1 × 40 each → **40 each** | $0.17/each |
| | <sub>The Brew Creek Farm · 2026-06-16 → 2026-06-16 · $16.00 ⚠︎ every line reads `packQty 1` — OCR may be printing only the container size</sub> | |

- **the invoice's container is 2.00× BIGGER than the item's whole case — the item cannot be an under-read of the invoice**
- disagreement: **0.50×** (item ÷ invoice)
- riding on it: **0 recipe lines** · stock value $0.00 → $0.00 if the invoice claim wins
- ⚠︎ **you are buying from The Brew Creek Farm, but the primary offer is North Arm Farms**.
  The item's format comes from North Arm Farms, so the two packs may BOTH be right for
  their own supplier. The fix is probably to make the supplier you actually buy from primary —
  not to rewrite North Arm Farms's format.
- `id=cmq8qboa70009byt80axaxxx8`

