import Anthropic from '@anthropic-ai/sdk'

// Use the fastest vision-capable model for daily invoice scanning
const OCR_MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 20000
const THINKING_BUDGET = 10000

// Claude API limit is 5MB per image. Phone photos are often 8–15MB.
// Compress using sharp (native, excluded from webpack via serverExternalPackages).
async function compressImageForClaude(
  base64Data: string
): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  // Dynamic import keeps webpack happy — sharp stays in Node.js land
  const sharp = (await import('sharp')).default
  const inputBuffer = Buffer.from(base64Data, 'base64')

  // Resize, auto-rotate, normalize contrast, sharpen text edges
  let resized = await sharp(inputBuffer)
    .rotate()                                                           // fix EXIF orientation
    .resize(2500, 2500, { fit: 'inside', withoutEnlargement: true })   // limit to 2500px
    .normalize()                                                        // auto-contrast: stretches histogram to full [0,255]
    .sharpen({ sigma: 1.2, m2: 0.5 })                                  // mild unsharp mask — helps text edges without artifacts
    .jpeg({ quality: 90 })
    .toBuffer()

  // Reduce quality on the already-resized buffer (avoids re-reading original each pass)
  let quality = 90
  while (resized.length > 4 * 1024 * 1024 && quality > 60) {
    quality -= 15
    resized = await sharp(resized).jpeg({ quality }).toBuffer()
  }

  // Last resort: shrink to 1800px
  let outputBuffer = resized
  if (outputBuffer.length > 4 * 1024 * 1024) {
    outputBuffer = await sharp(resized)
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer()
  }

  return { data: outputBuffer.toString('base64'), mediaType: 'image/jpeg' }
}

