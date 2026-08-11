/**
 * BC market / benchmark price bands for inventory audit.
 *
 * Each entry gives the expected FOODSERVICE (wholesale, pre-tax) price band for
 * a product class in BC, denominated per kg (MASS), per L (VOLUME), or per each
 * (COUNT) — the same denominators `audit-inventory-prices.ts` reports.
 *
 * `src` records provenance so a flag can be defended:
 *   STATCAN — derived from Statistics Canada table 18-10-0245-01, "Monthly
 *             average retail prices for selected products", GEO = British
 *             Columbia, June 2026 (the latest month published). Retail is an
 *             UPPER bound on wholesale, so bands are set at roughly
 *             0.4–1.0 × the BC retail figure; the retail figure itself is
 *             quoted in `note`.
 *   FS      — BC/Vancouver foodservice distributor price range (Sysco /
 *             GFS / Legends Haul / Two Rivers class pricing). Judgement-based
 *             industry range, not a published quote — treat a flag from an FS
 *             band as "worth a look", not as proof.
 *
 * Matching is by ordered regex against the item name — FIRST match wins, so
 * specific patterns must precede generic ones.
 */

export type BenchUnit = 'kg' | 'L' | 'each'
export interface Benchmark {
  match: RegExp
  unit: BenchUnit
  lo: number
  hi: number
  src: 'STATCAN' | 'FS'
  note?: string
}

