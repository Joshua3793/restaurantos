# Item backbone audit: live data, 2026-10-04

Read-only. Run against the live Supabase database from the worktree `library-drawer` (`main` @ 60d470bf, after Stages 1–3). Nothing was written to the database. All scratch scripts and their raw output are in this folder (`a-spine.ts` … `o-unapproved.ts`, `out-*.txt/json`).

## Summary for the owner

Most of the backbone works. Every item that has a supplier box takes its price from its main box, exactly; that holds for all 292 of them. Each item's price is worked out one way everywhere in the app (468 of 468 items match). Recipes cost cleanly: no recipe line is lost to a unit mix-up. The menu's median food cost is 22.5%. Theoretical stock follows the last count sensibly for your 30 most valuable items. Invoice receiving matches the rules on 344 of 349 lines from the last 30 days.

Invoices still have three faults that put wrong or missing numbers into inventory:

1. **Bison bug (yesterday).** Cleveland Meats bison invoices 1147–1151 ($2,322) printed a weight with no "kg". The app read it as grams and saved the Cleveland bison box at **$25 per gram**. It also recorded 92.9 kg of bison as 92.9 g. Someone fixed the box by hand afterwards, but the five receipts are still 1,000× too small. The next unit-less bison invoice will do the same thing again.
2. **Skipped lines (all month).** When an invoice line's case size disagrees with what the app expects, it silently skips that line. The invoice still says "approved", but the delivery never reaches stock or the 30-day average. This happened to 31 lines (about $1,420) in the last 30 days. Cilantro was skipped 7 times, zucchini 6 times and pineapple 5 times.
3. **New products on a split invoice.** When you create a new product on an invoice that is split between Kitchen and Catering, the purchase never lands on that product. There are 21 such lines ($3,096) since June, 3 of them ($908) this month: Venison Striploin, Arctic Char, Arborio rice.

A few smaller items need a quick tidy-up:
- Chili flakes is switched off but still used in 3 recipes at $0.
- Beef Fat Trim has a $0 box, which makes Beef Tallow cost $0.
- Side Fries and Dukkah have ingredient lines pointing at nothing.
- Halloumi's Kitchen stock still uses an old July figure.

## Verdicts

| # | Area | Verdict |
|---|---|---|
| 1 | Item = its main supplier box | ✅ holds |
| 2 | Price per base unit sanity | ⚠️ small gaps |
| 3 | Recipe and menu costing | ✅ holds (data tidy-ups only) |
| 4 | Theoretical stock vs last count | ✅ holds (1 stale allocation, 6 prep shortfalls) |
| 5 | Invoice scanning → inventory | ❌ 3 bugs writing wrong or missing data |
| 6 | Supplier wordings (aliases) | ⚠️ gaps (60 boxed items have no wording) |

---

## 0. Repo scripts (read-only), as run

| Script | Result |
|---|---|
| `verify-cost-parity.ts` | **OK**: 468 items match (LAST); 117 on the 30-day average |
| `verify-stale-column-parity.ts` | Retired columns vs derived: 4 headline prices differ (Anis Seed Whole $0→$37.18, Durum Semolina $0→$35.42, Fingerling Potatoes $32.94→$6.45, Brisket Trim $0→$10.00); 1 box (Fingerling/Sysco); 17 supplier labels differ from the main box, 68 gained one, 176 have neither. Information only: the app no longer reads these columns (dropped in Stage 1e). |
| `audit-unbridged-movements.ts` | **0** unbridged movements across 467 stocked items; 4 items have a density set (Cream cheese, EVOO, Pigs Blood, Tomato Whole Peeled) |
| `audit-create-new-shape.ts` | **0** self-contradictory shapes; 1 candidate: *Fennel O/S, from Rookdown Farm* (`cmt3rtghk00039jm4e8shxuxt`), born from a 12 lb per-weight line but counted in `each` at $5.75/each, no each-measure (3 counts, 2 receipts). JSON in this folder. |
| `audit-offer-supplier-links.ts` | **Clean**: 0 unlinked boxes, 0 name mismatches, 0 duplicate keys, 0 approved sessions without supplier; FK RESTRICT |
| `audit-duplicate-items.ts` | 5 name-similar groups, 3 SEVERED (kennebec potato / Potatoes, Kennebec O/S; two `LETTUCE ROMAINE HEART OF FRSH` rows; Strawberries / Frozen Strawberries). 113 bought-but-in-no-recipe items ($43,339), 63 with a plausible sibling ($29,603). 34 items already pool 2+ supplier boxes. |
| `npx vitest run` | 147 files / 2,360 tests pass (includes the cost-readers gate) |