// ── Base system prompt ─────────────────────────────────────────────────────────
const BASE_PROMPT = `You are an expert invoice parser for a restaurant supply chain system.
Extract ALL purchasable product line items and header data from the invoice image(s).
If multiple pages are provided, treat them as one invoice and combine all line items.

Return ONLY valid JSON (no markdown, no explanation):
{
  "supplierName": "string or null",
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "lineItems": [
    {
      "description": "exact product name from invoice",
      "qty": number or null,
      "unit": "cs/ea/box/bag/etc or null",
      "packQty": number or null,
      "packSize": number or null,
      "packUOM": "L/ml/kg/g/lb/oz/each or null",
      "unitPrice": number or null,
      "lineTotal": number or null,
      "rate": number or null,
      "totalQty": number or null
    }
  ]
}

UNIVERSAL PURCHASE STRUCTURE — every line item follows this 3-level hierarchy:
  CASE  = the outer unit being ordered (case, box, bag, crate, ea, etc.)
  PKG   = individual packages inside each case
  UNIT  = what each package contains (volume, weight, or count)

Field definitions:
  qty      = how many CASEs were ordered
  unit     = case label: "cs", "ea", "box", "bag", "each", etc.
  packQty  = how many PKGs per case
  packSize = the amount of UNIT content in each pkg — number only (NOMINAL, from label/description)
  packUOM  = unit for packSize — normalize: LTR/LITRE→L, ML/MILLILITRE→ml, KG/KILOGRAM→kg, LBS/POUNDS→lb, OZ/OUNCE→oz
  unitPrice = price per CASE (= lineTotal ÷ qty)
  lineTotal = total charged for this line (= qty × unitPrice)
  rate     = per-UOM price shown on invoice (e.g. 9.90 for $9.90/kg) — ONLY for weight/volume priced items
  totalQty = ACTUAL total weight/volume delivered for the whole line — look for "total weight", "shipped weight",
             "actual weight", or the weight/volume value in a weight/rate column for Format D items

═══════════════════════════════════════════════════════
ROW ALIGNMENT — CRITICAL RULE (most common parsing error):
═══════════════════════════════════════════════════════
Invoice tables are structured as rows. Each row is one data record.
- READ EACH ROW HORIZONTALLY: description, qty, price, and total for ONE item are ALL on the SAME row.
- NEVER borrow qty, price, or total values from a different row, even if a value seems missing from the current row.
- If a field is genuinely absent from a row, set it to null — do NOT pull it from an adjacent row.
- MULTI-ROW ITEMS: some formats place brand name or description continuation on row 2. Only the FIRST row
  contains the financial data (qty, price, total). Treat the second row as part of the first item's
  description — do NOT create a new line item for it and do NOT use its position to infer missing values.

CROSS-CHECK BEFORE OUTPUT:
For every extracted line item verify the math before including it:
  qty × unitPrice ≈ lineTotal (within 5%) — if this fails, you read qty or price from the wrong row; fix it
  For weight items: totalQty × rate ≈ lineTotal (within 5%) — if this fails, re-examine the row
If a cross-check fails, correct the error rather than outputting bad data.

═══════════════════════════════════════════════════════
SKIP RULES — lines that are NEVER products:
═══════════════════════════════════════════════════════
Skip any line that matches these patterns:
- Category section headers: lines naming a product group without a product code or price
    Examples: DAIRY PRODUCTS, PRODUCE, FROZEN, CANNED AND DRY, DRY, COOLER, PAPER & DISP,
              SUPP & EQUIP, BEVERAGE, GROCERY — especially when enclosed in dashes (-- DAIRY --)
              or asterisks (** DRY **)
- Category subtotals/totals: lines with only "Total" + an amount, or "Totals: N  Total [X] Pieces  XX"
- Non-product charges: Fuel Surcharge, Fuel Charge, Delivery Fee, Minimum Order Fee, Recycling Fee,
  Bottle Deposit, Freight, Environmental Fee, Service Charge
- Tax lines: GST, HST, PST, TVQ, QST (whether standalone or inline dollar amounts on item rows)
- Page-level aggregates: Page Total, Order Total, Subtotal, Sub Total, Invoice Total, INVOICE TOTAL
- Table column headers: rows containing labels like "Description", "Qty", "Price", "Amount", "Extension"
- Boilerplate text: delivery instructions, payment terms, legal notices, certifications blocks,
  "All raw product is to be cooked for consumption", "Please ensure payment..."
- Traceability sub-lines: LOT# lines, fishing method lines (TROLLING LINES, BEACH SEINES),
  certification codes (MSC-C-XXXXX, ASC-C-XXXXX), habitat (WILD), grade (GREEN - BEST CHOICE)
- Summary tables: Category Summary, Category Recap tables at end of invoice

═══════════════════════════════════════════════════════
HOW TO INTERPRET DIFFERENT INVOICE FORMATS:
═══════════════════════════════════════════════════════

Format A — Sysco (explicit columns: Qty Ord | B Unit | Pack Size | Price | Extension)
  Row: Qty:1  B Unit:4  Pack Size:5 LTR  Price:27.99  Ext:27.99
  → qty:1, unit:"cs", packQty:4, packSize:5, packUOM:"L", unitPrice:27.99, lineTotal:27.99

Format B — Size in description ("4/4L", "6x500ml", "4/500ML", "2/2KG")
  "CREAM 4/4L"    → packQty:4, packSize:4, packUOM:"L"
  "JUICE 6x500ml" → packQty:6, packSize:500, packUOM:"ml"
  "BUTTER 2/2KG"  → packQty:2, packSize:2, packUOM:"kg"
  Extract packQty/packSize/packUOM from description even if no explicit column exists.

Format C — Individual items (unit is EA, EACH, PC; or a single bottle/bag/unit)
  Treat as: 1 case = 1 pkg, so packQty:1. Extract packSize/packUOM from size column or description.
  "OLIVE OIL 3L  1  EA  8.99  8.99" → qty:1, packQty:1, packSize:3, packUOM:"L", unitPrice:8.99
  "VINEGAR 500ML  3  EA  2.50  7.50" → qty:3, packQty:1, packSize:500, packUOM:"ml", unitPrice:2.50

Format D — Weight-sold items (produce, meat — priced by weight/volume)
  ⚠ CRITICAL: unitPrice MUST be the price per CASE (= lineTotal ÷ qty), NEVER the per-kg/per-lb rate.
  Always populate BOTH rate AND totalQty for weight-sold items.

  "CHICKEN BREAST  5.2 LB  @3.99  20.75"
  → qty:1, packQty:1, packSize:5.2, packUOM:"lb", rate:3.99, totalQty:5.2, unitPrice:20.75, lineTotal:20.75

  "PORK BUTT  26.1 KG  $9.90/KG" (weight and rate columns, no explicit total)
  → lineTotal = 26.1 × 9.90 = 258.39
  → qty:1, packQty:1, packSize:26.1, packUOM:"kg", rate:9.90, totalQty:26.1, unitPrice:258.39, lineTotal:258.39

  ⚠ KEY SCENARIO — label says N pkgs × W kg each, but actual delivered weight differs:
  "CHICKEN  6 PKG/1KG EA  $9.90/KG  TOTAL WT: 4.8KG  Total: $47.52"
  → packQty:6, packSize:1, packUOM:"kg", rate:9.90, totalQty:4.8, unitPrice:47.52, lineTotal:47.52
  (packSize=1 is the NOMINAL label weight; totalQty=4.8 is the ACTUAL delivered weight — use totalQty for pricing)

  "TOMATOES  2 cases"  with no size info → packQty:null, packSize:null, packUOM:null, rate:null, totalQty:null

Format E — Count items (eggs, portions, pieces)
  "EGGS 6/12-ct"        → packQty:6, packSize:12, packUOM:"each"
  "EGGS DOZEN  2  CS"   → packQty:1, packSize:12, packUOM:"each"
  "BREAD ROLLS 24 CT"   → packQty:1, packSize:24, packUOM:"each"
  "MUFFINS 6x4"         → packQty:6, packSize:4, packUOM:"each"

Format F — Other suppliers (columns may be labeled differently)
  Look for: Quantity/Qty/Q, Unit/UOM/U/M, Size/Pack/Format, Price/Unit Price/Cost, Total/Amount/Ext/Extension
  Apply the same 3-level logic to fill as many fields as possible.

MISSING FIELD INFERENCE:
  If qty AND unitPrice known → compute lineTotal = qty × unitPrice
  If qty AND lineTotal known → compute unitPrice = lineTotal / qty
  If totalQty AND rate AND packUOM(weight/volume) shown → lineTotal = totalQty × rate; unitPrice = lineTotal ÷ qty
  If packSize AND packUOM(weight/volume) AND rate shown but no totalQty → totalQty = qty × packQty × packSize; lineTotal = totalQty × rate; unitPrice = lineTotal ÷ qty
  If size appears in description (e.g. "5L") and packQty not shown → packQty:1, packSize:5, packUOM:"L"

Rules:
- Extract EVERY real product line item (food, beverages, supplies with an item number or product code)
- Preserve exact product descriptions as written on the invoice
- Numbers only, no currency symbols (12.50 not "$12.50")
- SKIP non-product lines: Fuel Surcharge, Recycling Fee, Bottle Deposit, GST/HST, PST, Tax Summary, Warehouse Recap, Deposit Recap, category subtotal headers (e.g. "DAIRY PRODUCTS", "PRODUCE", "Total")
- For Sysco invoices: each product row has an ITEM NO. (6-7 digit number) — only extract those rows
- Dates in YYYY-MM-DD format
- null only for fields that are genuinely impossible to determine`

