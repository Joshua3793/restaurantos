import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { canonicalUom } from '@/lib/utils'

const OCR_MODEL = 'claude-sonnet-4-6'

// Claude Code's shell sets ANTHROPIC_API_KEY="" which dotenv won't override.
// Fall back to reading the .env file directly so local dev always works.
function resolveAnthropicKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    const envPath = path.resolve(process.cwd(), '.env')
    const raw = fs.readFileSync(envPath, 'utf-8')
    const match = raw.match(/^ANTHROPIC_API_KEY=["']?([^"'\r\n]+)["']?/m)
    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

// Learning mode: used for the first few invoices from a new supplier.
// Higher quality image + more thinking tokens → slower but more accurate format detection.
// Normal mode: faster, cheaper — used once the supplier format is well understood.
//
// max_tokens is the TOTAL budget (thinking + text). With extended thinking, thinking
// tokens are subtracted from this total, leaving the remainder for JSON output.
// A 100-item invoice needs ~20–25k output tokens; a 150-item one needs ~30k.
// Previous values (20k normal / 32k learning) only left 10–17k for text — any large
// invoice hit the ceiling, truncated the JSON, and caused a parse error → ERROR status.
const NORMAL_MAX_TOKENS   = 40000   // ~32k text budget after 8k thinking
const NORMAL_THINKING     =  8000   // reduced from 10k — saves time, more output room
const LEARNING_MAX_TOKENS = 48000   // ~36k text budget after 12k thinking
const LEARNING_THINKING   = 12000   // reduced from 15k — still plenty for format discovery

// Claude API hard limit per image (bytes after base64 decode)
const API_IMAGE_LIMIT = 5 * 1024 * 1024

// Claude API limit is 5MB per image. Phone photos are often 8–15MB.
// Compress using sharp (native, excluded from webpack via serverExternalPackages).
async function compressImageForClaude(
  base64Data: string,
  learning = false
): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const sharp = (await import('sharp')).default
  const inputBuffer = Buffer.from(base64Data, 'base64')

  // Learning mode: larger max dimension, higher quality — preserve more detail for
  // format analysis. Normal mode: smaller, faster.
  const maxPx   = learning ? 3500 : 2500
  const quality = learning ? 95   : 90

  let resized = await sharp(inputBuffer)
    .rotate()
    .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
    .normalize()
    .sharpen({ sigma: 1.2, m2: 0.5 })
    .jpeg({ quality })
    .toBuffer()

  if (learning) {
    if (resized.length > 4.8 * 1024 * 1024) {
      resized = await sharp(resized).jpeg({ quality: 85 }).toBuffer()
    }
    if (resized.length > API_IMAGE_LIMIT) {
      resized = await sharp(resized)
        .resize(2500, 2500, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
    }
  } else {
    let q = quality
    while (resized.length > 4 * 1024 * 1024 && q > 60) {
      q -= 15
      resized = await sharp(resized).jpeg({ quality: q }).toBuffer()
    }
    if (resized.length > 4 * 1024 * 1024) {
      resized = await sharp(resized)
        .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer()
    }
  }

  return { data: resized.toString('base64'), mediaType: 'image/jpeg' }
}

