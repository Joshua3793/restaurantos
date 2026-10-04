# Supplier wordings backfill (InvoiceMatchRule → ItemSupplierAlias)

Run: 2026-10-04T01:28:36.246Z · mode: **APPLY** · script: `scripts/backfill-item-supplier-aliases.ts`

## Counts

- InvoiceMatchRule rows read: 556
- Alias rows planned: 454 (already present: 0; to create: 454; on inactive items: 8)
- **Alias rows created: 454** · backup `item-supplier-aliases-backup-2026-10-04T01-28-35-403Z.json`
- Collisions: 79 (joining different items: 0; rules folded: 100)
- Skipped: 0 (none)
- Unresolved: 2 (unknown supplier 2)
- Supplier codes on more than one item: 0

Aliases per supplier:

- Sysco: 207
- Snow Cap: 67
- North Arm Farms: 66
- Legends Haul: 47
- Intercity: 37
- Brew Creek Farm: 13
- Two Rivers: 13
- Your Independent Grocer: 3
- Cleveland Meats: 1

## Unresolved rules (not copied)

| rawDescription | supplierName | item | reason |
|---|---|---|---|
| POTATO 10LB MRJ | Independent (Hector's YIG Garibaldi Highlands) | Yellow potato | unknown supplier |
| POTATO RUSS 10LB MRJ | Independent (Hector's YIG Garibaldi Highlands) | Yellow potato | unknown supplier |

## Skipped rules (merged or recipe-made item)

| rawDescription | supplierName | item | reason |
|---|---|---|---|

## Collisions (kept rule first; useCount summed)

| supplier | normalised text | kept (item · wording · uses) | folded (item · wording · uses) |
|---|---|---|---|
| Legends Haul | bacon ends mixed smoked 10kg case legends | Bacon Ends Mixed Smoked 10kg/case LEGENDS · Bacon Ends Mixed Smoked 10kg/case LEGENDS · 8 | Bacon Ends Mixed Smoked 10kg/case LEGENDS · Bacon Ends Mixed Smoked 10kg/case / LEGENDS · 4<br>Bacon Ends Mixed Smoked 10kg/case LEGENDS · Bacon Ends Mixed Smoked 10kg/case LEGENDS · 2 |
| Legends Haul | bacon slab dbl smoked 4kg pc legends | Slab Bacon · Bacon Slab Dbl Smoked 4kg/pc / LEGENDS · 12 | Slab Bacon · Bacon Slab Dbl Smoked 4kg/pc LEGENDS · 9<br>Slab Bacon · Bacon Slab Dbl Smoked 4kg/pc LEGENDS · 3 |
| Legends Haul | beef brisket aaa 4 x 7kg jbs cargil | Brisket AAA · Beef Brisket AAA 4 x 7kg / JBS/CARGIL · 10 | Brisket AAA · Beef Brisket AAA 4 x 7kg JBS/CARGIL · 9<br>Brisket AAA · Beef Brisket AAA 4 x 7kg JBS/CARGIL · 2 |
| Legends Haul | beef chuck flats premium 6x4kg circle t | Beef Chuck Flat · Beef Chuck Flats Premium 6x4kg CIRCLE T · 2 | Beef Chuck Flat · Beef Chuck Flats Premium 6x4kg / CIRCLE T · 1<br>Beef Chuck Flat · Beef Chuck Flats Premium 6x4kg — CIRCLE T · 1<br>Beef Chuck Flat · Beef Chuck Flats Premium 6x4kg CIRCLE T · 1 |
| Legends Haul | chx breast airline ih 8 10oz 3x10 cs legends | Airline Chicken Breast · Chx Breast Airline IH 8-10oz 3x10/cs LEGENDS · 2 | Airline Chicken Breast · Chx Breast Airline IH 8-10oz 3x10/cs LEGENDS · 1 |
| Legends Haul | eggs dark yolk lw loose 180 case | Free Run Eggs · Eggs Dark Yolk LW Loose 180/case · 3 | Free Run Eggs · Eggs Dark Yolk LW Loose 180/case · 1 |
| Legends Haul | eggs dark yolk lw loose 180 case goldenvall | Free Run Eggs · Eggs Dark Yolk LW Loose 180/case / GOLDENVALL · 19 | Free Run Eggs · Eggs Dark Yolk LW Loose 180/case GOLDENVALL · 15<br>Free Run Eggs · Eggs Dark Yolk LW Loose 180/case GOLDENVALL · 9<br>Free Run Eggs · Eggs Dark Yolk LW Loose 180/case - GOLDENVALL · 1 |
| Legends Haul | pork butt bl fresh 6 cs britco | Pork Butt · Pork Butt BL Fresh 6/cs / BRITCO · 14 | Pork Butt · Pork Butt BL Fresh 6/cs BRITCO · 14<br>Pork Butt · Pork Butt BL Fresh 6/cs BRITCO · 5<br>Pork Butt · Pork Butt BL Fresh 6/cs - BRITCO · 1<br>Pork Butt · Pork Butt BL Fresh 6/cs — BRITCO · 1 |
| Legends Haul | sausage bacon herb fzn 7kg cs legends | Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · Sausage Bacon Herb Fzn 7kg/cs LEGENDS · 8 | Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · Sausage Bacon Herb Fzn 7kg/cs / LEGENDS · 6<br>Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · Sausage Bacon Herb Fzn 7kg/cs LEGENDS · 2 |
| Legends Haul | veal bones knuckle fz 50lb cs whiteveal | Veal Bones · Veal Bones (Knuckle) Fz 50lb/cs WHITEVEAL · 2 | Veal Bones · Veal Bones (Knuckle) Fz 50lb/cs / WHITEVEAL · 1<br>Veal Bones · Veal Bones (Knuckle) Fz 50lb/cs — WHITEVEAL · 1 |
| Intercity | sal sox flt s on pbo prv frz | Salmon · SAL SOX FLT S/ON PBO PRV FRZ · 2 | Salmon · SAL SOX FLT S/ON PBO PRV FRZ · 1 |
| Intercity | tuna albacore loin med ivp msc ov | Albacore tuna · TUNA ALBACORE LOIN MED IVP MSC OV · 2 | Albacore tuna · TUNA ALBACORE LOIN MED IVP MSC OV · 1 |
| Intercity | tuna albacore loin med ivp msc ow 1cs trolling lines wild oceanwise msc c 50507 asc c 00057 green best choice | Albacore tuna · TUNA ALBACORE LOIN MED IVP MSC OW 1CS TROLLING LINES WILD OCEANWISE MSC-C-50507 ASC-C-00057 GREEN - BEST CHOICE · 1 | Albacore tuna · TUNA ALBACORE LOIN MED IVP MSC OW 1cs TROLLING LINES WILD OCEANWISE MSC-C-50507 ASC-C-00057 GREEN - BEST CHOICE · 1 |
| Legends Haul | beef digital aa fz 4 x 2 cov jbs cargil | Beef Digital AA FZ 1kg pkgs — JBS/CARGIL · Beef Digital AA FZ 4 x 2/cov JBS/CARGIL · 2 | Beef Digital AA FZ 1kg pkgs — JBS/CARGIL · Beef Digital AA FZ 4 x 2/cov / JBS/CARGIL · 1 |
| Legends Haul | beef digital aa aaa fz 12 x 1 cov atlantic | Beef Digital AA FZ 1kg pkgs — JBS/CARGIL · Beef Digital AA/AAA FZ 12 x 1/cov / ATLANTIC · 3 | Beef Digital AA FZ 1kg pkgs — JBS/CARGIL · Beef Digital AA/AAA FZ 12 x 1/cov ATLANTIC · 1 |
| Legends Haul | chx thigh bl sl fresh 3x3 5kg avg legends | Chx Thigh BL SL Fresh 3x3.75kg avg — LEGENDS (case weights: 8.300, 9.860 KG) · Chx Thigh BL SL Fresh 3x3.5kg avg / LEGENDS · 2 | Chx Thigh BL SL Fresh 3x3.75kg avg — LEGENDS (case weights: 8.300, 9.860 KG) · Chx Thigh BL SL Fresh 3x3.5kg avg LEGENDS · 2 |
| Legends Haul | flat iron peeled 1 2lb filet legends | Flat Iron Peeled 1-2lb Filet LEGENDS · Flat Iron Peeled 1-2lb Filet LEGENDS · 2 | Flat Iron Peeled 1-2lb Filet LEGENDS · Flat Iron Peeled 1-2lb Filet / LEGENDS · 1 |
| Legends Haul | pizza margherita retail 12 x 615g wooza | Pizza Margherita RETAIL 12 x 615g WOOZA · Pizza Margherita RETAIL 12 x 615g / WOOZA · 3 | Pizza Margherita RETAIL 12 x 615g WOOZA · Pizza Margherita RETAIL 12 x 615g WOOZA · 3 |
| Legends Haul | pizza pepperoni retail 12 x 600g wooza | Pizza Pepperoni RETAIL 12 x 600g WOOZA · Pizza Pepperoni RETAIL 12 x 600g WOOZA · 2 | Pizza Pepperoni RETAIL 12 x 600g WOOZA · Pizza Pepperoni RETAIL 12 x 600g / WOOZA · 1 |
| Legends Haul | pork belly b l rindon 4 5 kg each britco | pork belly · Pork Belly B/L Rindon 4.5 kg Each BRITCO · 3 | pork belly · Pork Belly B/L Rindon 4.5 kg Each — BRITCO · 1 |
| Legends Haul | sausage baconporkherb rtl 8x4 cs legends | Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · Sausage BaconPorkHerb RTL 8x4/cs / LEGENDS · 1 | Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · Sausage BaconPorkHerb RTL 8x4/cs LEGENDS · 1 |
| North Arm Farms | cucumbers lebanese o s lb from rootdown farm in pemberton bc organic | Cucumbers, Lebanese O/S · Cucumbers, Lebanese O/S - lb, from Rootdown Farm in Pemberton, BC (organic) · 2 | Cucumbers, Lebanese O/S · Cucumbers, Lebanese O/S — lb, from Rootdown Farm in Pemberton, BC (organic) · 1 |
| North Arm Farms | peaches 20lb case panoramam orchard oliver bc | peaches · Peaches — 20lb case, Panoramam Orchard, Oliver, BC · 1 | peaches · Peaches - 20lb case, Panoramam Orchard, Oliver, BC · 1 |
| North Arm Farms | potatoes banana fingerling sm small | Fingerling Potatoes · Potatoes, Banana Fingerling Sm — Small · 1 | Fingerling Potatoes · Potatoes, Banana Fingerling Sm - Small · 1 |
| North Arm Farms | salad mix o s lb from rootdown farms in pemberton bc | Salad Mix O/S · Salad Mix O/S — lb, from Rootdown Farms in Pemberton, BC · 1 | Salad Mix O/S · Salad Mix O/S, lb, from Rootdown Farms in Pemberton, BC · 1 |
| North Arm Farms | zucchini green 6 plus | Farm Squash Zuchinni · Zucchini - Green — 6" plus · 1 | Farm Squash Zuchinni · Zucchini - Green, 6" plus · 1 |
| Snow Cap | powder mexican chili | Mexican Chili Powder · *POWDER* MEXICAN CHILI · 6 | Mexican Chili Powder · *POWDER* MEXICAN CHILI · 3<br>Mexican Chili Powder · POWDER MEXICAN CHILI · 1 |
| Snow Cap | 20kg sugar white granulated | Sugar white granulated · 20KG SUGAR WHITE GRANULATED · 8 | Sugar white granulated · 20KG Sugar White Granulated · 1<br>Sugar white granulated · 20KG SUGAR WHITE GRANULATED · 1 |
| Snow Cap | 5kg cashews whole w320 | Cashews · 5KG Cashews Whole W320 · 1 | Cashews · 5KG CASHEWS WHOLE W320 · 1 |
| Snow Cap | 5kg zephyr white chocolate 34 | Chocolate white · 5KG ZEPHYR WHITE CHOCOLATE 34% · 4 | Chocolate white · 5KG ZEPHYR WHITE CHOCOLATE 34% · 3 |
| Snow Cap | bread brioche clubhouse unslic | Brioche Unsliced · BREAD BRIOCHE CLUBHOUSE UNSLIC · 19 | Brioche Unsliced · BREAD BRIOCHE CLUBHOUSE UNSLIC · 4 |
| Snow Cap | bread brioche clubhouse unsliced | Brioche Unsliced · BREAD BRIOCHE CLUBHOUSE UNSLICED · 3 | Brioche Unsliced · Bread Brioche Clubhouse Unsliced · 1 |
| Snow Cap | bread soft white loaf gf prom | GF SOFT WHITE LOAF · BREAD SOFT WHITE LOAF GF PROM · 5 | GF SOFT WHITE LOAF · BREAD SOFT WHITE LOAF GF PROM · 1 |
| Snow Cap | bun hamburger brioche sliced | Burger Bun Sliced · BUN HAMBURGER BRIOCHE SLICED · 16 | Burger Bun Sliced · Bun Hamburger Brioche Sliced · 1<br>Burger Bun Sliced · BUN HAMBURGER BRIOCHE SLICED · 1 |
| Snow Cap | butter unsalted bulk canadian | Butter · BUTTER UNSALTED BULK CANADIAN · 4 | Butter · Butter Unsalted Bulk Canadian · 1 |
| Snow Cap | buttermilk cult 3 25 meadowfr | Buttermilk · BUTTERMILK CULT 3.25% MEADOWFR · 19 | Buttermilk · BUTTERMILK CULT 3.25% MEADOWFR · 2<br>Buttermilk · Buttermilk Cult 3.25% Meadowfr · 1 |
| Snow Cap | english muffin gf 4pk | ENGLISH MUFFIN GF · ENGLISH MUFFIN GF 4PK · 6 | ENGLISH MUFFIN GF · ENGLISH MUFFIN GF 4PK · 2<br>ENGLISH MUFFIN GF · English Muffin GF 4PK · 1 |
| Snow Cap | meadowfresh homo milk | Milk Whole HOMOGENIZED · MEADOWFRESH HOMO MILK · 26 | Milk Whole HOMOGENIZED · MEADOWFRESH HOMO MILK · 8<br>Milk Whole HOMOGENIZED · Meadowfresh Homo Milk · 1 |
| Snow Cap | organic flour all purpose white | All Purpose Flour · ORGANIC FLOUR ALL PURPOSE WHITE · 1 | All Purpose Flour · ORGANIC FLOUR ALL PURPOSE WHITE · 1 |
| Snow Cap | organic flour allpurpose white | All Purpose Flour · ORGANIC FLOUR ALLPURPOSE WHITE · 23 | All Purpose Flour · ORGANIC FLOUR ALLPURPOSE WHITE · 2 |
| Snow Cap | paprika smoked delcano repack | Paprika smoked · PAPRIKA SMOKED DELCANO REPACK · 9 | Paprika smoked · PAPRIKA SMOKED DELCANO REPACK · 2 |
| Snow Cap | pita bread white retail 49986 | Pita Bread · PITA BREAD WHITE RETAIL 49986 · 5 | Pita Bread · PITA BREAD WHITE RETAIL 49986 · 2 |
| Snow Cap | pure maple syrup 3 | Maple Syrup · PURE MAPLE SYRUP #3 · 4 | Maple Syrup · Pure Maple Syrup #3 · 1 |
| Snow Cap | salt diamond crystal kosher | Kosher Salt · SALT DIAMOND CRYSTAL KOSHER · 18 | Kosher Salt · SALT DIAMOND CRYSTAL KOSHER · 2 |
| Snow Cap | seed cumin ground 1kg | Cumin · SEED CUMIN GROUND 1KG · 8 | Cumin · SEED CUMIN GROUND 1KG · 1 |
| Snow Cap | tomato crushed san benito | Tomato Crushed San Benito · TOMATO CRUSHED SAN BENITO · 6 | Tomato Crushed San Benito · TOMATO CRUSHED SAN BENITO · 3 |
| Snow Cap | tomato whole peeled organic | Tomato Whole Peeled · TOMATO WHOLE PEELED *ORGANIC* · 6 | Tomato Whole Peeled · TOMATO WHOLE PEELED *ORGANIC* · 3 |
| Snow Cap | vanilla beans premium | Vanilla Bean · VANILLA BEANS PREMIUM · 5 | Vanilla Bean · Vanilla Beans Premium · 1<br>Vanilla Bean · VANILLA BEANS PREMIUM · 1 |
| Sysco | avocado hass fresh | Avocado · AVOCADO HASS FRESH · 21 | Avocado · AVOCADO HASS FRESH · 1 |
| Sysco | basil fresh herb | Basil · BASIL FRESH HERB · 9 | Basil · BASIL FRESH HERB · 1 |
| Sysco | bun hamburger brioche sli | Burger Bun Sliced · BUN HAMBURGER BRIOCHE SLI · 15 | Burger Bun Sliced · BUN HAMBURGER BRIOCHE SLI · 1 |
| Sysco | cabbage red fdsvc | CABBAGE RED FDSVC · CABBAGE RED FDSVC · 16 | CABBAGE RED FDSVC · CABBAGE RED FDSVC · 1 |
| Sysco | cheese cheddar smk | Cheddar smoked · CHEESE CHEDDAR SMK · 13 | Cheddar smoked · CHEESE CHEDDAR SMK · 1<br>Cheddar smoked · CHEESE CHEDDAR SMK · 1 |
| Sysco | cheese cream plain | Cream cheese · CHEESE CREAM PLAIN · 2 | Cream cheese · CHEESE CREAM PLAIN · 1 |
| Sysco | cheese feta trdtnl cdn | Feta · CHEESE FETA TRDTNL CDN · 8 | Feta · CHEESE FETA TRDTNL CDN/ · 1 |
| Sysco | cheese goat rolls 2x1kg | Goats Cheese · CHEESE GOAT ROLLS 2X1KG · 17 | Goats Cheese · CHEESE GOAT ROLLS 2x1KG · 1 |
| Sysco | cheese havarti plain crm sty 41519 | Havarti cheese · CHEESE HAVARTI PLAIN CRM STY 41519 · 1 | Havarti cheese · CHEESE HAVARTI PLAIN CRM STY / 41519 · 1 |
| Sysco | cilantro clean wash fresh herb | Cilantro · CILANTRO CLEAN WASH FRESH HERB · 18 | Cilantro · CILANTRO CLEAN WASH FRESH HERB · 1 |
| Sysco | dill baby fresh herb | Dill · DILL BABY FRESH HERB · 12 | Dill · DILL BABY FRESH HERB · 2 |
| Sysco | egg yolk frsh low salt | Liquid Egg Yolk · EGG YOLK FRSH LOW SALT · 14 | Liquid Egg Yolk · EGG YOLK FRSH LOW SALT · 1 |
| Sysco | grape red frsh seedls clam | GRAPE RED FRSH SEEDLS CLAM · GRAPE RED FRSH SEEDLS CLAM · 1 | GRAPE RED FRSH SEEDLS CLAM · GRAPE RED FRSH SEEDLS CLAM · 1 |
| Sysco | juice lime pstzd ultra prm | Lime Juice · JUICE LIME PSTZD ULTRA PRM · 3 | Lime Juice · JUICE LIME PSTZD ULTRA PRM · 1 |
| Sysco | lettuce leaf bulk living burgr | Lettuce Burger · LETTUCE LEAF BULK LIVING BURGR · 13 | Lettuce Burger · LETTUCE LEAF BULK LIVING BURGR · 1 |
| Sysco | lettuce romaine heart of frsh | LETTUCE ROMAINE HEART OF FRSH · LETTUCE ROMAINE HEART OF FRSH · 8 | LETTUCE ROMAINE HEART OF FRSH · LETTUCE ROMAINE HEART OF FRSH · 1 |
| Sysco | mint fresh herb | Mint · MINT FRESH HERB · 12 | Mint · MINT FRESH HERB · 1 |
| Sysco | mushroom port lrg w stem frsh | Mushrooms Mix · MUSHROOM PORT LRG W/STEM FRSH · 10 | Mushrooms Mix · MUSHROOM PORT LRG W/STEM FRSH · 1 |
| Sysco | oil canola 4x3l | Oil Canola · OIL CANOLA 4X3L · 5 | Oil Canola · OIL CANOLA 4X3L · 2 |
| Sysco | oil canola jib 52326419 | Oil Canola Fryer · OIL CANOLA JIB 52326419 · 1 | Oil Canola Fryer · OIL CANOLA JIB / 52326419 · 1 |
| Sysco | oil olive extra virgin can | Extra Virgin Olive Oil · OIL OLIVE EXTRA VIRGIN CAN · 12 | Extra Virgin Olive Oil · OIL OLIVE, EXTRA VIRGIN CAN · 3<br>Extra Virgin Olive Oil · OIL OLIVE EXTRA VIRGIN CAN · 1 |
| Sysco | onion red jumbo box | Onion Red · ONION RED JUMBO BOX · 8 | Onion Red · ONION RED JUMBO BOX · 1 |
| Sysco | onion yellow jumbo box | Onions Yellow · ONION YELLOW JUMBO BOX · 19 | Onions Yellow · ONION YELLOW JUMBO BOX · 3 |
| Sysco | orange navel fancy fresh | Oranges · ORANGE NAVEL FANCY FRESH · 3 | Oranges · ORANGE NAVEL FANCY FRESH · 1 |
| Sysco | paste miso japnse wht | Miso · PASTE MISO JAPNSE WHT · 5 | Miso · PASTE MISO JAPNSE WHT · 1 |
| Sysco | pineapple fresh | Pineapple · PINEAPPLE FRESH · 16 | Pineapple · PINEAPPLE FRESH · 2 |
| Sysco | pineapple fresh golden ripe | Pineapple · PINEAPPLE FRESH GOLDEN RIPE · 3 | Pineapple · PINEAPPLE, FRESH GOLDEN RIPE · 1 |
| Sysco | shallot peeled fresh | Shallots · SHALLOT PEELED FRESH · 8 | Shallots · SHALLOT PEELED FRESH · 1 |
| Sysco | sour cream reg | Sour Cream · SOUR CREAM REG · 1 | Sour Cream · SOUR CREAM REG · 1 |
| Sysco | strawberry fresh calif clamshl | STRAWBERRY FRESH CALIF CLAMSHL · STRAWBERRY FRESH CALIF CLAMSHL · 3 | STRAWBERRY FRESH CALIF CLAMSHL · STRAWBERRY FRESH CALIF CLAMSHL · 1 |
| Sysco | tortilla corn yel g f 6 in | Yellow corn Tortillas · TORTILLA CORN YEL G/F 6 IN · 12 | Yellow corn Tortillas · TORTILLA CORN YEL G/F 6 IN · 1 |

## Supplier codes on more than one item (information only)

| supplier | code | items |
|---|---|---|