## 1. Item = primary box: ✅

| Measure | Count |
|---|---|
| Items with ≥1 box (all / active) | 300 / 292 |
| Active boxed items with ≠ 1 primary | **0** |
| Active boxed items whose `packChain` or `pricing` differs from the primary box (jsonb equality) | **0** |
| Merged tombstones still holding boxes | 0 |

## 2. Price per base sanity: ⚠️

**Stocked, active items costing $0 (11):**

| Item | id | Why | Used in recipes |
|---|---|---|---|
| Beef Fat Trim | cmqbngf5w0002p550de0q16ro | primary box (Legends Haul) is PACK $0 | 1 (Beef Tallow) |
| TRSM Spicy Pork Pepperoni, Cold Smoked | cmqvmt26o000vpsi4f7bucdjv | primary box (Two Rivers) RATE $0/g | 0 |
| Cracked coriander seed | c052b354f2bc34f518ff4644 | no box, never priced | 2 |
| Kalamata olive brine | c35a6f0f7e51e43f48902f6b | no box | 1 |
| Yuzu juice | c7c06555e66224c6fb2efb96 | no box | 1 |
| sunchokes | cb1c0d04aa4734d789e2cf03 | no box | 1 |
| Beef Tallow (PREP output) | cmqbnfeww000014opjnhtinlb | its recipe's only ingredient is Beef Fat Trim ($0) | (GF Beef Gravy) |
| sweet potato, Fennel brew creek, duck fat, thai vhilis | cbafc7a8…, c375635f…, c0c7b500…, c02f843b… | no box, no use | 0 |

**30-day average vs last price:**

| Measure | Count |
|---|---|
| Active items on the 30-day average | 117 |
| Fallback: no purchases / PREP-linked | 284 / 66 |
| Average > 20× off last (guard fell back to LAST) | **1**: bison burger (`cbd3ca0e275054e68b8fc3a5`): avg $25.00/g vs last $0.025/g, caused by the bad receipts in §5 |
| Average > 2× off last (still used) | 1: Eggplant (`c79811bfb1ddb4b35aff1cff`), avg $1.40 vs last $2.93/each (1 line) |

**Supplier boxes (334 active):** 2 priced $0 (the Beef Fat Trim and Pepperoni primaries above). 1 box priced more than 20× off its item: *Farm Squash Zuchinni / Sysco* (`ca1d72b76af7949d8b5e166d`), PACK $49.78 read as **$49.78 per g** (item $0.0077/g). It is not the main box and the 20× guard ignores it, but it is corrupt.

## 3. Recipes (AVG_30D through `fetchRecipeWithCost`): ✅

104 active recipes (61 PREP, 43 MENU), 568 lines: 379 on the average, 172 on last price, 17 custom.

| $0 line type | Lines |
|---|---|
| Priced ingredient, line $0 because of a dimension conflict | **0** |
| Priced ingredient, line $0 because qty = 0 | 5: *Mustard Seed Caviar (Pickles)* (`c9051b27-…`): sugar, black peppercorns, star anise, crushed chili; *GF Beef Gravy* (`f80784dd-…`): xanthan gum |
| Water (free, `isStocked=false`) | 11 (expected) |
| Chili flakes (`ce008447f10d940d8baa38ac`), **inactive**, $0 | 3: Pork, Fennel & Chilli Sausage; Pickle Red Onions; Pickled Cucumber B&B |
| Beef Fat Trim $0 → Beef Tallow $0 → GF Beef Gravy | 2 |
| Dangling row (no item, no prep, no name) | 3: *Side Fries* 220 g (`d76b3768-…`, the known "fries severed" line); *Dukkah* 175 g + 2 tbsp (`23847ca3-…`, `f9f72305-…`) |