// ── Base system prompt ─────────────────────────────────────────────────────────
// Format examples are intentionally kept out of BASE — they live in the per-supplier
// hints so they're only paid for once the supplier is known. Keeps token cost flat.
const BASE_PROMPT = `You are an expert invoice parser for a restaurant supply chain system.
Extract every product line item and all header data from the invoice image(s).
If multiple pages are provided, treat them as one invoice and combine all line items.
Return ONLY valid JSON matching the schema below. No markdown, no commentary.

═══════════════════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════════════════
{
  "supplierName":    string | null,
  "invoiceNumber":   string | null,
  "invoiceDate":     "YYYY-MM-DD" | null,
  "poNumber":        string | null,
  "subtotal":        number | null,
  "discount":        number | null,
  "fuelSurcharge":   number | null,
  "freight":         number | null,
  "minimumOrderFee": number | null,
  "gst":             number | null,
  "hst":             number | null,
  "pst":             number | null,
  "otherCharges":    [ { "label": string, "amount": number } ],
  "total":           number | null,
  "formatNotes":     string | null,
  "lineItems": [ {
    "description":       string,
    "supplierItemCode":  string | null,
    "lineCategory":      string | null,
    "pricingMode":       "per_case" | "per_weight" | "unknown",
    "pricingModeSignal": "explicit_per_column" | "price_uom_is_weight"
                       | "weight_column_present" | "math_inference"
                       | "default_case" | "indeterminate",
    "qtyOrdered":    number | null,
    "qtyOrderedUOM": string | null,
    "qtyShipped":    number | null,
    "qtyShippedUOM": string | null,
    "packQty":  number | null,
    "packSize": number | null,
    "packUOM":  string | null,
    "unitPrice":   number | null,
    "rate":        number | null,
    "rateUOM":     string | null,
    "totalQty":    number | null,
    "totalQtyUOM": string | null,
    "isCatchweight": boolean,
    "nominalWeight": number | null,
    "lineTotal":     number | null,
    "taxFlag":       string | null,
    "lineTaxAmount": number | null,
    "confidence":      "low" | "medium" | "high",
    "confidenceNotes": string | null,
    "bbox": { "page": 0, "x": 0.0, "y": 0.0, "w": 1.0, "h": 0.05 } | null
  } ],
  "pageRotations": [ <0|90|180|270 per page, index = page> ]
}

formatNotes: null normally. In LEARNING MODE only, fill it with a compact
(< 600 chars) description of this supplier's invoice layout: the column names
left-to-right, which column is the ANCHOR product code, how pricing mode is
signaled, where the weight column is (if any), the pack-size notation, and any
multi-row item pattern. Write it as instructions for parsing the NEXT invoice
from this supplier.

═══════════════════════════════════════════════════════
UNIVERSAL PURCHASE STRUCTURE
═══════════════════════════════════════════════════════
Every line follows a 3-level hierarchy:
  CASE = outer unit shipped (case, box, bag, ea)
  PKG  = packages inside each case
  UNIT = what each pkg contains (volume, weight, or count)

Pricing is ONE of two modes:
  per_case   — invoice states $/case; lineTotal = qtyShipped × unitPrice
  per_weight — invoice states $/kg or $/lb; lineTotal = totalQty × rate
               (rate is the PRIMARY price field for per_weight items)

═══════════════════════════════════════════════════════
STEP 0 — COLUMN LAYOUT DISCOVERY (run once before processing rows)
═══════════════════════════════════════════════════════
If a supplier hint is provided below, use its column definitions directly.

If no supplier hint is available, scan the invoice header row to identify:
  a) ANCHOR column — product code / item number that appears on every real
     product row. Rows missing this anchor are headers, subtotals, or notes.
  b) MODE column — "per", "U/M", "UNIT", or similar, adjacent to the price
     column. Values: kg/lb → per_weight rows; cs/ea/pc/bx → per_case rows.
     If no explicit mode column, look for $/kg or $/lb labels on the price.
  c) WEIGHT column — numeric values labeled KG or LB, positioned between
     the qty columns and the price/total columns. This is totalQty for
     per_weight rows. It is NOT the same as qtyShipped.
  d) PRICE column — dollar amount per unit. Labeled $/kg, $/lb, $/cs, PRICE,
     UNIT PRICE, etc.
  e) TOTAL column — the rightmost dollar column (EXTENSION, AMOUNT, TOTAL).

Record this layout and apply it consistently to every line.

═══════════════════════════════════════════════════════
STEP 1 — Is this a real product line?
═══════════════════════════════════════════════════════
Skip rows matching ANY of:
  • Category headers (DAIRY, PRODUCE, FROZEN, COOLER, DRY, PAPER, BEVERAGE, GROCERY...)
    — especially when wrapped in dashes (-- DAIRY --) or asterisks (** DRY **)
  • Category subtotals: "Total NN.NN" rows with no item code
  • Non-product charges: fuel surcharge, freight, delivery fee, minimum order,
    recycling / bottle / environmental fees → capture into HEADER fields, not line items
  • Tax lines: GST, HST, PST, QST, TVQ (standalone or summary)
  • Page aggregates: page total, order total, subtotal, invoice total
  • Column header rows, boilerplate/legal/payment terms
  • Traceability sub-lines: LOT#, MSC-C-XXXXX, ASC-C-XXXXX, fishing method,
    habitat (WILD), grade lines
  • Brand-name-only continuation rows
  • End-of-invoice category summary tables

═══════════════════════════════════════════════════════
STEP 2 — Detect pricing mode. Walk rules in order; first match wins.
═══════════════════════════════════════════════════════
Record which fired in pricingModeSignal.
  (a) explicit_per_column:
      Row has "per" / "U/M" column adjacent to unit price.
      → per_weight if UOM is kg, lb, g, oz
      → per_case   if UOM is cs, pk, ea, pc, ct, bx, bg
  (b) price_uom_is_weight:
      Unit price label is $/kg, $/lb, /KG, /LB, $/oz, etc.
      → per_weight
  (c) weight_column_present:
      Dedicated weight column populated AND (weight × price ≈ lineTotal) within 2%.
      → per_weight
  (d) math_inference:
      Try (qtyShipped × unitPrice ≈ lineTotal) and (weight × price ≈ lineTotal).
      Whichever passes within 2% wins.
  (e) default_case:
      No weight signals → per_case.

If none of (a)–(e) resolves confidently:
  pricingMode = "unknown", signal = "indeterminate", confidence = "low".

═══════════════════════════════════════════════════════
STEP 3 — Extract fields per mode.
═══════════════════════════════════════════════════════
Universal (always extract):
  description       — exact product text. Merge multi-row descriptions; drop
                      brand-only continuation rows.
  supplierItemCode  — per-line product code
  qtyOrdered, qtyOrderedUOM, qtyShipped, qtyShippedUOM
    UOM is the column label as shown (CS, PC, PK, EA, LB, KG).
    Normalize: LITRE→L, MILLILITRE→ml, KILOGRAM→kg, POUNDS→lb,
               OUNCE→oz, EACH→each
  packQty, packSize, packUOM — nominal pack composition from PACK column
                               or description ("4/4L", "6x500ml")
  lineTotal         — total charged for this row
  taxFlag           — row-level tax code (B, G, GP) or null
  lineTaxAmount     — inline tax on row (Snow Cap style)
  lineCategory      — category label/code shown on the row (Sysco section
                      header above, Gordon "Cust Cat" code)

Mode-specific:
  per_case:
    unitPrice = $/case shown on row
    rate, rateUOM, totalQty, totalQtyUOM = null
  per_weight:
    rate        = $/kg or $/lb shown on row  ← PRIMARY price field
    rateUOM     = UOM of rate (kg, lb, g, oz)
    totalQty    = ACTUAL weight/volume delivered for the line — read from the
                  dedicated WEIGHT column. NEVER derive from description math
                  or from qtyShipped when qtyShippedUOM is a container unit.
    totalQtyUOM = matching UOM (same as rateUOM)
    unitPrice   = lineTotal ÷ qtyShipped  (secondary: per-container cost as
                  shipped — equals rate only when qtyShipped is itself a weight)

⚠ unitPrice is ALWAYS populated whenever qtyShipped > 0 and lineTotal is known.
  For per_weight, rate is what matters for price comparison; unitPrice is secondary.

═══════════════════════════════════════════════════════
STEP 4 — Cross-check math.
═══════════════════════════════════════════════════════
  per_case:   qtyShipped × unitPrice ≈ lineTotal
  per_weight: totalQty   × rate      ≈ lineTotal
Bands:
  within 1% → confidence = "high"
  1–5%      → confidence = "medium"
  > 5%      → confidence = "low" (re-examine row first — likely you read a
              value from the wrong row)

═══════════════════════════════════════════════════════
STEP 5 — Catchweight (per_weight rows only)
═══════════════════════════════════════════════════════
isCatchweight = true if ANY of:
  (a) qtyShippedUOM is a container unit (CS, PK, EA, BX, BG, PC) — item is
      priced by weight but shipped as discrete containers whose actual weight
      varies per shipment.
  (b) qtyOrderedUOM is a weight UOM AND qtyOrdered ≠ qtyShipped (weight
      variance between ordered and delivered).
  (c) packUOM is a weight/volume UOM AND (packQty × packSize) differs from
      totalQty by > 2% (actual weight differs from nominal pack spec).
Set nominalWeight = packQty × packSize when (c) applies and values are known.
Otherwise nominalWeight = null.
For per_case rows: isCatchweight = false, nominalWeight = null.

═══════════════════════════════════════════════════════
ROW ALIGNMENT — READ HORIZONTALLY, NEVER BORROW
═══════════════════════════════════════════════════════
Invoice tables are row-structured. For each line:
  • Read all fields from the SAME row.
  • Never pull qty/price/total from an adjacent row.
  • Multi-row items: rows 2+ may continue the description (brand,
    certifications, fishing method). Merge their text into description;
    they hold NO financial data.
  • Two-row items (Legends Haul / Acecard): row 1 has everything; row 2 is
    brand only — skip row 2 entirely, do not create a new line item.

If a field is genuinely absent, use null. Never invent values.

═══════════════════════════════════════════════════════
HEADER FIELDS
═══════════════════════════════════════════════════════
Capture every fee/charge/tax from the summary block (or non-product lines
skipped in STEP 1):
  subtotal        — pre-tax, pre-fee product total
  discount        — line or order-level discount
  fuelSurcharge   — "fuel charge", "fuel surcharge", "fuel"
  freight         — "freight", "delivery charge"
  minimumOrderFee — "min order fee", "minimum order"
  gst, hst, pst   — Canadian taxes (federal / harmonized / provincial)
  otherCharges    — anything else: [{label, amount}, ...]
  total           — grand total

Single combined "Tax" without a split → put in gst.
"GST/HST" combined → put in hst.

═══════════════════════════════════════════════════════
CONFIDENCE
═══════════════════════════════════════════════════════
high   — all fields clearly legible AND cross-check within 1%.
medium — partially obscured/handwritten but extracted with reasonable
         certainty, OR cross-check within 1–5%.
low    — at least one numeric field genuinely hard to read OR cross-check
         > 5% OR borderline skip-vs-product judgment.

For "low", fill confidenceNotes (< 50 chars): "smudged unit price",
"ambiguous 5 vs 6 in qty", "line total cut off", "handwritten — uncertain".
For "medium"/"high", confidenceNotes = null.

Do NOT mark "low" just because a field was null. Flag only when an
extracted value could be wrong.

═══════════════════════════════════════════════════════
BOUNDING BOX
═══════════════════════════════════════════════════════
First decide each page's orientation. A photo may be rotated (sideways/upside
down). Return "pageRotations": an array indexed by page (0-indexed file index)
where each value is the degrees to rotate that image CLOCKWISE so its text reads
UPRIGHT — one of 0, 90, 180, 270. (0 if already upright.)

Express ALL bounding boxes in the UPRIGHT orientation — i.e. as if the page were
already rotated by its pageRotation so the rows run left-to-right. For each line
item, return the bounding box of the entire row (spanning all columns) as
fractions of the UPRIGHT page dimensions:
  { "page": <0-indexed file index>,
    "x": <left edge / upright width>,
    "y": <top edge / upright height>,
    "w": <row width / upright width>,
    "h": <row height / upright height> }
All values are 0.0–1.0. Be precise about y/h: the box must tightly bracket the
row's text, not a neighbouring row. If the position cannot be determined, return null.

═══════════════════════════════════════════════════════
NUMERIC FORMATTING
═══════════════════════════════════════════════════════
  • Numbers only — no currency symbols, no thousand separators (12.50 not "$12,500")
  • Dates in YYYY-MM-DD
  • null only when a field is genuinely impossible to determine
  • isCatchweight is always boolean — never null
  • otherCharges is always an array — [] if none
  • lineItems is always an array — [] if no products
  • Preserve product descriptions exactly as written`