// ── Supplier-specific format hints ─────────────────────────────────────────────
// Keyed by normalized substring of supplier name. Injected into the prompt when
// the session's supplier is already known, giving Claude exact column layouts.
const SUPPLIER_HINTS: Record<string, string> = {
  sysco: `
SUPPLIER IDENTIFIED: SYSCO CANADA
Columns (left→right): ITEM NO./ARTICLE | QTY.ORD./COMMANDE | QTY.SHPD./EXPÉDIÉ | B UNIT/UNITÉ | PACK SIZE FORMAT | BRAND/MARQUE | DESCRIPTION | WEIGHT/POIDS | PRICE/PRIX | EXTENSION/MONTANT

ANCHOR: Every real product row begins with a 6-7 digit ITEM NO. Rows with no item number are NOT products.

FIELD MAPPING:
  qty       = QTY.SHPD. column (shipped quantity, not ordered)
  unit      = "cs"
  packQty   = B UNIT column (number of packages per case)
  packSize + packUOM = parse from PACK SIZE FORMAT column
    "1 KG" → packSize:1, packUOM:kg | "8 EA" → packSize:8, packUOM:each
    "3 L"  → packSize:3, packUOM:L  | "100CT" → packSize:100, packUOM:each
  unitPrice = PRICE column — $/case in normal rows
  lineTotal = EXTENSION column

WEIGHT-PRICED ROWS: When the WEIGHT/POIDS column has a numeric value (not blank or "TBD"):
  rate      = PRICE column ($/kg or $/lb — same UOM as packUOM)
  totalQty  = WEIGHT column value
  lineTotal = EXTENSION column
  unitPrice = EXTENSION ÷ QTY.SHPD.

SKIP THESE (they are NOT products — no item number):
  - Category headers: "-- DAIRY PRODUCTS --", "-- CANNED AND DRY --", "-- PAPER & DISP --",
    "-- SUPP & EQUIP --", "-- PRODUCE --", "-- FROZEN --", "-- BEVERAGE --" and similar
  - Category totals: lines like "Total  59.63" (label "Total" + amount, no item number)
  - Last-page summary block: P.S.T./T.V.P., ORDER TOTAL/TOTAL COMMANDE, CUBE, PIECES/MORCEAUX rows`,

  gordon: `
SUPPLIER IDENTIFIED: GFS / GORDON FOOD SERVICE
Columns: Item Code(7 digits) | Qty Ord | Qty Ship | Unit | Pack Size | Brand | Item Description | Ø | Cust Cat | Unit Price | (tax col) | Extended Price

ANCHOR: Every real product row begins with a 7-digit Item Code. Rows without an item code are NOT products.

FIELD MAPPING:
  qty       = Qty Ship column
  unit      = Unit column (CS, EA, etc.)
  packQty + packSize + packUOM = parse from Pack Size column:
    "1x24 UN" → packQty:1, packSize:24, packUOM:each
    "2x5 KG"  → packQty:2, packSize:5,  packUOM:kg
    "1x4 L"   → packQty:1, packSize:4,  packUOM:L
  unitPrice = Unit Price column (always $/case)
  lineTotal = Extended Price column
  Cust Cat column (PR, DS, etc.) is a category code — NOT a field to extract as a product

SKIP THESE (no item code):
  - "Totals: N  Total [Category] Pieces  XX.XX" — category subtotal rows
  - "Page Total: XX.XX" — page subtotal row
  - Entire "Category Summary" / "Category Recap" table at end of invoice
  - Non-product fee rows: "Fuel Charge", "Minimum Order Fee" (appear in Category Summary)
  - Footer: "Product Total", "Misc", "Sub total", "PST/QST", "GST/HST", "Invoice Total"`,

  'snow cap': `
SUPPLIER IDENTIFIED: SNOW CAP ENTERPRISES
Columns: BIN LOC. | ITEM NO. | QUAN. | DESCRIPTION | SIZE | UNIT PRICE | AMOUNT

ANCHOR: Every real product row has a BIN LOC. code (format "WF-22-1", "CB-10-1", etc.) and an ITEM NO.

FIELD MAPPING:
  qty       = QUAN. column
  unit      = "cs" (or "ea" for single units)
  packQty + packSize + packUOM = parse from SIZE column using these rules:
    "9/3LB"  → packQty:9,  packSize:3,   packUOM:lb
    "4/4L"   → packQty:4,  packSize:4,   packUOM:L
    "20KG"   → packQty:1,  packSize:20,  packUOM:kg
    "2.5KG"  → packQty:1,  packSize:2.5, packUOM:kg
    "100PC"  → packQty:1,  packSize:100, packUOM:each
    "9L"     → packQty:1,  packSize:9,   packUOM:L
    "1KG"    → packQty:1,  packSize:1,   packUOM:kg
  unitPrice = UNIT PRICE column (always $/case — Snow Cap never uses weight pricing)
  lineTotal = AMOUNT column = QUAN × UNIT PRICE

SKIP THESE:
  - Category section headers: "** DRY **", "** COOLER **", "** FROZEN **", "** PRODUCE **"
    and any line enclosed in "** ... **"
  - LOT# lines — appear below some items as "LOT#  260417"; these are traceability numbers, not products
  - Delivery instruction text at top: "TRUCK MUST BE PARKED IN PARKING LOT..."
  - Inline tax amounts: "GST: 1.32  PST: 1.85" may appear at the end of an item line —
    these are taxes on that item, NOT separate line items; ignore the numbers
  - Footer: subtotals, tax summary rows`,

  'legends haul': `
SUPPLIER IDENTIFIED: LEGENDS HAUL / ACECARD FOOD GROUP
Columns: PRODUCT ID | ORDERED | SHIPPED | unit(PC/PK/CS) | DESCRIPTION/SIZE/BRAND | TAX | WEIGHT | PRICE | per | AMOUNT

TWO-ROW ITEMS — CRITICAL: Each product occupies exactly TWO rows:
  Row 1: PRODUCT ID, qty data, full description with size, weight, price, amount
  Row 2: Brand name ONLY (e.g. "BRITCO", "JBS/CARGIL", "WHITEVEAL", "GOLDENVALL")
  → Do NOT create a separate line item for Row 2. It belongs to Row 1.
  → All financial data (weight, price, amount) comes from Row 1 only.

ANCHOR: Real product rows have a 5-digit PRODUCT ID. Brand-name rows have no product ID.

FIELD MAPPING:
  qty  = SHIPPED column value (the number of pieces/packages/cases actually delivered)
  unit = the unit column adjacent to SHIPPED — PC (pieces), PK (packages), or CS (cases)

  ⚠ UNIT COLUMN IS NOT A MULTIPLIER: "4 PC" means 4 individual pieces. If the description
    says "Beef Brisket 4x7kg" and SHIPPED is "4 PC", that is 4 pieces — NOT 4×4=16.
    The description's pack notation (4x7kg) describes the NOMINAL case format only.

  per column determines pricing mode:
    per = KG → weight-priced item:
      rate      = PRICE column ($/kg)
      totalQty  = WEIGHT column value (ACTUAL delivered kg — authoritative, always use this)
      totalQtyUOM = "kg"
      lineTotal = AMOUNT column
      unitPrice = AMOUNT ÷ SHIPPED qty

    per = CS → case-priced item:
      unitPrice = PRICE column ($/case)
      lineTotal = AMOUNT column

  ⚠ DESCRIPTION SIZE IS NOMINAL ONLY: "Beef Brisket 4x7kg" means the case is nominally
    4 pieces of ~7kg each, but actual meat weights vary. The WEIGHT column is the true
    delivered weight — NEVER use description arithmetic (4×7=28) to derive or verify totalQty.
    Example: description "Beef Brisket 4x7kg", WEIGHT=36.1 KG, PRICE=18.00, AMOUNT=649.80
    → qty:4, unit:"pc", rate:18.00, totalQty:36.1, lineTotal:649.80, unitPrice:162.45
    (NOT totalQty:28 — ignore the 4×7 math entirely)

  packQty/packSize/packUOM from DESCRIPTION (nominal reference only, not for pricing):
    "Pork Butt BL Fresh 6/cs"          → packQty:6
    "Beef Digital AA FZ 1kg pkgs"      → packQty:1, packSize:1, packUOM:kg
    "Eggs Dark Yolk LW Loose 180/case" → packSize:180, packUOM:each
    "Veal Bones (Knuckle) Fz 50lb/cs"  → packSize:50, packUOM:lb
    "Beef Brisket 4x7kg"               → packQty:4, packSize:7, packUOM:kg (nominal only)

SKIP THESE:
  - Brand name rows (Row 2 of each item — no product ID, just a name like "BRITCO")
  - "Total Weight ......  XXX KG", "Sub Total", "Discount", "Fuel Surcharge",
    "Freight", "GST", "PST", "Invoice Total", "Total Pieces: N"`,

  'intercity packers': `
SUPPLIER IDENTIFIED: INTERCITY PACKERS (meat & seafood)
Columns: PRODUCT | DESCRIPTION | PACK | QTY ORD | U/M | QTY SHIP | U/M | PRICE | AMOUNT | TAX

MULTI-ROW ITEMS — CRITICAL: Each product spans MULTIPLE rows:
  Row 1: PRODUCT code + first line of description + pack + qty + price + amount
  Rows 2+: Description continuation ONLY — no financial data. These include:
    fishing method (TROLLING LINES, BEACH SEINES, LONGLINE)
    habitat (WILD, FARMED)
    certifications (MSC-C-50507, ASC-C-00057)
    grade/quality (GREEN - BEST CHOICE, BLUE)
    weight class (3LB, 40LB)
    brand (OCEANWISE, TAJIMA, etc.)
  → Merge relevant description rows into the product name, then skip them as separate items.
  → All financial data (qty, price, amount) comes from Row 1 ONLY.

ANCHOR: Real product rows have a numeric PRODUCT code (8 digits). Sub-description rows have no product code.

ALL ITEMS ARE WEIGHT-PRICED:
  qty         = QTY SHIP column value (actual shipped weight)
  unit        = U/M column adjacent to QTY SHIP (LB or KG)
  rate        = PRICE column ($/lb or $/kg)
  totalQty    = QTY SHIP value (same as qty — all items sold by weight)
  totalQtyUOM = U/M column (LB or KG)
  lineTotal   = AMOUNT column = QTY SHIP × PRICE
  unitPrice   = AMOUNT (treat as $/case since qty=shipped weight)
  packSize + packUOM = parse from PACK column: "1/10 LB" → packQty:1, packSize:10, packUOM:lb

SKIP THESE:
  - All description continuation rows (no product code)
  - Boilerplate: "All raw product is to be cooked for consumption",
    "Please ensure payment including EFT is paid to Intercity Packers LTD"
  - "INTEREST CHARGES" section, "CLAIMS" section
  - Footer: "TOTAL WEIGHT (KG)", "TOTAL PIECES", "TERMS", "SUBTOTAL",
    "FUEL SURCHARGE", "FREIGHT", "PST", "HST/GST", "INVOICE TOTAL"`,

  acecard: `
SUPPLIER IDENTIFIED: LEGENDS HAUL / ACECARD FOOD GROUP
Columns: PRODUCT ID | ORDERED | SHIPPED | unit(PC/PK/CS) | DESCRIPTION/SIZE/BRAND | TAX | WEIGHT | PRICE | per | AMOUNT

TWO-ROW ITEMS — CRITICAL: Each product occupies exactly TWO rows:
  Row 1: PRODUCT ID, qty data, full description with size, weight, price, amount
  Row 2: Brand name ONLY (e.g. "BRITCO", "JBS/CARGIL", "WHITEVEAL", "GOLDENVALL")
  → Do NOT create a separate line item for Row 2. It belongs to Row 1.
  → All financial data (weight, price, amount) comes from Row 1 only.

ANCHOR: Real product rows have a 5-digit PRODUCT ID. Brand-name rows have no product ID.

FIELD MAPPING:
  qty  = SHIPPED column value
  unit = unit column (PC=pieces, PK=packages, CS=cases) — not a multiplier on description
  per = KG → rate=PRICE($/kg), totalQty=WEIGHT(actual kg), lineTotal=AMOUNT, unitPrice=AMOUNT÷SHIPPED
  per = CS → unitPrice=PRICE($/case), lineTotal=AMOUNT

  ⚠ WEIGHT column is ALWAYS authoritative for per=KG items — never derive totalQty from description
  ⚠ "4 PC" of "Beef Brisket 4x7kg" = 4 pieces (qty:4), NOT 16. Description size is nominal only.

SKIP THESE:
  - Brand name rows (Row 2 — no product ID)
  - Footer rows: "Total Weight", "Sub Total", "Discount", "Fuel Surcharge",
    "Freight", "GST", "PST", "Invoice Total", "Total Pieces"`,
}