**Top recipes by $0 lines (excluding Water-only):** Mustard Seed Caviar (Pickles) 4+1 of 10 · Dukkah 2 of 14 · Pickle Red Onions 1 (+water) · Pickled Cucumber B&B 1 (+water) · GF Beef Gravy 2 of 16 · Pork, Fennel & Chilli Sausage 1 of 8 · Side Fries 1 of 1 · Beef Tallow 1 of 1.

**Recipes using switched-off ingredients (they keep a frozen price):** Butter Unsalted (`cmnmloj0e000dhgf078ala430`) in Buttermilk Biscuits, English Muffins, Scones, Vanilla Creme Patissiere ×2; Granny Smith apple (`cbf77af4541e840758301f21`) in Pickle Apples, House Salad Dressing; Parsley (`c205614bd129e4e9bae5f77b`) in Charred Pesto; Chili flakes ×3. Switched-off preps used: Hot Sauce (Mexican Style) in Burger Aioli, Pulled Pork Ranchero, Hot Sauce; Blood Pudding (Rice Version) in Black Pudding; Mint Zhoug in Smoked Pork Cheeks.

**MENU food-cost % (42 with a menu price; median 22.5%):**

| <10% | 10–20% | 20–30% | 30–40% | 40–50% | ≥50% |
|---|---|---|---|---|---|
| 3 | 13 | 18 | 4 | 3 | 1 |

- ≥50%: *Side kids french toast* (`717af4b5-…`), 54% ($1.90 on $3.50), real.
- <10%: *Side Fries* 0% (dangling line); *Mayo* (`8c43cf07-…`) 0%, no ingredients; *Black Pudding* 9.5%, plausible.
- *Plate of Sides* has no ingredients and no price.

## 4. Theoretical stock vs last count: ✅

The last full counts were on 29–30 Sep (Kitchen) and 30 Sep–1 Oct (Catering). Across 467 stocked items there are **0 negative balances** (the ledger floors at zero by design), **0 unbridged movements** and **0 never-counted** items. Total theoretical value is $25,234.

Top 30 by counted value (count = the ledger's physical opening, all revenue centres; "theo" = today's theoretical):

| Item | Count | Theo | Theo/count | Note |
|---|---|---|---|---|
| Cured Salmon | 15,800 g | 13,760 | 0.87 | |
| Smoked Pulled Pork | 51,000 g | 44,640 | 0.88 | |
| Free Run Eggs | 2,160 ea | 1,910 | 0.88 | |
| Bacon Jam | 52,000 g | 48,260 | 0.93 | |
| Smoked Brisket | 16,600 g | 13,225 | 0.80 | |
| Mushroom Ragout | 23,000 g | 21,625 | 0.94 | |
| bison burger | 27,200 g | 24,950 | 0.92 | |
| **Halloumi** | 15,000 g | **3,230** | 0.22 | **residual −10,000 g**: stale Kitchen allocation (below) |
| Slab Bacon | 26,000 g | 24,400 | 0.94 | |
| Sausage BaconPorkHerb | 25,000 g | 23,735 | 0.95 | |
| Butter · Maple Syrup · Soba · Chocolate white · Chilli Red Thai · Grana Padano · Ghee · Brioche · Vanilla Bean · Apples · AP Flour · House Spice Mix · Croissant · Flax meal · EVOO · Kosher Salt · Coconut Oil · Puff Pastry Croissant | | | 0.95–1.00 | little or no movement since the count |
| Hash | 97,890 g | 49,880 | 0.51 | 48 kg sold in 3 days |
| Corn Salsa | 14,500 g | 11,850 | 0.82 | |

No item is above 5× its count. Full rows are in `out-h.json`.

