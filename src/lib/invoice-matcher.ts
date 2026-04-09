import { prisma } from '@/lib/prisma'
import type { OcrLineItem } from '@/lib/invoice-ocr'

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
}

interface InventoryItem {
  id: string
  itemName: string
  abbreviation: string | null
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
  baseUnit: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

// Normalize a string for comparison: lowercase, remove punctuation, split into words
function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
}

// Count overlapping words between two word arrays
function wordOverlap(a: string[], b: string[]): number {
  const setB = new Set(b)
  return a.filter(w => setB.has(w)).length
}

// Compute a match score (0–100) between an invoice description and an inventory item
function scoreMatch(description: string, item: InventoryItem): number {
  const descWords = normalize(description)
  const nameWords = normalize(item.itemName)

  // Exact match
  if (description.toLowerCase().trim() === item.itemName.toLowerCase().trim()) return 100

  // Abbreviation match
  if (item.abbreviation) {
    const abbrev = item.abbreviation.toLowerCase().trim()
    if (description.toLowerCase().trim() === abbrev) return 95
    if (description.toLowerCase().includes(abbrev)) return 80
  }

  // Word overlap score
  const totalWords = Math.max(descWords.length, nameWords.length, 1)
  const overlap = wordOverlap(descWords, nameWords)
  const overlapScore = (overlap / totalWords) * 100

  // Bonus: if item name is fully contained within description
  const itemInDesc = nameWords.every(w => descWords.includes(w))
  const descInItem = descWords.every(w => nameWords.includes(w))

  let score = overlapScore
  if (itemInDesc || descInItem) score = Math.max(score, 70)

  // Partial prefix bonus: if first word of item name matches first word of description
  if (nameWords[0] && descWords[0] && nameWords[0] === descWords[0]) score += 10

  return Math.min(Math.round(score), 99) // never 100 unless exact
}

function confidenceFromScore(score: number): MatchConfidence {
  if (score >= 70) return 'HIGH'
  if (score >= 40) return 'MEDIUM'
  if (score >= 20) return 'LOW'
  return 'NONE'
}

// Compute derived price per base unit from invoice line item
function computeNewPricePerBase(
  item: InventoryItem,
  rawUnitPrice: number | null
): number | null {
  if (!rawUnitPrice) return null
  // purchasePrice is the price per purchase unit
  // pricePerBaseUnit = purchasePrice / (qtyPerPurchaseUnit * packSize)
  const unitsPerPurchase = Number(item.qtyPerPurchaseUnit) * Number(item.packSize)
  if (unitsPerPurchase <= 0) return rawUnitPrice
  return rawUnitPrice / unitsPerPurchase
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
      abbreviation: true,
      purchaseUnit: true,
      pricePerBaseUnit: true,
      purchasePrice: true,
      baseUnit: true,
      qtyPerPurchaseUnit: true,
      packSize: true,
      packUOM: true,
    },
  })

  return ocrItems.map((ocrItem, idx) => {
    // Score every inventory item
    let bestScore = 0
    let bestItem: InventoryItem | null = null

    for (const item of inventoryItems) {
      const score = scoreMatch(ocrItem.description, item as InventoryItem)
      if (score > bestScore) {
        bestScore = score
        bestItem = item as InventoryItem
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
      }
    }

    const previousPrice = Number(bestItem.purchasePrice)
    const newPrice = ocrItem.unitPrice

    // Calculate price diff
    let priceDiffPct: number | null = null
    if (previousPrice > 0 && newPrice !== null) {
      priceDiffPct = Math.round(((newPrice - previousPrice) / previousPrice) * 10000) / 100
    }

    // Determine action
    let action: LineItemAction = 'PENDING'
    if (confidence === 'HIGH' || confidence === 'MEDIUM') {
      if (newPrice !== null && newPrice !== previousPrice) {
        action = 'UPDATE_PRICE'
      } else {
        // Check if this supplier is tracked
        action = 'ADD_SUPPLIER'
      }
    }

    // Format mismatch: if OCR unit doesn't match purchaseUnit
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
      newPrice: newPrice ?? null,
      priceDiffPct: priceDiffPct ?? null,
      formatMismatch,
    }
  })
}