// ── Supplier-specific format hints ─────────────────────────────────────────────
// Keyed by normalized substring of supplier name. Injected into the prompt when
// the session's supplier is already known, giving Claude exact column layouts
// and worked examples (which BASE_PROMPT deliberately omits to keep tokens low).
const SUPPLIER_HINTS: Record<string, string> = {
  sysco: `
SUPPLIER IDENTIFIED: SYSCO CANADA
Columns (L→R): ITEM NO. | QTY.ORD | QTY.SHPD | B UNIT | PACK SIZE FORMAT
             | BRAND | DESCRIPTION | WEIGHT | PRICE | EXTENSION

ANCHOR: Every product row starts with a 6-7 digit ITEM NO. Skip rows without one.

MODE DETECTION:
  WEIGHT column populated AND PRICE label shows $/lb or $/kg
    → per_weight, signal: price_uom_is_weight
  Otherwise
    → per_case,   signal: default_case

FIELD MAPPING (per_case):
  qtyOrdered = QTY.ORD,  qtyOrderedUOM = "cs"
  qtyShipped = QTY.SHPD, qtyShippedUOM = "cs"
  packQty    = B UNIT
  packSize, packUOM = parse PACK SIZE FORMAT
    "1 KG" → 1,"kg"  |  "3 L" → 3,"L"  |  "8 EA" → 8,"each"  |  "100CT" → 100,"each"
  unitPrice  = PRICE ($/case)
  lineTotal  = EXTENSION
  rate, rateUOM, totalQty, totalQtyUOM = null

FIELD MAPPING (per_weight):
  qtyOrdered, qtyShipped, qtyShippedUOM as above ("cs")
  packQty/packSize/packUOM as above (nominal)
  rate        = PRICE ($/lb or $/kg)
  rateUOM     = UOM from price label (lb or kg)
  totalQty    = WEIGHT column
  totalQtyUOM = same UOM as rateUOM
  unitPrice   = EXTENSION ÷ QTY.SHPD   (case cost as shipped)
  lineTotal   = EXTENSION

CATCHWEIGHT: Sysco rarely shows ordered-vs-shipped weight separately. Generally false.
Set true only if a nominal weight in description differs from WEIGHT column.

EXAMPLES:
  ITEM 7296313  ORD 1 / SHPD 1  B-UNIT 4  PACK "3 L"  PRICE 55.13  EXT 55.13
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 4, packSize: 3, packUOM: "L"
       unitPrice: 55.13, lineTotal: 55.13

  ITEM 2697985  ORD 1 / SHPD 1  PACK "25 LB"  WEIGHT 26.4  PRICE 2.28  EXT 60.24
    (price column labeled $/LB)
    → per_weight, signal: price_uom_is_weight
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 1, packSize: 25, packUOM: "lb"
       rate: 2.28, rateUOM: "lb", totalQty: 26.4, totalQtyUOM: "lb"
       unitPrice: 60.24, lineTotal: 60.24

SKIP (no item number):
  • Category headers: "-- DAIRY PRODUCTS --", "-- CANNED AND DRY --", etc.
  • "Total NN.NN" subtotal rows
  • Final summary: P.S.T./T.V.P., ORDER TOTAL, CUBE, PIECES`,

  gordon: `
SUPPLIER IDENTIFIED: GFS / GORDON FOOD SERVICE
Columns: Item Code(7d) | Qty Ord | Qty Ship | Unit | Pack Size | Brand
       | Item Description | Ø | Cust Cat | Unit Price | (tax) | Extended Price

ANCHOR: Every product row starts with a 7-digit Item Code. Skip rows without one.

MODE DETECTION: mostly per_case (signal: default_case).
Gordon rarely sells by weight; treat as per_case unless the Unit Price column
clearly shows $/kg or $/lb (then per_weight, price_uom_is_weight).

FIELD MAPPING (per_case):
  qtyOrdered = Qty Ord,   qtyOrderedUOM = Unit column value (CS, EA)
  qtyShipped = Qty Ship,  qtyShippedUOM = Unit column value
  packQty, packSize, packUOM = parse Pack Size column
    "1x24 UN" → packQty:1, packSize:24, packUOM:"each"
    "2x5 KG"  → packQty:2, packSize:5,  packUOM:"kg"
    "1x4 L"   → packQty:1, packSize:4,  packUOM:"L"
  lineCategory = Cust Cat value (PR, DS, GR, etc.) — capture as the row's category code
  unitPrice   = Unit Price ($/case)
  lineTotal   = Extended Price

CATCHWEIGHT: Gordon does not show ordered-vs-shipped weight. Always false.

EXAMPLE:
  ITEM 1453800  Qty 1 CS  Pack "1x24 UN"  Brand Markon
  Desc "LETTUCE LEAF BUTTER PREM"  Cat PR  Unit $47.76  Ext $47.76
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 1, packSize: 24, packUOM: "each"
       lineCategory: "PR", unitPrice: 47.76, lineTotal: 47.76

SKIP (no item code):
  • "Totals: N  Total [Category] Pieces XX.XX" — category subtotal rows
  • "Page Total: XX.XX"
  • End-of-invoice Category Summary / Category Recap table
  • Footer: Product Total, Misc, Sub total, PST/QST, GST/HST, Invoice Total
  • Non-product fees in Category Summary: "Fuel Charge", "Minimum Order Fee"
    → capture these into HEADER fields (fuelSurcharge, minimumOrderFee)`,

  'snow cap': `
SUPPLIER IDENTIFIED: SNOW CAP ENTERPRISES
Columns: BIN LOC. | ITEM NO. | QUAN. | DESCRIPTION | SIZE | UNIT PRICE | AMOUNT

ANCHOR: Every product row has a BIN LOC. code ("WF-22-1", "CB-10-1", etc.) AND an ITEM NO.

MODE DETECTION: ALWAYS per_case (signal: default_case).
Snow Cap never prices by weight.

FIELD MAPPING:
  qtyOrdered = QUAN., qtyOrderedUOM = "cs"  (use "ea" only when SIZE makes it obvious)
  qtyShipped = QUAN., qtyShippedUOM = same as qtyOrderedUOM
  packQty, packSize, packUOM = parse SIZE column:
    "9/3LB"  → packQty:9,  packSize:3,   packUOM:"lb"
    "4/4L"   → packQty:4,  packSize:4,   packUOM:"L"
    "20KG"   → packQty:1,  packSize:20,  packUOM:"kg"
    "2.5KG"  → packQty:1,  packSize:2.5, packUOM:"kg"
    "100PC"  → packQty:1,  packSize:100, packUOM:"each"
    "9L"     → packQty:1,  packSize:9,   packUOM:"L"
    "1KG"    → packQty:1,  packSize:1,   packUOM:"kg"
  unitPrice = UNIT PRICE ($/case)
  lineTotal = AMOUNT = QUAN × UNIT PRICE
  rate, rateUOM, totalQty, totalQtyUOM = null
  isCatchweight = false

INLINE TAX: Snow Cap sometimes prints "GST: 1.32  PST: 1.85" at the end of an
item row. These are taxes on that line — capture the larger one in
lineTaxAmount and put the code in taxFlag ("G" for GST, "P" for PST).
Do NOT subtract them from lineTotal.

EXAMPLE:
  BIN WF-22-1  ITEM S1095  QUAN 1  DESC "Salt Diamond Crystal Kosher"
  SIZE "9/3LB"  UNIT PRICE 111.87  AMOUNT 111.87
    → per_case, signal: default_case
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 9, packSize: 3, packUOM: "lb"
       unitPrice: 111.87, lineTotal: 111.87

SKIP:
  • Category headers in "** ... **": "** DRY **", "** COOLER **", "** FROZEN **",
    "** PRODUCE **"
  • LOT# lines beneath items (traceability, not a product)
  • Delivery instruction header text
  • Footer: subtotals, tax summary rows`,

  'legends haul': `
SUPPLIER IDENTIFIED: LEGENDS HAUL / ACECARD FOOD GROUP
(Acecard Food Group LTD is the legal entity that trades as Legends Haul — same supplier.)
Columns: PRODUCT ID | ORDERED | SHIPPED | unit(PC/PK/CS) | DESCRIPTION/SIZE/BRAND
       | TAX | WEIGHT | PRICE | per | AMOUNT

TWO-ROW ITEMS — CRITICAL: Each product occupies exactly TWO rows:
  Row 1: PRODUCT ID + all financial data
  Row 2: Brand name only ("BRITCO", "JBS/CARGIL", "WHITEVEAL", "GOLDENVALL")
  → Do NOT create a line item for Row 2. Merge brand into Row 1's description.

ANCHOR: Real product rows have a 5-digit PRODUCT ID. Brand rows have none.

MODE DETECTION: per column drives mode (signal: explicit_per_column)
  per = KG → per_weight
  per = CS → per_case

FIELD MAPPING (per_weight, per=KG):
  qtyOrdered  = ORDERED, qtyOrderedUOM = unit column (CS/PC/PK)
  qtyShipped  = SHIPPED, qtyShippedUOM = unit column
  packQty/packSize/packUOM from DESCRIPTION (nominal reference only)
  rate        = PRICE ($/kg)  ← PRIMARY price field
  rateUOM     = "kg"
  totalQty    = WEIGHT column (AUTHORITATIVE — actual delivered kg, NEVER derive
                from description arithmetic or from qtyShipped)
  totalQtyUOM = "kg"
  unitPrice   = AMOUNT ÷ SHIPPED  (per-container cost as shipped)
  lineTotal   = AMOUNT
  isCatchweight: true — all per_weight rows with qtyShippedUOM=CS/PC/PK are
                 catchweight (actual delivered weight varies per shipment)
  nominalWeight: packQty × packSize when both are known and differ from totalQty
                 by > 2% (e.g. "4x7kg" nominal 28kg vs 36.1 KG weight); else null

FIELD MAPPING (per_case, per=CS):
  qtyOrdered, qtyShipped, qtyShippedUOM from ORDERED/SHIPPED/unit columns
  packQty/packSize/packUOM from DESCRIPTION
  unitPrice = PRICE ($/case)
  lineTotal = AMOUNT
  rate, rateUOM, totalQty, totalQtyUOM = null
  isCatchweight = false
  (WEIGHT column may still show a kg value — informational only, ignore for pricing)

⚠ UNIT COLUMN IS NOT A MULTIPLIER: "4 PC" of "Beef Brisket 4x7kg" means 4 pieces
(qtyShipped: 4), NOT 16. Description's pack notation is nominal case format only.

⚠ DESCRIPTION SIZE IS NOMINAL: NEVER derive totalQty from description arithmetic.
WEIGHT column is always authoritative for per_weight rows.

EXAMPLES:
  PRODUCT 10126  SHIPPED 1 CS  "Pork Butt BL Fresh 6/cs / BRITCO"
  WEIGHT 29.500 KG  PRICE 9.90  per KG  AMOUNT 292.05
    → per_weight, signal: explicit_per_column
       qtyShipped: 1, qtyShippedUOM: "cs", packQty: 6, packSize: null, packUOM: null
       rate: 9.90, rateUOM: "kg", totalQty: 29.5, totalQtyUOM: "kg"
       unitPrice: 292.05, lineTotal: 292.05, isCatchweight: true, nominalWeight: null

  PRODUCT 13463  SHIPPED 6 CS  "Eggs Dark Yolk LW Loose 180/case / GOLDENVALL"
  WEIGHT 66.000 KG  PRICE 78.00  per CS  AMOUNT 468.00
    → per_case, signal: explicit_per_column
       qtyShipped: 6, qtyShippedUOM: "cs", packQty: null, packSize: 180, packUOM: "each"
       unitPrice: 78.00, lineTotal: 468.00

SKIP:
  • Brand-name rows (Row 2 of each item — no product ID)
  • Footer: Total Weight, Sub Total, Discount, Fuel Surcharge, Freight,
    GST, PST, Invoice Total, Total Pieces
  → capture footer fees/taxes into HEADER fields, not line items`,

  'intercity packers': `
SUPPLIER IDENTIFIED: INTERCITY PACKERS (meat & seafood)
Columns: PRODUCT | DESCRIPTION | PACK | QTY ORD | U/M | QTY SHIP | U/M | PRICE | AMOUNT | TAX

MULTI-ROW ITEMS — CRITICAL: Each product spans multiple rows:
  Row 1: PRODUCT code + first description line + financial data
  Rows 2+: Description continuation ONLY (fishing method, certifications,
    habitat, grade, weight class, brand). Merge into description; no
    financial data on these rows.

ANCHOR: Real product rows have an 8-digit PRODUCT code. Sub-description rows have none.

MODE DETECTION: ALWAYS per_weight (signal: explicit_per_column).
Intercity is meat/seafood — every line is priced by weight.

FIELD MAPPING:
  qtyOrdered  = QTY ORD value
  qtyOrderedUOM = U/M next to QTY ORD (lb or kg)
  qtyShipped  = QTY SHIP value
  qtyShippedUOM = U/M next to QTY SHIP (lb or kg)
  packQty, packSize, packUOM = parse PACK column
    "1/10 LB" → packQty:1, packSize:10, packUOM:"lb"
  rate        = PRICE ($/lb or $/kg)
  rateUOM     = same UOM as qtyShippedUOM
  totalQty    = QTY SHIP value (same as qtyShipped — qty IS the delivered weight)
  totalQtyUOM = qtyShippedUOM
  unitPrice   = AMOUNT ÷ QTY SHIP  (= rate, since qty is the weight)
  lineTotal   = AMOUNT = QTY SHIP × PRICE
  isCatchweight: true if qtyOrdered ≠ qtyShipped (catchweight scenario)
  nominalWeight: null (Intercity doesn't ship in nominal pack format)

EXAMPLES:
  PRODUCT 21402211  PACK "1/10 LB"  ORD 40 LB / SHIP 40 LB  PRICE 18.79  AMOUNT 751.60
    → per_weight, signal: explicit_per_column
       qtyOrdered: 40, qtyOrderedUOM: "lb", qtyShipped: 40, qtyShippedUOM: "lb"
       packQty: 1, packSize: 10, packUOM: "lb"
       rate: 18.79, rateUOM: "lb", totalQty: 40, totalQtyUOM: "lb"
       unitPrice: 18.79, lineTotal: 751.60, isCatchweight: false

  PRODUCT 11108103  PACK "1/10 lb ODD"  ORD 3.00 LB / SHIP 3.20 LB  PRICE 19.89  AMOUNT 63.65
    → per_weight, signal: explicit_per_column
       qtyOrdered: 3.00, qtyOrderedUOM: "lb", qtyShipped: 3.20, qtyShippedUOM: "lb"
       packQty: 1, packSize: 10, packUOM: "lb"
       rate: 19.89, rateUOM: "lb", totalQty: 3.20, totalQtyUOM: "lb"
       unitPrice: 19.89, lineTotal: 63.65, isCatchweight: true

SKIP:
  • All description continuation rows (no product code)
  • Boilerplate: "All raw product is to be cooked for consumption",
    "Please ensure payment...", INTEREST CHARGES, CLAIMS sections
  • Footer: TOTAL WEIGHT, TOTAL PIECES, TERMS, SUBTOTAL, FUEL SURCHARGE,
    FREIGHT, PST, HST/GST, INVOICE TOTAL
  → capture footer fees/taxes into HEADER fields, not line items`,
}