**Gaps:**
- **Halloumi** (`c01b2dee4170c444a9e298c6`): the Kitchen count of 6 cases (15,000 g, 29 Sep) is shadowed by a `StockAllocation` KITCHEN row of 5,000 g last written on 1 Jul. Theoretical reads about 10 kg (≈ $336) low. The same stale-row pattern shows up on **Ricotta** (`cdd469c6cf1704301ac0d905`, 1 vs 0). Only these 2 rows are affected.
- **Recorded use with no recorded production** (shortfall): Hollandaise 3,190 g; Hot Sauce (Mexican Style) 770 g (a switched-off prep still drawn by Pulled Pork Ranchero); Buttermilk Biscuits 36; English Muffins 23; Avocado 1.5; Romaine 0.6. This is prep that isn't being logged, not an engine fault.
- Information only: Cumin, Rice Paper, Red cooking wine and Figs Dried read more than 5× their `stockOnHand`. That is only because `stockOnHand` holds Kitchen alone; Catering's count lives in its allocation. The ledger total matches the counts.

## 5. Invoice scanning, sessions approved in the last 30 days: ❌

71 sessions (11 of them RC-split copies), 417 lines, $57,155.85. All 71 have a supplier linked.

| Match confidence | Lines | | Action | Lines |
|---|---|---|---|---|
| HIGH | 378 | | ADD_SUPPLIER | 245 |
| MEDIUM | 10 | | UPDATE_PRICE | 135 |
| LOW | 8 | | SKIP | 21 |
| NONE | 21 | | CREATE_NEW | 16 |