// Lookup supplier hints by normalizing the supplier name and checking substrings
function getSupplierHint(supplierName: string | null | undefined): string {
  if (!supplierName) return ''
  const n = supplierName.toLowerCase()
  if (n.includes('sysco'))              return SUPPLIER_HINTS['sysco']
  if (n.includes('gordon') || n.includes('gfs')) return SUPPLIER_HINTS['gordon']
  if (n.includes('snow cap'))           return SUPPLIER_HINTS['snow cap']
  if (n.includes('legends haul'))       return SUPPLIER_HINTS['legends haul']
  if (n.includes('acecard'))            return SUPPLIER_HINTS['acecard']
  if (n.includes('intercity'))          return SUPPLIER_HINTS['intercity packers']
  return ''
}

function buildSystemPrompt(supplierName?: string | null): string {
  const hint = getSupplierHint(supplierName)
  if (!hint) return BASE_PROMPT
  return BASE_PROMPT + '\n\n' +
    '═══════════════════════════════════════════════════════\n' +
    'SUPPLIER-SPECIFIC RULES — these override general rules:\n' +
    '═══════════════════════════════════════════════════════' +
    hint
}

export interface OcrLineItem {
  description: string
  qty: number | null
  unit: string | null
  packQty: number | null    // units per case (Sysco B Unit)
  packSize: number | null   // NOMINAL size per unit from label (e.g. 5 from "5 LTR")
  packUOM: string | null    // UOM for packSize (L, ml, kg, g, lb, oz, each)
  unitPrice: number | null
  lineTotal: number | null
  rate: number | null       // per-UOM rate shown on invoice (e.g. 9.90 for $9.90/kg)
  totalQty: number | null   // ACTUAL total weight/volume delivered for this line
}