// Lookup supplier hints by normalizing the supplier name and checking substrings
function getSupplierHint(supplierName: string | null | undefined): string {
  if (!supplierName) return ''
  const n = supplierName.toLowerCase()
  if (n.includes('sysco'))                            return SUPPLIER_HINTS['sysco']
  if (n.includes('gordon') || n.includes('gfs'))      return SUPPLIER_HINTS['gordon']
  if (n.includes('snow cap'))                         return SUPPLIER_HINTS['snow cap']
  if (n.includes('legends') || n.includes('acecard')) return SUPPLIER_HINTS['legends haul']
  if (n.includes('intercity'))                        return SUPPLIER_HINTS['intercity packers']
  return ''
}

function buildSystemPrompt(
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): string {
  // Hardcoded hints win; otherwise fall back to layout notes a previous
  // learning-mode run saved for this supplier.
  const hint = getSupplierHint(supplierName) ||
    (savedFormatNotes
      ? `\nSUPPLIER LAYOUT NOTES (learned from previous invoices of ${supplierName ?? 'this supplier'}):\n${savedFormatNotes}`
      : '')
  const learningNote = learning
    ? '\n\n⚑ LEARNING MODE: This is one of the first invoices from this supplier. ' +
      'Before processing any rows, scan the full invoice and complete these steps:\n' +
      '  1. Read the column header row left-to-right and write out each column name.\n' +
      '  2. Identify the MODE signal: find the "per" or "U/M" column near the price; ' +
             'if absent, check whether the price column is labeled $/kg or $/lb.\n' +
      '  3. Identify the WEIGHT column (if present) — numeric kg/lb values between ' +
             'qty and price columns. This will be totalQty for per_weight rows.\n' +
      '  4. Confirm the ANCHOR column (product code) — every real product row has one; ' +
             'rows missing it are headers, subtotals, or brand-continuation lines.\n' +
      '  5. Note any multi-row item patterns (brand on row 2, certifications on row 3).\n' +
      'Then apply these column definitions consistently across every line item.'
    : ''
  if (!hint) return BASE_PROMPT + learningNote
  return BASE_PROMPT + learningNote + '\n\n' +
    '═══════════════════════════════════════════════════════\n' +
    'SUPPLIER-SPECIFIC RULES — these override general rules:\n' +
    '═══════════════════════════════════════════════════════' +
    hint
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PricingMode = 'per_case' | 'per_weight' | 'unknown'
export type PricingModeSignal =
  | 'explicit_per_column'
  | 'price_uom_is_weight'
  | 'weight_column_present'
  | 'math_inference'
  | 'default_case'
  | 'indeterminate'

export interface OcrLineItem {
  // Identity
  description: string
  supplierItemCode: string | null
  lineCategory: string | null          // free-form: section header name OR column code (PR, DS, etc.)

  // Pricing classification (primary)
  pricingMode: PricingMode
  pricingModeSignal: PricingModeSignal

  // Quantities — UOM disambiguates case-count ("cs","pc","pk","ea") vs weight ("lb","kg","g","oz")
  qtyOrdered: number | null
  qtyOrderedUOM: string | null
  qtyShipped: number | null
  qtyShippedUOM: string | null

  // Nominal pack composition
  packQty: number | null
  packSize: number | null
  packUOM: string | null               // "L","ml","kg","g","lb","oz","each"

  // Pricing fields (per mode)
  // per_case: unitPrice = $/case; rate/totalQty null
  // per_weight: rate = $/uom; totalQty = actual delivered weight; unitPrice = lineTotal/qtyShipped
  unitPrice: number | null
  rate: number | null
  rateUOM: string | null
  totalQty: number | null
  totalQtyUOM: string | null

  // Catchweight
  isCatchweight: boolean               // never null — defaults to false
  nominalWeight: number | null

  // Universal
  lineTotal: number | null

  // Tax
  taxFlag: string | null
  lineTaxAmount: number | null

  // Bounding box — normalized coords (0–1 fractions of image dimensions)
  bbox: { page: number; x: number; y: number; w: number; h: number } | null

  // Confidence
  confidence: 'low' | 'medium' | 'high'
  confidenceNotes: string | null
}

export interface OcrResult {
  // Invoice identity
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  poNumber: string | null

  // Financial header
  subtotal: number | null
  discount: number | null
  fuelSurcharge: number | null
  freight: number | null
  minimumOrderFee: number | null
  gst: number | null
  hst: number | null
  pst: number | null
  otherCharges: Array<{ label: string; amount: number }>
  total: number | null

  // Learning-mode only: Claude's own summary of this supplier's column layout
  formatNotes: string | null

  // Lines
  lineItems: OcrLineItem[]

  // Per-page rotation (index = page / file index): degrees to rotate the stored
  // image CLOCKWISE so its text reads upright. This IS the orientation the bbox
  // coordinates are expressed in, so the viewer rotates the display to match.
  pageRotations: number[]
}

// ── JSON parsing & normalization ──────────────────────────────────────────────

function asNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function asStr(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length ? s : null
}

// asStr + canonical UOM normalization (returns null when absent).
function canonStr(v: unknown): string | null {
  const s = asStr(v)
  return s ? (canonicalUom(s) || null) : null
}

function normalizeLineItem(raw: Record<string, unknown>): OcrLineItem {
  const description = asStr(raw.description) ?? ''
  const pricingMode = (raw.pricingMode === 'per_case' || raw.pricingMode === 'per_weight')
    ? raw.pricingMode as PricingMode
    : 'unknown'
  const sig = raw.pricingModeSignal
  const pricingModeSignal: PricingModeSignal =
    sig === 'explicit_per_column' || sig === 'price_uom_is_weight' ||
    sig === 'weight_column_present' || sig === 'math_inference' ||
    sig === 'default_case' ? sig as PricingModeSignal : 'indeterminate'
  const confRaw = raw.confidence
  const confidence: 'low' | 'medium' | 'high' =
    confRaw === 'high' ? 'high' : confRaw === 'medium' ? 'medium' : 'low'
  return {
    description,
    supplierItemCode: asStr(raw.supplierItemCode),
    lineCategory:     asStr(raw.lineCategory),
    pricingMode,
    pricingModeSignal,
    qtyOrdered:     asNum(raw.qtyOrdered),
    qtyOrderedUOM:  asStr(raw.qtyOrderedUOM),
    qtyShipped:     asNum(raw.qtyShipped),
    qtyShippedUOM:  asStr(raw.qtyShippedUOM),
    packQty:        asNum(raw.packQty),
    packSize:       asNum(raw.packSize),
    // Standardize the measurement UOMs so "10x250GR" == "10x250g", "5LTR" == "5l"
    // etc. — makes formats comparable/matchable and lets cost conversion resolve.
    packUOM:        canonStr(raw.packUOM),
    unitPrice:      asNum(raw.unitPrice),
    rate:           asNum(raw.rate),
    rateUOM:        canonStr(raw.rateUOM),
    totalQty:       asNum(raw.totalQty),
    totalQtyUOM:    canonStr(raw.totalQtyUOM),
    isCatchweight:  raw.isCatchweight === true,
    nominalWeight:  asNum(raw.nominalWeight),
    lineTotal:      asNum(raw.lineTotal),
    taxFlag:        asStr(raw.taxFlag),
    lineTaxAmount:  asNum(raw.lineTaxAmount),
    bbox: (() => {
      const b = raw.bbox as Record<string, unknown> | null | undefined
      if (!b || typeof b !== 'object') return null
      const page = typeof b.page === 'number' ? b.page : 0
      const x = typeof b.x === 'number' ? b.x : null
      const y = typeof b.y === 'number' ? b.y : null
      const w = typeof b.w === 'number' ? b.w : null
      const h = typeof b.h === 'number' ? b.h : null
      if (x === null || y === null || w === null || h === null) return null
      return {
        page,
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        w: Math.max(0, Math.min(1, w)),
        h: Math.max(0, Math.min(1, h)),
      }
    })(),
    confidence,
    confidenceNotes: asStr(raw.confidenceNotes),
  }
}

function parseOcrResponse(rawText: string): OcrResult {
  const text = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  if (!text) {
    throw new Error('Claude returned an empty response — invoice may be unreadable or the image quality is too low')
  }

  const parsed = JSON.parse(text) as Record<string, unknown>
  const rawItems = Array.isArray(parsed.lineItems) ? parsed.lineItems as Record<string, unknown>[] : []
  const rawOther = Array.isArray(parsed.otherCharges) ? parsed.otherCharges as Record<string, unknown>[] : []

  return {
    supplierName:    asStr(parsed.supplierName),
    invoiceNumber:   asStr(parsed.invoiceNumber),
    invoiceDate:     asStr(parsed.invoiceDate),
    poNumber:        asStr(parsed.poNumber),
    subtotal:        asNum(parsed.subtotal),
    discount:        asNum(parsed.discount),
    fuelSurcharge:   asNum(parsed.fuelSurcharge),
    freight:         asNum(parsed.freight),
    minimumOrderFee: asNum(parsed.minimumOrderFee),
    gst:             asNum(parsed.gst),
    hst:             asNum(parsed.hst),
    pst:             asNum(parsed.pst),
    otherCharges:    rawOther
      .map(o => ({ label: asStr(o.label) ?? '', amount: asNum(o.amount) ?? 0 }))
      .filter(o => o.label.length > 0),
    total:           asNum(parsed.total),
    formatNotes:     asStr(parsed.formatNotes),
    lineItems:       rawItems.map(normalizeLineItem),
    pageRotations:   (Array.isArray(parsed.pageRotations) ? parsed.pageRotations : [])
      .map(v => normalizePageRotation(v)),
  }
}

/** Snap any rotation value to the nearest valid quarter-turn (0/90/180/270). */
export function normalizePageRotation(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!Number.isFinite(n)) return 0
  const r = ((Math.round(n / 90) * 90) % 360 + 360) % 360
  return r
}

