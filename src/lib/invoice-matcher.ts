import { prisma } from '@/lib/prisma'
import type { OcrLineItem } from '@/lib/invoice-ocr'
import { parseFormatFromDescription, comparePricesNormalized } from '@/lib/invoice-format'
import { PRICING_SELECT } from '@/lib/item-model'

// Normalises common OCR abbreviations to the canonical purchaseUnit strings used in inventory
const UOM_ALIASES: Record<string, string> = {
  cs:      'case',
  cases:   'case',
  cse:     'case',
  ctn:     'case',
  carton:  'case',
  bx:      'case',
  box:     'case',
  boxes:   'case',
  ea:      'each',
  pc:      'each',
  pcs:     'each',
  piece:   'each',
  pieces:  'each',
  ct:      'each',
  bt:      'each',
  bottle:  'each',
  btl:     'each',
  btls:    'each',
  pk:      'pack',
  pkg:     'pack',
  packs:   'pack',
  bg:      'bag',
  bag:     'bag',
  bags:    'bag',
}

function normalizeUOM(uom: string): string {
  const lower = uom.trim().toLowerCase()
  return UOM_ALIASES[lower] ?? lower
}

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
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  totalQty: number | null
  totalQtyUOM: string | null
}

interface InventoryItem {
  id: string
  itemName: string
  pricePerBaseUnit: number
  purchasePrice: number
  // Chain pricing facts (PRICING_SELECT). The item's stored pack FORMAT is
  // derived from the chain, never from legacy pack columns.
  dimension: string
  baseUnit: string
  packChain: unknown
  pricing: unknown
  countUnit?: string | null
  // Pre-computed at load time for efficiency
  _normName?: string[]
  _keyName?: string[]
}

/**
 * Derive the item's stored pack FORMAT from its chain (replaces the dropped
 * qtyPerPurchaseUnit/packSize/packUOM columns):
 *   packQty  = top container's inner count = packChain[0].per (1 for a single link)
 *   packSize = base content of the leaf (innermost) pack = leaf.per
 *   packUOM  = the item's base unit
 */
