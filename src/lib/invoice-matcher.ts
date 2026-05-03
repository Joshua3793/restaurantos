import { prisma } from '@/lib/prisma'
import type { OcrLineItem } from '@/lib/invoice-ocr'
import { parseFormatFromDescription, comparePricesNormalized, calcNewPurchasePrice } from '@/lib/invoice-format'

export type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
export type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

export interface MatchResult {
  matchedItemId: string | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  previousPrice: number | null
  newPrice: number | null
  priceDiffPct: number | null
  formatMismatch: boolean
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
  totalQty: number | null
  totalQtyUOM: string | null
}

interface InventoryItem {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
  baseUnit: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  // Pre-computed at load time for efficiency
  _normName?: string[]
  _keyName?: string[]
}

// Generic food descriptors that appear in many products and should not drive matching
const STOP_WORDS = new Set([
  'fresh', 'frozen', 'dried', 'whole', 'sliced', 'diced', 'chopped', 'minced',
  'organic', 'natural', 'pure', 'premium', 'select', 'choice', 'fancy', 'extra',
  'low', 'high', 'ultra', 'super', 'regular', 'original', 'classic',
  'white', 'black', 'red', 'green', 'yellow', 'dark', 'light',
  'large', 'small', 'medium', 'mini', 'jumbo', 'bulk', 'size',
  'and', 'the', 'for', 'with', 'from',
])

// Normalize: lowercase, strip punctuation, split into meaningful words
function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
}

// Key words: normalize then remove stop words (what the product actually is)
function keyWords(s: string): string[] {
  return normalize(s).filter(w => !STOP_WORDS.has(w))
}

// Compute a match score (0–100) between an invoice description and an inventory item
// Uses pre-normalized name arrays when available (set by matchLineItems for efficiency)
function scoreMatch(description: string, item: InventoryItem, descNorm: string[], descKey: string[]): number {
  const nameNorm = item._normName ?? normalize(item.itemName)
  const nameKey  = item._keyName  ?? keyWords(item.itemName)

  // ── Exact match ──────────────────────────────────────────────────────────
  if (descNorm.join(' ') === nameNorm.join(' ')) return 100

  // ── Key word overlap (the core signal) ───────────────────────────────────
  if (descKey.length === 0 || nameKey.length === 0) return 0

  const descKeySet = new Set(descKey)
  const nameKeySet = new Set(nameKey)

  const overlapCount = nameKey.filter(w => descKeySet.has(w)).length

  // Hard requirement: at least one key word must overlap
  if (overlapCount === 0) return 0

  // Jaccard-style ratio over key words
  const union = new Set([...descKey, ...nameKey]).size
  const jaccardScore = (overlapCount / union) * 100

  // Coverage: what fraction of the inventory name's key words appear in the description
  const nameCoverage = overlapCount / nameKey.length

  let score = Math.max(jaccardScore, nameCoverage * 75)

  // Bonus: all inventory key words are in the description (full name covered)
  if (nameKey.every(w => descKeySet.has(w))) {
    score = Math.max(score, 70)
    // Extra bonus if name key words appear in order at the start
    if (descKey.slice(0, nameKey.length).join(' ') === nameKey.join(' ')) score = Math.max(score, 85)
  }

  // Bonus: first key word of both sides matches (same product type)
  if (descKey[0] && nameKey[0] && descKey[0] === nameKey[0]) score += 12

  // Strong penalty: first key words are completely different product types
  if (descKey[0] && nameKey[0] && descKey[0] !== nameKey[0]
      && !nameKeySet.has(descKey[0]) && !descKeySet.has(nameKey[0])) {
    score *= 0.4
  }

  return Math.min(Math.round(score), 99)
}

function confidenceFromScore(score: number): MatchConfidence {
  if (score >= 65) return 'HIGH'
  if (score >= 40) return 'MEDIUM'
  if (score >= 25) return 'LOW'
  return 'NONE'
}

