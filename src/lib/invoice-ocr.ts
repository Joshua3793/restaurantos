import Anthropic from '@anthropic-ai/sdk'

// Use the fastest vision-capable model for daily invoice scanning
const OCR_MODEL = 'claude-opus-4-6'
const MAX_TOKENS = 8096

// Claude API limit is 5MB per image. Phone photos are often 8–15MB.
// Compress using sharp (native, excluded from webpack via serverExternalPackages).
async function compressImageForClaude(
  base64Data: string
): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  // Dynamic import keeps webpack happy — sharp stays in Node.js land
  const sharp = (await import('sharp')).default
  const inputBuffer = Buffer.from(base64Data, 'base64')

  let quality = 85
  // Resize to max 2000px longest edge, auto-rotate from EXIF, convert to JPEG
  let outputBuffer = await sharp(inputBuffer)
    .rotate()
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer()

  // Reduce quality until under 4MB
  while (outputBuffer.length > 4 * 1024 * 1024 && quality > 40) {
    quality -= 15
    outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
  }

  // Last resort: shrink to 1400px
  if (outputBuffer.length > 4 * 1024 * 1024) {
    outputBuffer = await sharp(inputBuffer)
      .rotate()
      .resize(1400, 1400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer()
  }

  return { data: outputBuffer.toString('base64'), mediaType: 'image/jpeg' }
}

const SYSTEM_PROMPT = `You are an expert invoice parser for a restaurant supply chain system.
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
      "lineTotal": number or null
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
  packSize = the amount of UNIT content in each pkg — number only
  packUOM  = unit for packSize — normalize: LTR/LITRE→L, ML/MILLILITRE→ml, KG/KILOGRAM→kg, LBS/POUNDS→lb, OZ/OUNCE→oz
  unitPrice = price per CASE (= lineTotal ÷ qty)
  lineTotal = total charged for this line (= qty × unitPrice)

HOW TO INTERPRET DIFFERENT INVOICE FORMATS:

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

Format D — Weight-sold items (produce, meat — priced by weight)
  ⚠ CRITICAL: unitPrice MUST be the price per CASE (= lineTotal ÷ qty), NEVER the per-kg/per-lb rate.
  When the invoice shows a weight column and a $/kg or $/lb rate column separately:
    → Compute lineTotal = packSize × rate, then unitPrice = lineTotal ÷ qty
    → The rate (e.g. $9.90/kg) is NEVER used as unitPrice

  "CHICKEN BREAST  5.2 LB  @3.99  20.75"
  → qty:1, packQty:1, packSize:5.2, packUOM:"lb", unitPrice:20.75, lineTotal:20.75

  "PORK BUTT  26.1 KG  $9.90/KG" (Acecard-style: weight and rate columns, no explicit total)
  → lineTotal = 26.1 × 9.90 = 258.39
  → qty:1, packQty:1, packSize:26.1, packUOM:"kg", unitPrice:258.39, lineTotal:258.39
  (CORRECT: unitPrice=258.39  WRONG: unitPrice=9.90)

  "TOMATOES  2 cases"  with no size info → packQty:null, packSize:null, packUOM:null

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
  If packSize AND packUOM(weight/volume) AND rate/$/UOM shown but no lineTotal → lineTotal = packSize × rate; unitPrice = lineTotal ÷ qty
  If size appears in description (e.g. "5L") and packQty not shown → packQty:1, packSize:5, packUOM:"L"

Rules:
- Extract EVERY real product line item (food, beverages, supplies with an item number or product code)
- Preserve exact product descriptions as written on the invoice
- Numbers only, no currency symbols (12.50 not "$12.50")
- SKIP non-product lines: Fuel Surcharge, Recycling Fee, Bottle Deposit, GST/HST, PST, Tax Summary, Warehouse Recap, Deposit Recap, category subtotal headers (e.g. "DAIRY PRODUCTS", "PRODUCE", "Total")
- For Sysco invoices: each product row has an ITEM NO. (6-7 digit number) — only extract those rows
- Dates in YYYY-MM-DD format
- null only for fields that are genuinely impossible to determine`

export interface OcrLineItem {
  description: string
  qty: number | null
  unit: string | null
  packQty: number | null    // units per case (Sysco B Unit)
  packSize: number | null   // size per unit (e.g. 5 from "5 LTR")
  packUOM: string | null    // UOM for packSize (L, ml, kg, g, lb, oz, each)
  unitPrice: number | null
  lineTotal: number | null
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
  files: Array<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }>
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

  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
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
  })

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
export async function extractInvoiceFromPdf(pdfBuffer: Buffer): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })
  const base64 = pdfBuffer.toString('base64')

  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
        { type: 'text', text: 'Parse this invoice and return JSON only.' },
      ],
    }],
  })

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')

  return parseOcrResponse(text)
}

// ── Plain text (Claude-assisted) ──
export async function extractInvoiceFromText(text: string): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: OCR_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Parse this invoice text and return JSON only.\n\n${text}`,
    }],
  })

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
    })
  }

  return { supplierName: null, invoiceNumber: null, invoiceDate: null, subtotal: null, tax: null, total: null, lineItems }
}