function chainPackFormat(item: InventoryItem): {
  packQty: number; packSize: number; packUOM: string
} {
  const chain = Array.isArray(item.packChain) ? (item.packChain as { unit: string; per: number }[]) : []
  if (chain.length === 0) return { packQty: 1, packSize: 1, packUOM: item.baseUnit }
  const leaf = chain[chain.length - 1]
  const packQty = chain.length >= 2 ? Number(chain[0].per) : 1
  const packSize = Number(leaf.per)
  return { packQty, packSize, packUOM: item.baseUnit }
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  offer?: any | null   // InventorySupplierPrice row for (bestItem, session supplier)
): OcrLineItem & MatchResult {
  // "was" price = what THIS supplier charged last time, when known. Falls back
  // to the item's purchase price (single-supplier behaviour) otherwise.
  const offerLastPrice = offer?.lastPrice != null ? Number(offer.lastPrice) : null
  const previousPrice = offerLastPrice ?? Number(bestItem.purchasePrice)
  // For per_weight items, the rate ($/kg) is the meaningful price to carry forward —
  // rawUnitPrice is the line total per container (e.g. $292/case) which changes each
  // shipment based on catch-weight and should never overwrite purchasePrice.
  const isPerWeight = ocrItem.pricingMode === 'per_weight' && ocrItem.rate != null
  const effectiveUnitPrice = isPerWeight
    ? Number(ocrItem.rate)
    : ocrItem.unitPrice
  const rawUnitPrice = effectiveUnitPrice

  let newPrice: number | null = rawUnitPrice ?? null
  let priceDiffPct: number | null = null
  let invoicePackQty: number | null = null
  let invoicePackSize: number | null = null
  let invoicePackUOM: string | null = null

  if (format) {
    // Always store the parsed format for display
    invoicePackQty = format.packQty
    invoicePackSize = format.packSize
    invoicePackUOM = format.packUOM

    // ── Normalised per-base price comparison ──────────────────────────────────
    // This depends only on the parsed pack format, NOT on whether the user has
    // confirmed it — so always compute the delta this way. (Previously the
    // unconfirmed path did a raw $/cs-vs-$/L direct comparison, which read as a
    // huge bogus jump even when the real per-base price was unchanged.)
    // Confirmation still gates whether we WRITE a normalised newPrice back.
    const total = format.packQty * format.packSize
    let normalisedOk = false
    if (total > 0 && rawUnitPrice !== null) {
      // per_weight: the rate ($/kg) is ALREADY a per-packUOM price and is
      // independent of pack size. Dividing it by the pack total (as per_case
      // prices require) double-divides it — corrupting both the delta and the
      // carried newPrice by the pack-weight factor. So treat the rate as the
      // per-packUOM price directly, and compare it against the item's stored
      // per-UOM purchase price (which, for a UOM-priced item, IS the rate).
      const invoicePricePerPackUOM = isPerWeight ? rawUnitPrice : rawUnitPrice / total  // e.g. $2.756/L
      const invoiceUnit = isPerWeight ? (ocrItem.rateUOM ?? format.packUOM) : format.packUOM
      // Inventory side of the comparison: prefer the supplier's own offer
      // (their price over their pack format); fall back to the item fields.
      // Recomputed from raw fields so we never rely on the stored
      // pricePerBaseUnit (which can be stale / mis-scaled).
      const offerHasFormat = !!(offer && offer.packQty != null && offer.packSize != null && offer.packUOM)
      const itemFmt       = chainPackFormat(bestItem)
      const invSidePrice  = offerLastPrice ?? Number(bestItem.purchasePrice)
      const invSideQty    = offerHasFormat ? Number(offer.packQty)  : itemFmt.packQty
      const invSideSize   = offerHasFormat ? Number(offer.packSize) : itemFmt.packSize
      const invSideUOM    = offerHasFormat ? (offer.packUOM as string) : itemFmt.packUOM
      const invPackTotal = invSideQty * invSideSize
      const invPricePerPackUOM = isPerWeight
        ? invSidePrice
        : (invPackTotal > 0 ? invSidePrice / invPackTotal : 0)
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, invoiceUnit,       // invoice: $/packUOM
        invPricePerPackUOM,     invSideUOM         // inventory: $/packUOM (recomputed)
      )
      if (normalized) {
        priceDiffPct = normalized.pctDiff
        normalisedOk = true
        // newPrice stays = rawUnitPrice (the supplier's actual case price / rate
        // as printed). It was previously reconstructed via calcNewPurchasePrice,
        // round-tripping the price through the INVOICE's parsed format then the
        // INVENTORY's format — when those disagreed (OCR mis-read the pack, or
        // the user corrected the format in review without it recomputing) the
        // price inflated by the format ratio (e.g. $34.32 → $1716). The approve
        // route's spine derives pricePerBaseUnit from rawUnitPrice over the
        // RESOLVED format, and the approve route's consent check (useInvoicePack /
        // invoiceFormatDiffers) gates writes — so the round-trip is both redundant and the bug source.
      }
    }

    if (!normalisedOk) {
      // Truly incompatible units (e.g. kg vs mL) — fall back to direct comparison.
      if (previousPrice > 0 && rawUnitPrice !== null) {
        priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
      }
    }
  } else {
    // No format info — direct purchase price comparison
    if (previousPrice > 0 && rawUnitPrice !== null) {
      priceDiffPct = Math.round(((rawUnitPrice - previousPrice) / previousPrice) * 10000) / 100
    }
    newPrice = rawUnitPrice ?? null
  }

  let action: LineItemAction = 'PENDING'
  if (confidence === 'HIGH' || confidence === 'MEDIUM') {
    action = (priceDiffPct !== null && Math.abs(priceDiffPct) > 0.1) ? 'UPDATE_PRICE' : 'ADD_SUPPLIER'
  }

  return {
    ...ocrItem,
    matchedItemId: bestItem.id,
    matchConfidence: confidence,
    matchScore: bestScore,
    action,
    previousPrice,
    newPrice,
    priceDiffPct: priceDiffPct ?? null,
    invoicePackQty,
    invoicePackSize,
    invoicePackUOM,
    totalQty:    ocrItem.totalQty    ?? null,
    totalQtyUOM: ocrItem.totalQtyUOM ?? ocrItem.packUOM ?? null,
  }
}

