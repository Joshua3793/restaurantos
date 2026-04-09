import Anthropic from '@anthropic-ai/sdk'

const SYSTEM_PROMPT = `You are an expert invoice parser for a restaurant supply chain system.
Extract ALL line items and header data from the invoice image or document.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "supplierName": "string or null",
  "invoiceNumber": "string or null",
  "invoiceDate": "YYYY-MM-DD or null",
  "subtotal": number or null,
  "tax": number or null,
  "total": number or null,
  "lineItems": [
    {
      "description": "exact product name/description from invoice",
      "qty": number or null,
      "unit": "unit of measure (e.g. kg, L, each, case, box) or null",
      "unitPrice": number or null,
      "lineTotal": number or null
    }
  ]
}

Rules:
- Extract EVERY line item, including partial entries
- Preserve exact product descriptions as written on the invoice
- For qty/price, extract numbers only (no currency symbols)
- If a field is unclear or missing, use null
- Dates must be in YYYY-MM-DD format
- Numbers must be plain floats (e.g. 12.50, not "$12.50")`

export interface OcrLineItem {
  description: string
  qty: number | null
  unit: string | null
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

export async function extractInvoiceFromImage(
  base64Data: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: 3000 },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data },
          },
          { type: 'text', text: 'Parse this invoice completely and return JSON only.' },
        ],
      },
    ],
  })

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  return JSON.parse(text) as OcrResult
}

export async function extractInvoiceFromText(text: string): Promise<OcrResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

  const client = new Anthropic({ apiKey })

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: 3000 },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Parse this invoice text completely and return JSON only.\n\n${text}`,
      },
    ],
  })

  const responseText = message.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim()

  return JSON.parse(responseText) as OcrResult
}

export async function extractInvoiceFromCsv(csvText: string): Promise<OcrResult> {
  // For CSVs, parse directly without Claude — look for header row + data rows
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) {
    return { supplierName: null, invoiceNumber: null, invoiceDate: null, subtotal: null, tax: null, total: null, lineItems: [] }
  }

  // Try to find column indices from header row
  const header = lines[0].toLowerCase().split(',').map(h => h.replace(/"/g, '').trim())
  const descIdx = header.findIndex(h => h.includes('desc') || h.includes('item') || h.includes('product') || h.includes('name'))
  const qtyIdx  = header.findIndex(h => h.includes('qty') || h.includes('quant'))
  const unitIdx = header.findIndex(h => h === 'unit' || h === 'uom')
  const priceIdx = header.findIndex(h => h.includes('price') || h.includes('unit price') || h.includes('cost'))
  const totalIdx = header.findIndex(h => h.includes('total') || h.includes('amount'))

  const lineItems: OcrLineItem[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.replace(/"/g, '').trim())
    const desc = descIdx >= 0 ? cols[descIdx] : cols[0]
    if (!desc) continue
    lineItems.push({
      description: desc,
      qty:       qtyIdx >= 0 ? parseFloat(cols[qtyIdx]) || null : null,
      unit:      unitIdx >= 0 ? cols[unitIdx] || null : null,
      unitPrice: priceIdx >= 0 ? parseFloat(cols[priceIdx]) || null : null,
      lineTotal: totalIdx >= 0 ? parseFloat(cols[totalIdx]) || null : null,
    })
  }

  return { supplierName: null, invoiceNumber: null, invoiceDate: null, subtotal: null, tax: null, total: null, lineItems }
}