// ── JSON retry wrapper ────────────────────────────────────────────────────────
// Caps at one retry. The thunk is called with an optional `retrySuffix`; on
// retry the suffix is appended to the user message so Claude knows its
// previous output failed to parse.
function looksLikeTruncated(text: string): boolean {
  const t = text.trimEnd()
  // Truncated JSON ends without the closing braces / brackets of the root object
  if (!t.endsWith('}') && !t.endsWith(']')) return true
  // Also check if lineItems array is left unclosed (common truncation point)
  const opens  = (t.match(/\[/g)?.length ?? 0) + (t.match(/\{/g)?.length ?? 0)
  const closes = (t.match(/\]/g)?.length ?? 0) + (t.match(/\}/g)?.length ?? 0)
  return opens > closes
}

async function callWithJsonRetry(
  callApi: (retrySuffix?: string) => Promise<string>,
): Promise<OcrResult> {
  const first = await callApi()
  try {
    return parseOcrResponse(first)
  } catch (err) {
    const truncated = looksLikeTruncated(first.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
    if (truncated) {
      // A truncated response means the token budget was exhausted — retrying the
      // same request with the same budget deterministically truncates again and
      // burns 90–150s before the caller's per-page fallback can start. Fail fast.
      console.error(
        '[ocr] first response appears truncated — skipping retry (same token budget would truncate again):',
        err instanceof Error ? err.message : err,
      )
      throw new Error(
        `Failed to parse OCR response as JSON — the response was likely truncated (too many line items for the token budget): ${err instanceof Error ? err.message : String(err)}`
      )
    }
    console.warn(
      '[ocr] first response invalid JSON, retrying once:',
      err instanceof Error ? err.message : err,
    )
    const suffix =
      '\n\nYour previous response was not valid JSON. Re-output the JSON object only — ' +
      'no prose, no markdown fences. Here was your previous output:\n\n' +
      first.slice(0, 4000)
    const second = await callApi(suffix)
    try {
      return parseOcrResponse(second)
    } catch (err2) {
      console.error('[ocr] retry also failed. First 500 chars:', second.slice(0, 500))
      // The retry response can itself truncate — keep the hint so the caller's
      // truncation fallback (per-page OCR) still triggers.
      const hint = looksLikeTruncated(second.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim())
        ? ' — the response was likely truncated (too many line items for the token budget)'
        : ''
      throw new Error(
        `Failed to parse OCR response as JSON${hint}: ${err2 instanceof Error ? err2.message : String(err2)}`
      )
    }
  }
}

// ── Multi-image (ALL pages in ONE API call — fastest approach for photo invoices) ──
export async function extractInvoiceFromImages(
  files: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>,
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  const compressedImages = await Promise.all(
    files.map(async (f) => {
      const rawBytes = Buffer.byteLength(f.base64, 'base64')
      if (rawBytes > 4 * 1024 * 1024 || f.mediaType !== 'image/jpeg') {
        const compressed = await compressImageForClaude(f.base64, learning)
        console.log(`[ocr] Compressed${learning ? ' (learning)' : ''}: ${(rawBytes / 1024 / 1024).toFixed(1)}MB → ${(Buffer.byteLength(compressed.data, 'base64') / 1024 / 1024).toFixed(1)}MB`)
        return compressed
      }
      return { data: f.base64, mediaType: f.mediaType as 'image/jpeg' }
    })
  )

  const imageBlocks: Anthropic.ImageBlockParam[] = compressedImages.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }))

  const baseInstruction = files.length > 1
    ? `These are ${files.length} pages of the same invoice. Parse all pages together and return one combined JSON object.`
    : 'Parse this invoice and return JSON only.'

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning, savedFormatNotes),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: baseInstruction + (retrySuffix ?? '') },
        ],
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Single image (kept for backwards compat) ──
export async function extractInvoiceFromImage(
  base64Data: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
): Promise<OcrResult> {
  return extractInvoiceFromImages([{ base64: base64Data, mediaType }])
}