**Frozen receipt vs a live `lineReceived` recomputation** (supplier's own box via `pickOffer` with SKU; RC copies skipped): 349 compared, **344 agree (98.6%)**, **5 disagree, all bison** (below).

### Bug A: a unit-less weight line is priced and received in grams

*bison burger* (`cbd3ca0e275054e68b8fc3a5`), Cleveland Meats "Bison Grind". The invoices print the quantity and $25 rate **with no unit** (`totalQtyUOM`, `rateUOM` and `rawUnit` are all null).

| Invoice | Date | Billed | Frozen `receivedQtyBase` | Should be | Line $ |
|---|---|---|---|---|---|
| 1149 | 2026-09-06 | 15.775 | 15.775 g | 15,775 g | 394.38 |
| 1148 | 2026-09-02 | 15.86 | 15.86 g | 15,860 g | 396.50 |
| 1150 | 2026-09-12 | 10.41 | 10.41 g | 10,410 g | 260.25 |
| 1151 | 2026-09-26 | 20.27 | 20.27 g | 20,270 g | 506.75 |
| 1147 | 2026-08-27 | 30.585 | 30.585 g | 30,585 g | 764.63 |

- All five were approved on **2026-10-03, 20:30–20:42 UTC**, on current code. The approve-undo record for invoice 1149 shows the Cleveland box being rewritten from `RATE $25/kg` to **`RATE $25/g`**. The four later approvals then received through that box.
- The box was corrected by hand at 20:45 (it is `$25/kg` and primary now), but the five receipts are still 1,000× low.
- **Cause:** in `src/app/api/invoices/sessions/[id]/approve/route.ts` (~line 359), when the line has no measure unit and was not received by weight, the rate unit falls back to `item.baseUnit` (`g`) rather than the box's own `rateUnit` (`kg`). `freezeFormat` then receives the line through that `$25/g` pricing.
- **Price alert:** none fired for the 99,900% box jump (the box wasn't primary at the time).
- **Effect:** the 30-day average already ignores these lines (20× guard) and they predate the 1 Oct count, so current theoretical stock is fine. September's received quantity is 92.9 kg short, and the next unit-less bison invoice will repeat the fault.

### Bug B: a skipped price write also throws away the receipt

The approve route's guards (pack-format disagreement, cross-dimension rate, $0 price) `continue` past the line. The line is left un-approved with no `receivedQtyBase`, and the session is still marked APPROVED. The session message says only "price not updated", but the **delivery quantity is lost too**: it never reaches theoretical stock, COGS purchases or the 30-day average.

Last 30 days: **31 matched lines, about $1,420**:

| Item | Times skipped |
|---|---|
| Cilantro | 7 |
| Farm Squash Zuchinni | 5 + 1 split |
| Pineapple | 5 |
| Liquid Egg Yolk, Lemons | 2 each |
| Brioche Unsliced, Chocolate white ($210.63), Frozen Corn Cobs ($80), Cumin, Pecans, Fingerling Potatoes, Baby Spinach, Leeks, Cucumber Long, Romaine, Olives Kalamata, BLUEBERRY FRESH, Limes | 1 each |

The full list with invoice numbers is in `o-unapproved.ts` output.

### Bug C: new products on an RC-split invoice never get the purchase

A CREATE_NEW line moved into an RC copy keeps `matchedItemId = null` and `receivedQtyBase = null`. The parent line is matched to the new item but carries `splitToSessionId`, which every reader (`count-expected`, `cost-basis`, `cogs`) filters out. So the purchase is counted **nowhere**.

All 21 such lines ever were affected ($3,095.88). The last 30 days include Venison Striploin $444.15 (`cmuj0aqi800132aoc9kum5s70`), Arctic Char Fillet $378 (`cmtnodmsh000110tkeuummq4o`) and RICE ARBORIO $85.39 (`cmuahae97000rce15ep1gtvpu`); Parsley Root $23.94 falls just outside the window. Older ones include Prosciutto di Parma $390.28, Shelled Pistachios $284.94, both chocolate callets, Couscous and the two WOOZA pizzas. By contrast, ADD_SUPPLIER and UPDATE_PRICE lines in RC copies (98 lines, $20,228) are all matched.

### Other invoice findings

- **Price alerts:** 17 fired (10 up, 7 down) across 11 sessions. Undo records exist from 22 Sep onward. On those sessions, both main-price moves of ≥15% fired an alert (Bacon Ends −48.7%, Arctic Char +30.2%). Two box moves of ≥15% did not (bison ×1000, Veal Bones / Legends Haul +139%). The stored `priceDiffPct` on scan lines is not a usable cross-check: it mixes case prices with per-kg prices (Cheese Curd shows "+3,185%").
- **Lines approved onto switched-off items:** 5 lines (~$584): Granny Smith apple ×2, Cod, and B11NV DARK CHOC CALLETS 54% ×2.
- **Corrupt non-primary box:** *Farm Squash Zuchinni / Sysco* at $49.78 (§2), written by the split-parent zucchini line on invoice 444375813.

## 6. Supplier wordings (aliases): ⚠️

478 aliases cover 238 items across 9 suppliers. All were created by the Stage 3 backfill (454) or by renames (24). **None have been created by an invoice approval yet**: the last approval (20:42 UTC) came before the backfill (03:34 UTC on 4 Oct). The legacy match-rule table still holds 556 rules.

| Measure | Count |
|---|---|
| Active boxed items with **no** wording for their main supplier | **60** |
| …of which have been bought on an approved invoice | 24: e.g. MAYONNAISE VEGAN (Sysco), RICE ARBORIO (Sysco), REGGIANO (PARMESAN) (Lekker), AMARENA CHERRIES (Snow Cap), Ground Beef LH Fresh 3x2.5kg, Prosciutto di Parma, Chx Bone Mixed, Beef Tomahawk, Venison Striploin (Legends Haul), Potatoes Kennebec O/S, Celeriac, Pumpkins Sugar, Winter Squash Jester / Red Kuri (North Arm Farms), TRSM Salami / Pepperoni (Two Rivers), 4 Brew Creek Farm items. These are mostly CREATE_NEW items, which never saved a rule. |
| …never on an invoice | 36 |
| Aliases pointing at switched-off items | 8: Cod (Intercity, 4 wordings), B11NV DARK CHOC CALLETS 54% (Snow Cap), Granny Smith apple (Sysco), DETERGENT POT/PAN MANUAL (Sysco), Bacon Banger Sausage (Two Rivers) |
| Aliases pointing at merged or recipe-made items | 0 |
| Same wording used by 2 suppliers | 2, both on the same item ("bison grind": Cleveland + Two Rivers; "zucchini green": North Arm + Your Independent Grocer) |
| Same wording or same code on two different items | 0 |

The lines in §5 that landed on switched-off items (Cod, Granny Smith apple, the callets) were matched in September by the legacy match rules, before these aliases existed. The backfill copied those same wordings onto the switched-off items, so the new matcher inherits the fault unless it skips inactive targets.