export interface OcrResult {
  supplierName: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  subtotal: number | null
  tax: number | null
  total: number | null
  lineItems: OcrLineItem[]
}

function parseOcrResponse(rawText: string): OcrResult {
  const text = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  if (!text) {
    throw new Error('Claude returned an empty response — invoice may be unreadable or the image quality is too low')
  }

  try {
    const parsed = JSON.parse(text) as OcrResult
    // Validate minimum shape
    if (!Array.isArray(parsed.lineItems)) {
      parsed.lineItems = []
    }
    return parsed
  } catch (e) {
    // Log the raw text so we can debug what Claude actually returned
    console.error('[ocr] JSON parse failed. Raw response (first 500 chars):', text.slice(0, 500))
    throw new Error(`Failed to parse OCR response as JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── Multi-image (ALL pages in ONE API call — fastest approach for photo invoices) ──
export async function extractInvoiceFromImages(
  files: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>,
  supplierName?: string | null
): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  // Compress all images in parallel
  const compressedImages = await Promise.all(
    files.map(async (f) => {
      const rawBytes = Buffer.byteLength(f.base64, 'base64')
      if (rawBytes > 4 * 1024 * 1024 || f.mediaType !== 'image/jpeg') {
        const compressed = await compressImageForClaude(f.base64)
        console.log(`[ocr] Compressed: ${(rawBytes / 1024 / 1024).toFixed(1)}MB → ${(Buffer.byteLength(compressed.data, 'base64') / 1024 / 1024).toFixed(1)}MB`)
        return compressed
      }
      return { data: f.base64, mediaType: f.mediaType as 'image/jpeg' }
    })
  )

  // Build content blocks — one image block per page, then a single instruction
  const imageBlocks: Anthropic.ImageBlockParam[] = compressedImages.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(supplierName),
    thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
    messages: [{
      role: 'user',
      content: [
        ...imageBlocks,
        {
          type: 'text',
          text: files.length > 1
            ? `These are ${files.length} pages of the same invoice. Parse all pages together and return one combined JSON object.`
            : 'Parse this invoice and return JSON only.',
        },
      ],
    }],
  } as any)

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return parseOcrResponse(text)
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
  supplierName?: string | null
): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const base64 = pdfBuffer.toString('base64')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(supplierName),
    thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
    messages: [{
      role: 'user',
      content: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
        { type: 'text', text: 'Parse this invoice and return JSON only.' },
      ],
    }],
  } as any)

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return parseOcrResponse(text)
}

// ── Plain text (Claude-assisted) ──
export async function extractInvoiceFromText(
  text: string,
  supplierName?: string | null
): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(supplierName),
    thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET },
    messages: [{
      role: 'user',
      content: `Parse this invoice text and return JSON only.\n\n${text}`,
    }],
  } as any)

  const responseText = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return parseOcrResponse(responseText)
}

// ── CSV — local parse, no API call needed ──
export async function extractInvoiceFromCsv(csvText: string): Promise<OcrResult> {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { supplierName: null, invoiceNumber: null, invoiceDate: null, subtotal: null, tax: null, total: null, lineItems: [] }
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
    lineItems.push({
      description: desc,
      qty:       qtyIdx   >= 0 ? parseFloat(cols[qtyIdx])   || null : null,
      unit:      unitIdx  >= 0 ? cols[unitIdx]  || null : null,
      packQty:   null,
      packSize:  null,
      packUOM:   null,
      unitPrice: priceIdx >= 0 ? parseFloat(cols[priceIdx]) || null : null,
      lineTotal: totalIdx >= 0 ? parseFloat(cols[totalIdx]) || null : null,
      rate:      null,
      totalQty:  null,
    })
  }

  return { supplierName: null, invoiceNumber: null, invoiceDate: null, subtotal: null, tax: null, total: null, lineItems }
}