// ── PDF — send as document to Claude (handles multi-page natively) ──
export async function extractInvoiceFromPdf(
  pdfBuffer: Buffer,
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const base64 = pdfBuffer.toString('base64')
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning, savedFormatNotes),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
          { type: 'text', text: 'Parse this invoice and return JSON only.' + (retrySuffix ?? '') },
        ],
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Plain text (Claude-assisted) ──
export async function extractInvoiceFromText(
  text: string,
  supplierName?: string | null,
  learning = false,
  savedFormatNotes?: string | null
): Promise<OcrResult> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const maxTokens      = learning ? LEARNING_MAX_TOKENS : NORMAL_MAX_TOKENS
  const thinkingBudget = learning ? LEARNING_THINKING   : NORMAL_THINKING

  return callWithJsonRetry(async (retrySuffix) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.stream({
      model: OCR_MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(supplierName, learning, savedFormatNotes),
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      messages: [{
        role: 'user',
        content: `Parse this invoice text and return JSON only.\n\n${text}${retrySuffix ?? ''}`,
      }],
    } as any) as any).finalMessage()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (message as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('')
  })
}

// ── Quick metadata peek ────────────────────────────────────────────────────────
// Reads only supplier name, date, and invoice number from the first page.
// Uses Haiku 4.5 (fast, cheap, no extended thinking) so the session list becomes
// identifiable within ~2 seconds while the full OCR is still running.