function buildMatchResult(
  ocrItem: OcrLineItem,
  bestItem: InventoryItem,
  confidence: MatchConfidence,
  bestScore: number,
  format?: { packQty: number; packSize: number; packUOM: string } | null,
  formatConfirmed = false   // true only when format came from a saved learned rule
): OcrLineItem & MatchResult {
  const previousPrice = Number(bestItem.purchasePrice)
  const rawUnitPrice = ocrItem.unitPrice

  let newPrice: number | null = rawUnitPrice ?? null
  let priceDiffPct: number | null = null
  let invoicePackQty: number | null = null
  let invoicePackSize: number | null = null
  let invoicePackUOM: string | null = null
  let needsFormatConfirm = false

  if (format) {
    // Always store the parsed format for display
    invoicePackQty = format.packQty
    invoicePackSize = format.packSize
    invoicePackUOM = format.packUOM

    if (formatConfirmed && rawUnitPrice !== null) {
      // ── Per-base comparison — only when the user previously confirmed this format ──
      // Convert invoice price to per-packUOM (e.g. $/L), then normalize to SI base
      const total = format.packQty * format.packSize
      if (total > 0) {
        const invoicePricePerPackUOM = rawUnitPrice / total  // e.g. $2.756/L
        // Recompute inventory's price-per-packUOM from raw fields so we never
        // rely on the stored pricePerBaseUnit (which can be stale / mis-scaled).
        const invPackTotal = Number(bestItem.qtyPerPurchaseUnit) * Number(bestItem.packSize)
        const invPricePerPackUOM = invPackTotal > 0 ? Number(bestItem.purchasePrice) / invPackTotal : 0
        const normalized = comparePricesNormalized(
          invoicePricePerPackUOM, format.packUOM,    // invoice: $/packUOM
          invPricePerPackUOM,     bestItem.packUOM   // inventory: $/packUOM (recomputed)
        )

        if (normalized) {
          priceDiffPct = normalized.pctDiff
          // Calculate newPrice normalized to inventory's purchase format
          const calcPrice = calcNewPurchasePrice(
            invoicePricePerPackUOM, format.packUOM,
            Number(bestItem.qtyPerPurchaseUnit), Number(bestItem.packSize), bestItem.packUOM
          )
          if (calcPrice !== null) newPrice = calcPrice
        } else {
          // Truly incompatible units (e.g. kg vs mL) — fall back to direct comparison
          if (previousPrice > 0) {
            priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
          }
          needsFormatConfirm = true
        }
      }
    } else {
      // Format auto-parsed but not yet confirmed — use direct price comparison,
      // show the parsed format hint, and prompt user to confirm it
      if (previousPrice > 0 && rawUnitPrice !== null) {
        priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
      }
      // Flag for confirmation only if the item has a non-trivial format
      const hasComplexFormat = bestItem.packUOM && bestItem.packUOM.toLowerCase() !== 'each'
        && Number(bestItem.packSize) > 1
      needsFormatConfirm = !!(hasComplexFormat && rawUnitPrice !== null)
    }
  } else {
    // No format info — direct purchase price comparison
    if (previousPrice > 0 && rawUnitPrice !== null) {
      priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
    }
    newPrice = rawUnitPrice ?? null
    const hasComplexFormat = bestItem.packUOM && bestItem.packUOM.toLowerCase() !== 'each'
      && Number(bestItem.packSize) > 1
    needsFormatConfirm = !!(hasComplexFormat && rawUnitPrice !== null)
  }

  let action: LineItemAction = 'PENDING'
  if (confidence === 'HIGH' || confidence === 'MEDIUM') {
    action = (priceDiffPct !== null && Math.abs(priceDiffPct) > 0.1) ? 'UPDATE_PRICE' : 'ADD_SUPPLIER'
  }

  const formatMismatch = !!(
    ocrItem.unit &&
    bestItem.purchaseUnit &&
    ocrItem.unit.toLowerCase() !== bestItem.purchaseUnit.toLowerCase()
  )

  return {
    ...ocrItem,
    matchedItemId: bestItem.id,
    matchConfidence: confidence,
    matchScore: bestScore,
    action,
    previousPrice,
    newPrice,
    priceDiffPct: priceDiffPct ?? null,
    formatMismatch,
    invoicePackQty,
    invoicePackSize,
    invoicePackUOM,
    needsFormatConfirm,
    totalQty:    ocrItem.totalQty  ?? null,
    totalQtyUOM: ocrItem.packUOM   ?? null,
  }
}