export const BENCHMARKS: Benchmark[] = [
  // ── SPECIFIC OVERRIDES ─────────────────────────────────────────────────────
  // Products whose names collide with a broader pattern further down. These
  // must be matched first or the generic band produces a bogus flag.
  { match: /buttermilk/i, unit: 'L', lo: 2, hi: 5, src: 'FS' },
  { match: /cocoa butter/i, unit: 'kg', lo: 25, hi: 90, src: 'FS' },
  { match: /peanut butter/i, unit: 'kg', lo: 4, hi: 12, src: 'STATCAN', note: 'BC retail peanut butter $6.27/kg' },
  { match: /oil grapeseed|grapeseed/i, unit: 'L', lo: 6, hi: 16, src: 'FS' },
  { match: /mushroom\s+oyster|oyster mushroom/i, unit: 'kg', lo: 16, hi: 36, src: 'FS' },
  { match: /fennel seed/i, unit: 'kg', lo: 8, hi: 45, src: 'FS' },
  { match: /bun burger swt potato|sweet potato jal/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /sun dried tomato/i, unit: 'kg', lo: 12, hi: 35, src: 'FS' },
  { match: /tomato paste/i, unit: 'L', lo: 2.5, hi: 8, src: 'FS' },
  { match: /tomato crushed|tomato whole peeled|canned tomato/i, unit: 'L', lo: 1.8, hi: 6, src: 'STATCAN', note: 'BC retail canned tomatoes $2.43/796 ml = $3.05/L' },
  { match: /caper surfine/i, unit: 'each', lo: 15, hi: 120, src: 'FS', note: 'sold as a single foodservice pail — per-each band is wide by nature' },
  { match: /^capers$/i, unit: 'L', lo: 6, hi: 22, src: 'FS' },
  { match: /green onions? o\/s|green onion.*bunch/i, unit: 'each', lo: 0.8, hi: 3, src: 'FS' },
  { match: /potatoes,? kennebec o\/s|kohlrabi/i, unit: 'each', lo: 1, hi: 4.5, src: 'FS' },

  // ─────────────────────────── DAIRY & EGG ───────────────────────────────────
  { match: /^butter(\s|$)|butter unsalted/i, unit: 'kg', lo: 10, hi: 17, src: 'STATCAN', note: 'BC retail $6.13/454 g = $13.50/kg' },
  { match: /margerine|margarine/i, unit: 'kg', lo: 4, hi: 9, src: 'STATCAN', note: 'BC retail margarine $6.21/907 g = $6.85/kg' },
  { match: /buttermilk/i, unit: 'L', lo: 2, hi: 5, src: 'FS' },
  { match: /milk whole|homogenized/i, unit: 'L', lo: 1.6, hi: 3.2, src: 'STATCAN', note: 'BC retail 4 L $6.25 = $1.56/L; 1 L $3.18' },
  { match: /milk condensed/i, unit: 'L', lo: 8, hi: 20, src: 'FS' },
  { match: /heavy cream|cream whipped|whipping cream/i, unit: 'L', lo: 4.5, hi: 9, src: 'STATCAN', note: 'BC retail cream $4.89/L (10–35% blended)' },
  { match: /sour cream/i, unit: 'L', lo: 4, hi: 9, src: 'FS' },
  { match: /greek style yogurt|yogurt/i, unit: 'kg', lo: 4, hi: 9, src: 'STATCAN', note: 'BC retail $3.90/500 g = $7.80/kg' },
  { match: /cream cheese/i, unit: 'kg', lo: 9, hi: 17, src: 'FS' },
  { match: /mascarpone/i, unit: 'kg', lo: 16, hi: 30, src: 'FS' },
  { match: /ricotta/i, unit: 'kg', lo: 8, hi: 16, src: 'FS' },
  { match: /cheese curd/i, unit: 'kg', lo: 12, hi: 22, src: 'FS' },
  { match: /cheddar|provolone|havarti|cheese swiss|swiss/i, unit: 'kg', lo: 11, hi: 22, src: 'STATCAN', note: 'BC retail block cheese $7.32/500 g = $14.64/kg' },
  { match: /grana padano|parmesan|parmigiano/i, unit: 'kg', lo: 22, hi: 38, src: 'FS' },
  { match: /goats? cheese|chevre/i, unit: 'kg', lo: 20, hi: 36, src: 'FS' },
  { match: /halloumi/i, unit: 'kg', lo: 20, hi: 38, src: 'FS' },
  { match: /feta/i, unit: 'kg', lo: 11, hi: 22, src: 'FS' },
  { match: /free run eggs|^eggs?$/i, unit: 'each', lo: 0.25, hi: 0.55, src: 'STATCAN', note: 'BC retail $5.63/dozen = $0.47/each' },
  { match: /liquid egg yolk/i, unit: 'kg', lo: 6, hi: 13, src: 'FS' },

  // ─────────────────────────── MEAT & CHARCUTERIE ────────────────────────────
  { match: /beef fat trim|pork fat|^duck fat/i, unit: 'kg', lo: 2, hi: 9, src: 'FS' },
  { match: /brisket/i, unit: 'kg', lo: 14, hi: 26, src: 'FS' },
  { match: /beef chuck|beef digital/i, unit: 'kg', lo: 14, hi: 28, src: 'STATCAN', note: 'BC retail beef stewing cuts $25.81/kg' },
  { match: /flat iron/i, unit: 'kg', lo: 28, hi: 48, src: 'FS' },
  { match: /ground beef/i, unit: 'kg', lo: 10, hi: 19, src: 'STATCAN', note: 'BC retail $18.39/kg' },
  { match: /ground venison|venison/i, unit: 'kg', lo: 22, hi: 45, src: 'FS' },
  { match: /bison burger|bison(?! herb)/i, unit: 'kg', lo: 18, hi: 34, src: 'FS' },
  { match: /veal bones|beef bones/i, unit: 'kg', lo: 3, hi: 9, src: 'FS' },
  { match: /chx bone|chicken bone/i, unit: 'kg', lo: 2, hi: 7, src: 'FS' },
  { match: /airline chicken|chicken breast/i, unit: 'kg', lo: 12, hi: 24, src: 'STATCAN', note: 'BC retail chicken breast $17.34/kg' },
  { match: /chx thigh|chicken thigh/i, unit: 'kg', lo: 9, hi: 18, src: 'STATCAN', note: 'BC retail chicken thigh $13.40/kg' },
  { match: /chicken schnitzel/i, unit: 'kg', lo: 11, hi: 22, src: 'FS' },
  { match: /pork butt|pork shoulder/i, unit: 'kg', lo: 6, hi: 13, src: 'STATCAN', note: 'BC retail pork shoulder $10.78/kg' },
  { match: /pork tenderloin|pork loin/i, unit: 'kg', lo: 7, hi: 15, src: 'STATCAN', note: 'BC retail pork loin $9.67/kg' },
  { match: /pork back ribs|pork rib/i, unit: 'kg', lo: 9, hi: 20, src: 'STATCAN', note: 'BC retail pork rib cuts $10.53/kg' },
  { match: /pork belly/i, unit: 'kg', lo: 9, hi: 18, src: 'FS' },
  { match: /pork cheeks/i, unit: 'kg', lo: 7, hi: 16, src: 'FS' },
  { match: /ground pork/i, unit: 'kg', lo: 7, hi: 15, src: 'FS' },
  { match: /pigs? blood/i, unit: 'kg', lo: 2, hi: 10, src: 'FS' },
  { match: /bacon ends/i, unit: 'kg', lo: 5, hi: 11, src: 'FS' },
  { match: /slab bacon|^bacon/i, unit: 'kg', lo: 11, hi: 21, src: 'STATCAN', note: 'BC retail bacon $7.02/500 g = $14.04/kg' },
  { match: /ham bnls|boston ham|ham rosemary|^ham/i, unit: 'kg', lo: 12, hi: 30, src: 'FS' },
  { match: /prosciutto di parma/i, unit: 'kg', lo: 34, hi: 58, src: 'FS' },
  { match: /duck prosciutto/i, unit: 'kg', lo: 70, hi: 130, src: 'FS' },
  { match: /bresaola/i, unit: 'kg', lo: 70, hi: 130, src: 'FS' },
  { match: /coppa|salami|nduja|pepperoni|chorizo|sausage/i, unit: 'kg', lo: 14, hi: 75, src: 'FS', note: 'wide band — fresh sausage low end, cured salumi high end' },
  { match: /duck breast/i, unit: 'kg', lo: 26, hi: 50, src: 'FS' },

  // ─────────────────────────── SEAFOOD ───────────────────────────────────────
  { match: /pacific halibut|halibut/i, unit: 'kg', lo: 45, hi: 90, src: 'FS', note: 'BC halibut fillet ~$22–40/lb wholesale' },
  { match: /sablefish|black cod/i, unit: 'kg', lo: 45, hi: 90, src: 'FS' },
  { match: /^salmon/i, unit: 'kg', lo: 22, hi: 45, src: 'STATCAN', note: 'BC retail salmon $34.71/kg' },
  { match: /albacore|tuna(?! flaked| canned)/i, unit: 'kg', lo: 26, hi: 55, src: 'FS' },
  { match: /^cod/i, unit: 'kg', lo: 18, hi: 40, src: 'FS' },
  { match: /^trout/i, unit: 'kg', lo: 20, hi: 42, src: 'FS' },
  { match: /scallop/i, unit: 'kg', lo: 55, hi: 110, src: 'FS' },
  { match: /oyster n\/shell|oysters? kusshi|^oysters?$/i, unit: 'each', lo: 0.7, hi: 2.4, src: 'FS', note: 'BC beach/tray oysters ~$0.80–1.20; Kusshi/premium $1.20–2.00 each' },

  // ─────────────────────────── PRODUCE — leaf & herb ─────────────────────────
  { match: /microgreen|shiso leaves|edible (flower|begonia)|violas|cucumber blossom|^sorrel/i, unit: 'each', lo: 0.2, hi: 40, src: 'FS', note: 'specialty garnish — priced per tray/pack, no commodity benchmark' },
  { match: /baby mixed greens|salad mix|spring mix|lettuce - red tango|salad greens/i, unit: 'kg', lo: 9, hi: 26, src: 'STATCAN', note: 'BC retail salad greens $4.99/142 g = $35.14/kg' },
  { match: /spinach baby|baby spinach/i, unit: 'kg', lo: 8, hi: 20, src: 'FS' },
  { match: /kale baby/i, unit: 'kg', lo: 9, hi: 22, src: 'FS' },
  { match: /arugula/i, unit: 'kg', lo: 9, hi: 24, src: 'FS' },
  { match: /^kale$/i, unit: 'each', lo: 1.2, hi: 3.5, src: 'FS' },
  { match: /lettuce romaine|romaine/i, unit: 'each', lo: 1.2, hi: 3.2, src: 'STATCAN', note: 'BC retail romaine $3.54/unit' },
  { match: /lettuce boston|butter lettuce|lettuce butter|lettuce burger|tuscan lettuce|iceberg/i, unit: 'each', lo: 1.2, hi: 3.4, src: 'STATCAN', note: 'BC retail iceberg $3.70/unit' },
  { match: /endive/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /^basil/i, unit: 'kg', lo: 22, hi: 55, src: 'FS' },
  { match: /^chives?( farm)?$/i, unit: 'kg', lo: 25, hi: 75, src: 'FS' },
  { match: /^cilantro farm/i, unit: 'each', lo: 0.8, hi: 4.5, src: 'FS' },
  { match: /^cilantro|^parsley|^dill|^mint|^thyme|^rosemary$|^sage/i, unit: 'kg', lo: 9, hi: 45, src: 'FS', note: 'fresh soft herbs, 1 lb foodservice box' },

  // ─────────────────────────── PRODUCE — fruit ───────────────────────────────
  { match: /granny smith|^apples?$/i, unit: 'each', lo: 0.35, hi: 1.1, src: 'STATCAN', note: 'BC retail apples $6.71/kg ≈ $1.10/apple at 165 g' },
  { match: /^pears?$/i, unit: 'each', lo: 0.4, hi: 1.3, src: 'STATCAN', note: 'BC retail pears $6.34/kg ≈ $1.15/pear at 180 g' },
  { match: /^oranges?$/i, unit: 'each', lo: 0.3, hi: 1.0, src: 'STATCAN', note: 'BC retail oranges $4.67/kg' },
  { match: /grapefruit/i, unit: 'each', lo: 0.6, hi: 1.8, src: 'FS' },
  { match: /^lemons?$/i, unit: 'each', lo: 0.3, hi: 1.1, src: 'STATCAN', note: 'BC retail lemons $1.12/unit' },
  { match: /^limes?$/i, unit: 'kg', lo: 2.5, hi: 7, src: 'STATCAN', note: 'BC retail limes $1.22/unit ≈ $12/kg at 100 g; wholesale case much lower' },
  { match: /^grapes?$|grape red frsh|grape.*seedls/i, unit: 'kg', lo: 4, hi: 11, src: 'STATCAN', note: 'BC retail grapes $9.02/kg' },
  { match: /blueberry cultivated iqf|iqf.*blueberr|blueberr.*iqf/i, unit: 'kg', lo: 5, hi: 12, src: 'FS', note: 'IQF blueberry 20 lb case ~$5–10/kg' },
  { match: /freeze dried|freeze-dried/i, unit: 'kg', lo: 60, hi: 220, src: 'FS' },
  { match: /blueberr/i, unit: 'kg', lo: 5, hi: 18, src: 'FS' },
  { match: /frozen strawberry|strawberry iqf/i, unit: 'kg', lo: 3.5, hi: 10, src: 'STATCAN', note: 'BC retail frozen strawberries $5.71/600 g = $9.52/kg' },
  { match: /strawberr/i, unit: 'kg', lo: 5, hi: 14, src: 'STATCAN', note: 'BC retail strawberries $4.47/454 g = $9.85/kg' },
  { match: /raspberr/i, unit: 'kg', lo: 10, hi: 28, src: 'FS' },
  { match: /peach/i, unit: 'kg', lo: 3, hi: 10, src: 'FS' },
  { match: /rhubarb/i, unit: 'kg', lo: 4, hi: 12, src: 'FS' },
  { match: /melon cantaloupe|cantaloupe/i, unit: 'each', lo: 2, hi: 5, src: 'STATCAN', note: 'BC retail cantaloupe $4.63/unit' },
  { match: /watermelon/i, unit: 'each', lo: 5, hi: 14, src: 'FS' },
  { match: /pineapple/i, unit: 'each', lo: 2.5, hi: 6.5, src: 'FS' },

  // ─────────────────────────── PRODUCE — veg ─────────────────────────────────
  { match: /fingerling potato/i, unit: 'kg', lo: 3, hi: 9, src: 'FS' },
  { match: /sweet potato/i, unit: 'kg', lo: 2.5, hi: 6, src: 'STATCAN', note: 'BC retail $5.49/kg' },
  { match: /^potato|potatoes|kennebec|yukon/i, unit: 'kg', lo: 1, hi: 4, src: 'STATCAN', note: 'BC retail 4.54 kg bag $7.96 = $1.75/kg' },
  { match: /sunchoke/i, unit: 'kg', lo: 6, hi: 18, src: 'FS' },
  { match: /onion fresh cippolini|cippolini/i, unit: 'kg', lo: 5, hi: 13, src: 'FS' },
  { match: /golf ball onion|onions? yellow|onion red/i, unit: 'kg', lo: 1.2, hi: 5, src: 'STATCAN', note: 'BC retail onions $5.47/kg; 1.36 kg bag $5.27 = $3.88/kg' },
  { match: /onion green|green onions?/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /shallot/i, unit: 'kg', lo: 6, hi: 18, src: 'FS' },
  { match: /^garlic$/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /black garlic/i, unit: 'kg', lo: 60, hi: 160, src: 'FS' },
  { match: /^ginger$/i, unit: 'kg', lo: 6, hi: 18, src: 'FS' },
  { match: /horseradish/i, unit: 'kg', lo: 8, hi: 26, src: 'FS' },
  { match: /^carrots?$/i, unit: 'kg', lo: 1.2, hi: 4, src: 'STATCAN', note: 'BC retail $5.07/1.36 kg = $3.73/kg' },
  { match: /^beets?$/i, unit: 'kg', lo: 1.8, hi: 5.5, src: 'FS' },
  { match: /brussel/i, unit: 'kg', lo: 4, hi: 12, src: 'FS' },
  { match: /broccolini/i, unit: 'kg', lo: 9, hi: 22, src: 'FS' },
  { match: /cabbage/i, unit: 'each', lo: 1.5, hi: 5, src: 'STATCAN', note: 'BC retail cabbage $3.04/kg ≈ $3–5 per head' },
  { match: /kohlrabi/i, unit: 'each', lo: 1, hi: 4.5, src: 'FS' },
  { match: /asparagus/i, unit: 'kg', lo: 9, hi: 24, src: 'FS' },
  { match: /^celery$/i, unit: 'each', lo: 0.6, hi: 4.2, src: 'STATCAN', note: 'BC retail celery $4.04/unit' },
  { match: /corn cob/i, unit: 'each', lo: 0.4, hi: 2.5, src: 'FS' },
  { match: /^leeks?/i, unit: 'each', lo: 1, hi: 3.5, src: 'FS' },
  { match: /^fennel(?! seed)/i, unit: 'each', lo: 1.5, hi: 5, src: 'FS' },
  { match: /squash butternut|^squash/i, unit: 'each', lo: 1.2, hi: 5, src: 'STATCAN', note: 'BC retail squash $5.03/kg' },
  { match: /zucchini|zuchinni/i, unit: 'kg', lo: 3, hi: 16, src: 'FS' },
  { match: /eggplant/i, unit: 'each', lo: 1, hi: 3.2, src: 'FS' },
  { match: /avocado/i, unit: 'each', lo: 0.7, hi: 2.5, src: 'STATCAN', note: 'BC retail avocado $2.44/unit' },
  { match: /cucumbers?,? lebanese/i, unit: 'kg', lo: 4, hi: 12, src: 'FS' },
  { match: /cucumber|ciucumber/i, unit: 'each', lo: 0.5, hi: 1.6, src: 'STATCAN', note: 'BC retail cucumber $1.40/unit' },
  { match: /red peppers?|pepper jalapeno|jalepeno|jalapeno/i, unit: 'kg', lo: 3, hi: 9, src: 'STATCAN', note: 'BC retail peppers $8.14/kg' },
  { match: /chilli red thai|thai vhilis|thai chil/i, unit: 'kg', lo: 12, hi: 40, src: 'FS' },
  { match: /tomatillo/i, unit: 'kg', lo: 3, hi: 10, src: 'FS' },
  { match: /heirloom tomato/i, unit: 'kg', lo: 6, hi: 18, src: 'FS' },
  { match: /tomato cherry/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /tomato/i, unit: 'kg', lo: 2.5, hi: 7, src: 'STATCAN', note: 'BC retail tomatoes $5.07/kg' },
  { match: /mushroom button|mushroom crimini|crimini/i, unit: 'kg', lo: 4, hi: 12, src: 'STATCAN', note: 'BC retail mushrooms $2.76/227 g = $12.16/kg' },
  { match: /mushroom portobello/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /mushroom shiitake|shiitake/i, unit: 'kg', lo: 18, hi: 40, src: 'FS' },
  { match: /mushroom.*oyster|oyster mushroom/i, unit: 'kg', lo: 16, hi: 36, src: 'FS' },
  { match: /shimeji/i, unit: 'kg', lo: 24, hi: 55, src: 'FS' },
  { match: /mixed mushroom/i, unit: 'kg', lo: 10, hi: 30, src: 'FS' },
  { match: /dried porcini/i, unit: 'kg', lo: 70, hi: 200, src: 'FS' },
  { match: /radish/i, unit: 'kg', lo: 3, hi: 10, src: 'FS' },

  // ─────────────────────────── BREAD & BAKERY ────────────────────────────────
  { match: /gf soft white loaf|gluten free.*loaf/i, unit: 'kg', lo: 8, hi: 18, src: 'FS' },
  { match: /baguette/i, unit: 'each', lo: 1.2, hi: 4, src: 'FS' },
  { match: /brioche unsliced/i, unit: 'each', lo: 3.5, hi: 11, src: 'FS' },
  { match: /english muffin|gf brioche bun/i, unit: 'each', lo: 0.4, hi: 2, src: 'FS' },
  { match: /bun burger|burger bun/i, unit: 'each', lo: 0.35, hi: 1.2, src: 'FS' },
  { match: /bun burger swt potato/i, unit: 'kg', lo: 6, hi: 16, src: 'FS' },
  { match: /naan/i, unit: 'each', lo: 0.4, hi: 1.6, src: 'FS' },
  { match: /pita/i, unit: 'each', lo: 0.15, hi: 0.8, src: 'STATCAN', note: 'BC retail flatbread/pita $3.55/500 g' },
  { match: /tortilla/i, unit: 'each', lo: 0.06, hi: 0.35, src: 'FS' },
  { match: /croissant plain|^cruffins|pain au chocolate/i, unit: 'each', lo: 0.8, hi: 3.2, src: 'FS' },
  { match: /puff pastry croissant/i, unit: 'each', lo: 0.8, hi: 3.2, src: 'FS' },
  { match: /puff pastry sheet/i, unit: 'each', lo: 1.5, hi: 8, src: 'FS' },
  { match: /pastry shell/i, unit: 'each', lo: 0.3, hi: 3, src: 'FS' },
  { match: /spring roll wrapper|rice paper/i, unit: 'kg', lo: 5, hi: 30, src: 'FS' },
  { match: /pizza (margherita|pepperoni) retail/i, unit: 'kg', lo: 8, hi: 22, src: 'STATCAN', note: 'BC retail frozen pizza $4.78/390 g = $12.26/kg' },
  { match: /graham crumb|gf panko|panko/i, unit: 'kg', lo: 3, hi: 22, src: 'FS' },
  { match: /nori sheet/i, unit: 'each', lo: 0.1, hi: 1.0, src: 'FS' },

  // ─────────────────────────── OILS, VINEGARS, CONDIMENTS ────────────────────
  { match: /oil canola fryer|oil canola|vegetable oil/i, unit: 'L', lo: 2, hi: 5, src: 'STATCAN', note: 'BC retail canola 3 L $10.94 = $3.65/L' },
  { match: /extra virgin olive oil|olive oil/i, unit: 'L', lo: 7, hi: 16, src: 'STATCAN', note: 'BC retail olive oil $11.98/L' },
  { match: /grapeseed/i, unit: 'L', lo: 6, hi: 16, src: 'FS' },
  { match: /sesame oil/i, unit: 'L', lo: 12, hi: 32, src: 'FS' },
  { match: /coconut oil/i, unit: 'kg', lo: 5, hi: 14, src: 'FS' },
  { match: /pan spray oil/i, unit: 'kg', lo: 10, hi: 35, src: 'FS' },
  { match: /vinegar pure white|vinegar apple cider|vinegar red wine|vinegar white wine|rice vinegar/i, unit: 'L', lo: 1, hi: 12, src: 'FS' },
  { match: /ketchup/i, unit: 'L', lo: 2.5, hi: 5.5, src: 'STATCAN', note: 'BC retail ketchup $4.53/L' },
  { match: /mayonnaise/i, unit: 'L', lo: 4, hi: 18, src: 'STATCAN', note: 'BC retail mayo $6.32/890 ml = $7.10/L; vegan carries a premium' },
  { match: /mustard dijon/i, unit: 'L', lo: 3, hi: 9, src: 'FS' },
  { match: /worcestershire/i, unit: 'L', lo: 3, hi: 10, src: 'FS' },
  { match: /tabasco|hot sauce/i, unit: 'L', lo: 12, hi: 45, src: 'FS' },
  { match: /fish sauce/i, unit: 'L', lo: 4, hi: 14, src: 'FS' },
  { match: /tamari|soy sauce/i, unit: 'L', lo: 2, hi: 10, src: 'FS' },
  { match: /mirin/i, unit: 'L', lo: 3, hi: 12, src: 'FS' },
  { match: /gochujang/i, unit: 'kg', lo: 6, hi: 18, src: 'FS' },
  { match: /^miso/i, unit: 'kg', lo: 6, hi: 20, src: 'FS' },
  { match: /tahini/i, unit: 'kg', lo: 8, hi: 18, src: 'FS' },
  { match: /truffle paste/i, unit: 'kg', lo: 120, hi: 500, src: 'FS' },
  { match: /ancho paste/i, unit: 'kg', lo: 12, hi: 45, src: 'FS' },
  { match: /tomato paste/i, unit: 'L', lo: 2.5, hi: 8, src: 'FS' },
  { match: /tomato crushed|tomato whole peeled/i, unit: 'kg', lo: 1.8, hi: 6, src: 'STATCAN', note: 'BC retail canned tomatoes $2.43/796 ml = $3.05/L' },
  { match: /sun dried tomato/i, unit: 'kg', lo: 12, hi: 35, src: 'FS' },
  { match: /olives kalamata|olives mixed|^capers?$|caper surfine/i, unit: 'kg', lo: 8, hi: 26, src: 'FS' },
  { match: /^capers/i, unit: 'L', lo: 6, hi: 22, src: 'FS' },
  { match: /kalamata olive brine/i, unit: 'kg', lo: 0.5, hi: 6, src: 'FS' },
  { match: /apple mustard/i, unit: 'kg', lo: 4, hi: 25, src: 'FS' },
  { match: /green peppercorns/i, unit: 'L', lo: 15, hi: 60, src: 'FS' },
  { match: /^honey$/i, unit: 'kg', lo: 5, hi: 14, src: 'FS' },
  { match: /maple syrup/i, unit: 'kg', lo: 8, hi: 20, src: 'FS' },
  { match: /molasses/i, unit: 'kg', lo: 2, hi: 7, src: 'FS' },
  { match: /lemon juice|lime juice/i, unit: 'L', lo: 4, hi: 20, src: 'FS' },
  { match: /yuzu juice/i, unit: 'L', lo: 25, hi: 120, src: 'FS' },
  { match: /juice cranberry/i, unit: 'L', lo: 1.5, hi: 5, src: 'FS' },
  { match: /red cooking wine|wine red cooking|white wine cooking/i, unit: 'L', lo: 3, hi: 12, src: 'FS' },
  { match: /almond flavor|rum flavor|vanilla extract/i, unit: 'L', lo: 6, hi: 60, src: 'FS' },

  // ─────────────────────────── DRY GOODS / STAPLES ───────────────────────────
  { match: /all purpose flour|whole wheat flour|dark rye flour|durum semolina|^rice flour|chana flour|chickpea flour/i, unit: 'kg', lo: 0.8, hi: 8, src: 'STATCAN', note: 'BC retail wheat flour $5.49/2.5 kg = $2.20/kg' },
  { match: /gluten free flour|chestnut flour/i, unit: 'kg', lo: 4, hi: 40, src: 'FS' },
  { match: /almond meal/i, unit: 'kg', lo: 9, hi: 22, src: 'FS' },
  { match: /sugar white granulated|sugar brown|sugar icing/i, unit: 'kg', lo: 1, hi: 4, src: 'STATCAN', note: 'BC retail white sugar $2.93/2 kg = $1.47/kg' },
  { match: /jasmine rice|sushi rice|white rice|wild rice/i, unit: 'kg', lo: 2, hi: 28, src: 'STATCAN', note: 'BC retail white rice $8.66/2 kg = $4.33/kg; wild rice is a specialty grain' },
  { match: /koji rice/i, unit: 'kg', lo: 15, hi: 70, src: 'FS' },
  { match: /^barley|^millet|^buckwheat|quinoa|cous cous|couscous|rolled oats|oats gf/i, unit: 'kg', lo: 1.2, hi: 12, src: 'FS' },
  { match: /beans dry|chickpea dry|lentils?/i, unit: 'kg', lo: 1.8, hi: 15, src: 'STATCAN', note: 'BC retail dried lentils $3.79/900 g = $4.21/kg' },
  { match: /noodle rice stk|noodle soba|pasta/i, unit: 'kg', lo: 3, hi: 12, src: 'STATCAN', note: 'BC retail pasta $3.64/500 g = $7.28/kg' },
  { match: /corn starch|potato starch|tapioca starch/i, unit: 'kg', lo: 2, hi: 8, src: 'FS' },
  { match: /baking soda|citric acid|malic acid|ascorbic acid|maltodextrin|gum xantham|xanthan/i, unit: 'kg', lo: 3, hi: 60, src: 'FS' },
  { match: /baking powder/i, unit: 'kg', lo: 4, hi: 14, src: 'FS' },
  { match: /iota carragean|kappa carrageenan|transglutaminase|agar agar|activated carbon|^gelatin/i, unit: 'kg', lo: 30, hi: 260, src: 'FS', note: 'modernist / functional ingredient — low volume, high unit price is normal' },
  { match: /yeast active dry/i, unit: 'kg', lo: 8, hi: 26, src: 'FS' },
  { match: /nutritional yeast/i, unit: 'kg', lo: 14, hi: 34, src: 'FS' },
  { match: /feuilletine|cocoa nibs|cocoa butter chips/i, unit: 'kg', lo: 15, hi: 90, src: 'FS' },
  { match: /cocoa powder/i, unit: 'kg', lo: 12, hi: 40, src: 'FS' },
  { match: /callet|chocolate white|dark choc/i, unit: 'kg', lo: 12, hi: 35, src: 'FS' },
  { match: /kosher salt|maldon|hawaiian black salt|curing salt/i, unit: 'kg', lo: 0.8, hi: 90, src: 'FS', note: 'kosher/curing salt ≤$5/kg; finishing salts (Maldon, Hawaiian) $40–90/kg' },
  { match: /tofu/i, unit: 'kg', lo: 4, hi: 14, src: 'STATCAN', note: 'BC retail tofu $3.04/350 g = $8.69/kg' },
  { match: /coffee ground/i, unit: 'kg', lo: 14, hi: 45, src: 'STATCAN', note: 'BC retail ground coffee $9.35/340 g = $27.50/kg' },
  { match: /flaked skipjack|canned tuna/i, unit: 'kg', lo: 7, hi: 18, src: 'STATCAN', note: 'BC retail canned tuna $1.70/170 g = $10.00/kg' },
  { match: /coconut milk/i, unit: 'L', lo: 3, hi: 10, src: 'FS' },
  { match: /coconut fine repack|coconut ribbon/i, unit: 'kg', lo: 5, hi: 14, src: 'FS' },
  { match: /kelp/i, unit: 'kg', lo: 20, hi: 120, src: 'FS' },

  // nuts, seeds, dried fruit
  { match: /almond slices|almonds?/i, unit: 'kg', lo: 12, hi: 30, src: 'STATCAN', note: 'BC retail almonds $5.45/200 g = $27.25/kg' },
  { match: /cashew/i, unit: 'kg', lo: 14, hi: 34, src: 'FS' },
  { match: /pecan/i, unit: 'kg', lo: 18, hi: 40, src: 'FS' },
  { match: /hazelnut/i, unit: 'kg', lo: 18, hi: 45, src: 'FS' },
  { match: /walnut/i, unit: 'kg', lo: 12, hi: 30, src: 'FS' },
  { match: /pine nut/i, unit: 'kg', lo: 45, hi: 110, src: 'FS' },
  { match: /pumpkin seed|sunflower seed|sesame seed|chia seed|flax seed|poppy seed/i, unit: 'kg', lo: 3, hi: 20, src: 'STATCAN', note: 'BC retail sunflower seeds $5.04/400 g = $12.60/kg' },
  { match: /cranberries dried|raisins|pitted dates|dried diced apricot|figs dried/i, unit: 'kg', lo: 3, hi: 30, src: 'FS' },

  // spices — foodservice bulk. A broad band: bulk commodity spices are cheap,
  // low-volume aromatics (vanilla, tonka, saffron) are legitimately dear.
  { match: /vanilla bean/i, unit: 'kg', lo: 300, hi: 1200, src: 'FS' },
  { match: /tonka bean/i, unit: 'kg', lo: 150, hi: 600, src: 'FS' },
  { match: /saraparilla|sarsaparilla|juniper|pink peppercorn|whole cloves|cardamom/i, unit: 'kg', lo: 30, hi: 200, src: 'FS' },
  // late generic fallbacks — only reached when nothing more specific matched
  { match: /potato/i, unit: 'kg', lo: 1, hi: 4, src: 'STATCAN', note: 'BC retail 4.54 kg bag $7.96 = $1.75/kg' },

  { match: /black peppercorns|pepper ground white|pepper cayenne|paprika|cumin|coriander|turmeric|nutmeg|allspice|star anise|anis seed|caraway|fennel seed|mustard seed|bay leaves|oregano|rosemary dry|garam masala|curry powder|crushed chili|mexican chili|onion powder|garlic powder|ground ginger|cinammon|cinnamon|sumac|black seasame|dried onion flakes/i, unit: 'kg', lo: 4, hi: 70, src: 'FS', note: 'bulk foodservice spice band' },
]

/** First matching benchmark for an item name, or null. */
export function benchmarkFor(name: string): Benchmark | null {
  for (const b of BENCHMARKS) if (b.match.test(name)) return b
  return null
}