const QUICK_MODEL = 'claude-haiku-4-5-20251001'

export interface QuickMeta {
  supplierName:  string | null
  invoiceDate:   string | null
  invoiceNumber: string | null
}

export async function quickExtractMeta(
  buf:      Buffer,
  fileType: string,
  fileName: string,
): Promise<QuickMeta> {
  const apiKey = resolveAnthropicKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const question =
    'Look at this invoice. Return ONLY valid JSON (no markdown, no explanation):\n' +
    '{"supplierName":"string or null","invoiceDate":"YYYY-MM-DD or null","invoiceNumber":"string or null"}'

  const ft = fileType.toLowerCase()
  let content: Anthropic.MessageParam['content']

  if (ft.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(fileName)) {
    const compressed = await compressImageForClaude(buf.toString('base64'), false)
    content = [
      { type: 'image', source: { type: 'base64', media_type: compressed.mediaType, data: compressed.data } },
      { type: 'text', text: question },
    ]
  } else if (ft === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } } as any,
      { type: 'text', text: question },
    ]
  } else {
    content = [{ type: 'text', text: `${buf.toString('utf-8').slice(0, 1500)}\n\n${question}` }]
  }

  const message = await client.messages.create({
    model:      QUICK_MODEL,
    max_tokens: 256,
    messages:   [{ role: 'user', content }],
  })

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  try {
    const j = JSON.parse(text) as Record<string, unknown>
    return {
      supplierName:  typeof j.supplierName  === 'string' ? j.supplierName  : null,
      invoiceDate:   typeof j.invoiceDate   === 'string' ? j.invoiceDate   : null,
      invoiceNumber: typeof j.invoiceNumber === 'string' ? j.invoiceNumber : null,
    }
  } catch {
    return { supplierName: null, invoiceDate: null, invoiceNumber: null }
  }
}