export async function matchLineItems(
  ocrItems: OcrLineItem[],
  supplierName?: string | null,
  canonicalName?: string | null
): Promise<(OcrLineItem & MatchResult)[]> {
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      // Exclude PREP recipe outputs — they're made in-house, not purchasable,
      // so an invoice line must never fuzzy-match to one (e.g. "Adobo Pulled Pork").
      NOT: { recipe: { type: 'PREP' } },
    },
    select: {
      id: true,
      itemName: true,
      ...PRICING_SELECT,
      purchasePrice: true,
    },
  })

  // Supplier names a learned rule could be stored under: the raw OCR name, the
  // canonical Supplier name, and the generic '' (supplier-agnostic). Matching by
  // ALL of them is what makes a rule taught on "Sysco Canada, Inc." apply to an
  // invoice that arrives as "SYSCO Canada, Inc." or "… - Vancouver" — the
  // name-variant fix, now applied to match rules (was previously only offers).
  const ruleSupplierNames = Array.from(new Set([supplierName ?? '', canonicalName ?? '', '']))
  const codeSupplierNames = Array.from(new Set([supplierName, canonicalName].filter((n): n is string => !!n)))

  // Load learned rules — gracefully fall back to empty if the table doesn't exist yet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let learnedRules: any[] = []
  try {
    learnedRules = await prisma.invoiceMatchRule.findMany({
      where: {
        rawDescription: { in: ocrItems.map(i => i.description) },
        supplierName: { in: ruleSupplierNames },
      },
      include: {
        inventoryItem: {
          select: {
            id: true,
            itemName: true,
            ...PRICING_SELECT,
            purchasePrice: true,
          },
        },
      },
      orderBy: { useCount: 'desc' },
    })
  } catch {
    // Table may not exist yet — proceed with fuzzy matching only
  }

  // ── Item-code rules: deterministic (supplier, supplierItemCode) → item ────
  // An item code printed on the invoice is supplier-scoped and unambiguous —
  // it beats any text matching. Learned at approval time (saveMatchRule).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let codeRules: any[] = []
  const itemCodes = ocrItems
    .map(i => i.supplierItemCode)
    .filter((c): c is string => !!c)
  if (codeSupplierNames.length > 0 && itemCodes.length > 0) {
    try {
      codeRules = await prisma.invoiceMatchRule.findMany({
        where: {
          supplierName: { in: codeSupplierNames },
          supplierItemCode: { in: itemCodes },
        },
        include: {
          inventoryItem: {
            select: {
              id: true,
              itemName: true,
              ...PRICING_SELECT,
              purchasePrice: true,
            },
          },
        },
        orderBy: [{ useCount: 'desc' }, { lastUsed: 'desc' }],
      })
    } catch {
      // Column may not exist yet on stale clients — fall through to text matching
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const codeRuleMap = new Map<string, any>()
  for (const rule of codeRules) {
    if (rule.supplierItemCode && !codeRuleMap.has(rule.supplierItemCode)) {
      codeRuleMap.set(rule.supplierItemCode, rule) // first = highest useCount
    }
  }

  // ── This supplier's offers: per-supplier last price + pack format ─────────
  // Comparing a line against the supplier's OWN offer (not the item's single
  // price/format fields) is what stops supplier alternation from reading as
  // price changes and format mismatches on every invoice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let offerRows: any[] = []
  if (supplierName) {
    try {
      offerRows = await prisma.inventorySupplierPrice.findMany({
        // Offers are written under the CANONICAL supplier name (Supplier.name)
        // since the name-variant fix; also query the raw OCR name so legacy
        // rows keyed by a variant still match.
        where: { supplierName: { in: canonicalName && canonicalName !== supplierName ? [supplierName, canonicalName] : [supplierName] } },
      })
    } catch {
      // table/columns missing on a stale client — fall back to item comparison
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerByItemId = new Map<string, any>()
  // Insert raw-name rows first so canonical-name rows overwrite them when
  // both exist for the same item — the canonical offer wins.
  for (const o of offerRows.filter(o => o.supplierName !== canonicalName)) offerByItemId.set(o.inventoryItemId, o)
  if (canonicalName) {
    for (const o of offerRows.filter(o => o.supplierName === canonicalName)) offerByItemId.set(o.inventoryItemId, o)
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
    // ── 0. Supplier item-code rule (deterministic — beats all text matching) ─
    const codeRule = ocrItem.supplierItemCode
      ? codeRuleMap.get(ocrItem.supplierItemCode)
      : undefined
    if (codeRule?.inventoryItem) {
      const hasRuleFormat = !!(codeRule.invoicePackQty && codeRule.invoicePackSize)
      const ruleFormat = hasRuleFormat ? {
        packQty:  Number(codeRule.invoicePackQty),
        packSize: Number(codeRule.invoicePackSize),
        packUOM:  codeRule.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)
      return buildMatchResult(
        ocrItem,
        codeRule.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        ruleFormat,
        offerByItemId.get(codeRule.inventoryItem.id) ?? null
      )
    }

    // ── 1. Check learned rules first ───────────────────────────────────────
    const learned = learnedMap.get(ocrItem.description)
    if (learned?.inventoryItem) {
      const hasLearnedFormat = !!(learned.invoicePackQty && learned.invoicePackSize)
      const learnedFormat = hasLearnedFormat ? {
        packQty: Number(learned.invoicePackQty),
        packSize: Number(learned.invoicePackSize),
        packUOM: learned.invoicePackUOM ?? 'each',
      } : parseFormatFromDescription(ocrItem.description)

      // A rule learned under THIS supplier is authoritative. A generic rule
      // (saved when the supplier was unknown, supplierName '') applied to a
      // session with a known supplier is only a hint — surface it as MEDIUM so
      // the review UI can ask the user to confirm it instead of trusting it outright.
      // A rule stored under the raw OR canonical supplier name is supplier-specific
      // (HIGH). Only a generic '' rule on a known supplier is a mere hint (MEDIUM).
      const supplierSpecific = !supplierName
        || learned.supplierName === supplierName
        || (!!canonicalName && learned.supplierName === canonicalName)
      return buildMatchResult(
        ocrItem,
        learned.inventoryItem as unknown as InventoryItem,
        supplierSpecific ? 'HIGH' : 'MEDIUM',
        supplierSpecific ? 100 : 60,
        learnedFormat,
        offerByItemId.get(learned.inventoryItem.id) ?? null
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
      // No match → PENDING, never CREATE_NEW. CREATE_NEW means "the user
      // configured a new item" (the drawer's AddNewItemModal sets it together
      // with newItemData); auto-setting it here made unmatched lines look
      // resolved and let approve create items with default category/format.
      // PENDING keeps the line in the unlinked state, which gates approval.
      return {
        ...ocrItem,
        matchedItemId: null,
        matchConfidence: 'NONE' as MatchConfidence,
        matchScore: bestScore,
        action: 'PENDING' as LineItemAction,
        previousPrice: null,
        newPrice: ocrItem.unitPrice,
        priceDiffPct: null,
        invoicePackQty:  ocrItem.packQty  ?? null,
        invoicePackSize: ocrItem.packSize ?? null,
        invoicePackUOM:  ocrItem.packUOM  ?? null,
        totalQty:    ocrItem.totalQty    ?? null,
        totalQtyUOM: ocrItem.totalQtyUOM ?? ocrItem.packUOM ?? null,
      }
    }

    const ocrHasPack = !!(ocrItem.packQty || ocrItem.packSize)
    const ocrFormat = ocrHasPack ? {
      packQty:  ocrItem.packQty  ?? 1,
      packSize: ocrItem.packSize ?? 1,
      packUOM:  ocrItem.packUOM  ?? 'each',
    } : null
    const format = ocrFormat ?? parseFormatFromDescription(ocrItem.description)
    return buildMatchResult(ocrItem, bestItem, confidence, bestScore, format, offerByItemId.get(bestItem.id) ?? null)
  })
}

// Save a learned match rule. Call this when a user confirms (or overrides) a match.
export async function saveMatchRule(
  rawDescription: string,
  inventoryItemId: string,
  supplierName?: string | null,
  format?: { packQty: number; packSize: number; packUOM: string } | null,
  supplierItemCode?: string | null
): Promise<void> {
  const code = supplierItemCode?.trim() || null

  // A code maps to exactly one item per supplier. If sibling rules (different
  // descriptions) carry this code but point at a different item, the user's
  // fresh confirmation wins — strip the code from the stale rules so tier-0
  // can't keep resurrecting the old mapping.
  if (code && supplierName) {
    await prisma.invoiceMatchRule.updateMany({
      where: {
        supplierName,
        supplierItemCode: code,
        inventoryItemId: { not: inventoryItemId },
      },
      data: { supplierItemCode: null },
    })
  }

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
      supplierItemCode: code,
      invoicePackQty: format?.packQty ?? null,
      invoicePackSize: format?.packSize ?? null,
      invoicePackUOM: format?.packUOM ?? null,
    },
    update: {
      inventoryItemId,
      useCount: { increment: 1 },
      lastUsed: new Date(),
      ...(code ? { supplierItemCode: code } : {}),
      ...(format ? { invoicePackQty: format.packQty, invoicePackSize: format.packSize, invoicePackUOM: format.packUOM } : {}),
    },
  })
}