export async function matchLineItems(
  ocrItems: OcrLineItem[],
  supplierName?: string | null
): Promise<(OcrLineItem & MatchResult)[]> {
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      itemName: true,
      purchaseUnit: true,
      pricePerBaseUnit: true,
      purchasePrice: true,
      baseUnit: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
    },
  })

  // Load learned rules — gracefully fall back to empty if the table doesn't exist yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let learnedRules: any[] = []
  try {
    learnedRules = await prisma.invoiceMatchRule.findMany({
      where: {
        rawDescription: { in: ocrItems.map(i => i.description) },
        supplierName: { in: [supplierName ?? '', ''] },
      },
      include: {
        inventoryItem: {
          select: {
            id: true,
            itemName: true,
            purchaseUnit: true,
            pricePerBaseUnit: true,
            purchasePrice: true,
            baseUnit: true,
            qtyPerPurchaseUnit: true,
            packSize: true,
            packUOM: true,
          },
        },
      },
      orderBy: { useCount: 'desc' },
    })
  } catch {
    // Table may not exist yet — proceed with fuzzy matching only
  }

  // Build learned map: description → best rule (supplier-specific beats generic)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const learnedMap = new Map<string, any>()
  for (const rule of learnedRules) {
    const existing = learnedMap.get(rule.rawDescription)
    if (!existing || (rule.supplierName !== '' && existing.supplierName === '')) {
      learnedMap.set(rule.rawDescription, rule)
    }
  }

  // Pre-normalize all inventory item names once — avoids re-computing per OCR item
  const normalizedItems = inventoryItems.map(item => ({
    ...item,
    _normName: normalize(item.itemName),
    _keyName:  keyWords(item.itemName),
  })) as unknown as InventoryItem[]

  return ocrItems.map((ocrItem) => {
    // ── 1. Check learned rules first ───────────────────────────────────────
    const learned = learnedMap.get(ocrItem.description)
    if (learned?.inventoryItem) {
      const hasLearnedFormat = !!(learned.invoicePackQty && learned.invoicePackSize)
      const learnedFormat = hasLearnedFormat ? {
        packQty: Number(learned.invoicePackQty),
        packSize: Number(learned.invoicePackSize),
        packUOM: learned.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)

      return buildMatchResult(
        ocrItem,
        learned.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        learnedFormat,
        hasLearnedFormat
      )
    }

    // ── 2. Fuzzy score every inventory item (using pre-normalized names) ───
    const descNorm = normalize(ocrItem.description)
    const descKey  = keyWords(ocrItem.description)
    let bestScore = 0
    let bestItem: InventoryItem | null = null

    for (const item of normalizedItems) {
      const score = scoreMatch(ocrItem.description, item, descNorm, descKey)
      if (score > bestScore) {
        bestScore = score
        bestItem = item
      }
    }

    const confidence = confidenceFromScore(bestScore)

    if (!bestItem || confidence === 'NONE') {
      return {
        ...ocrItem,
        matchedItemId: null,
        matchConfidence: 'NONE' as MatchConfidence,
        matchScore: bestScore,
        action: 'CREATE_NEW' as LineItemAction,
        previousPrice: null,
        newPrice: ocrItem.unitPrice,
        priceDiffPct: null,
        formatMismatch: false,
        invoicePackQty:  ocrItem.packQty  ?? null,
        invoicePackSize: ocrItem.packSize ?? null,
        invoicePackUOM:  ocrItem.packUOM  ?? null,
        needsFormatConfirm: false,
        totalQty:    ocrItem.totalQty ?? null,
        totalQtyUOM: ocrItem.packUOM  ?? null,
      }
    }

    const ocrHasPack = !!(ocrItem.packQty || ocrItem.packSize)
    const ocrFormat = ocrHasPack ? {
      packQty:  ocrItem.packQty  ?? 1,
      packSize: ocrItem.packSize ?? 1,
      packUOM:  ocrItem.packUOM  ?? 'each',
    } : null
    const format = ocrFormat ?? parseFormatFromDescription(ocrItem.description)
    return buildMatchResult(ocrItem, bestItem, confidence, bestScore, format, ocrHasPack)
  })
}

// Save a learned match rule. Call this when a user confirms (or overrides) a match.
export async function saveMatchRule(
  rawDescription: string,
  inventoryItemId: string,
  supplierName?: string | null,
  format?: { packQty: number; packSize: number; packUOM: string } | null
): Promise<void> {
  await prisma.invoiceMatchRule.upsert({
    where: {
      rawDescription_supplierName: {
        rawDescription,
        supplierName: supplierName || '',
      },
    },
    create: {
      rawDescription,
      supplierName: supplierName || '',
      inventoryItemId,
      invoicePackQty: format?.packQty ?? null,
      invoicePackSize: format?.packSize ?? null,
      invoicePackUOM: format?.packUOM ?? null,
    },
    update: {
      inventoryItemId,
      useCount: { increment: 1 },
      lastUsed: new Date(),
      ...(format ? { invoicePackQty: format.packQty, invoicePackSize: format.packSize, invoicePackUOM: format.packUOM } : {}),
    },
  })
}