// ── CSV — local parse, no API call needed ──
// CSVs are mode-agnostic; we set pricingMode: 'unknown' and let the matcher
// treat it as per_case downstream (matcher only reads unitPrice/packQty/packSize
// which we populate normally).
export async function extractInvoiceFromCsv(csvText: string): Promise<OcrResult> {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    return {
      supplierName: null, invoiceNumber: null, invoiceDate: null, poNumber: null,
      subtotal: null, discount: null, fuelSurcharge: null, freight: null,
      minimumOrderFee: null, gst: null, hst: null, pst: null,
      otherCharges: [], total: null, formatNotes: null, lineItems: [], pageRotations: [],
    }
  }

  const header = lines[0].toLowerCase().split(',').map(h => h.replace(/"/g, '').trim())
  const descIdx  = header.findIndex(h => h.includes('desc') || h.includes('item') || h.includes('product') || h.includes('name'))
  const qtyIdx   = header.findIndex(h => h.includes('qty') || h.includes('quant'))
  const unitIdx  = header.findIndex(h => h === 'unit' || h === 'uom')
  const priceIdx = header.findIndex(h => h.includes('price') || h.includes('cost'))
  const totalIdx = header.findIndex(h => h.includes('total') || h.includes('amount'))

  const lineItems: OcrLineItem[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim())
    const desc = descIdx >= 0 ? cols[descIdx] : cols[0]
    if (!desc) continue
    const qty       = qtyIdx   >= 0 ? parseFloat(cols[qtyIdx])   || null : null
    const unit      = unitIdx  >= 0 ? cols[unitIdx]  || null : null
    const unitPrice = priceIdx >= 0 ? parseFloat(cols[priceIdx]) || null : null
    const lineTotal = totalIdx >= 0 ? parseFloat(cols[totalIdx]) || null : null
    lineItems.push({
      description: desc,
      supplierItemCode: null,
      lineCategory: null,
      pricingMode: 'unknown',
      pricingModeSignal: 'indeterminate',
      qtyOrdered: qty,
      qtyOrderedUOM: unit,
      qtyShipped: qty,
      qtyShippedUOM: unit,
      packQty:  null,
      packSize: null,
      packUOM:  null,
      unitPrice,
      rate:     null,
      rateUOM:  null,
      totalQty: null,
      totalQtyUOM: null,
      isCatchweight: false,
      nominalWeight: null,
      lineTotal,
      taxFlag: null,
      lineTaxAmount: null,
      bbox: null,
      confidence: 'medium',
      confidenceNotes: null,
    })
  }

  return {
    supplierName: null, invoiceNumber: null, invoiceDate: null, poNumber: null,
    subtotal: null, discount: null, fuelSurcharge: null, freight: null,
    minimumOrderFee: null, gst: null, hst: null, pst: null,
    otherCharges: [], total: null, formatNotes: null, lineItems, pageRotations: [],
  }
}
