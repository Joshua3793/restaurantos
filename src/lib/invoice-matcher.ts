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

/** A match won ONLY through another wording (never the item's own name) is a hint,
 *  not a fact — same downgrade a generic learned rule gets. A HIGH score is capped
 *  to MEDIUM so a human confirms it; approval then saves a rule under this supplier
 *  and the next invoice reads it back as HIGH via tier 1. Every other confidence is
 *  untouched. */
export function capAliasConfidence(raw: MatchConfidence, viaAlias: boolean): MatchConfidence {
  return viaAlias && raw === 'HIGH' ? 'MEDIUM' : raw
}

interface FuzzyCandidate {
  id: string
  score: number
  viaAlias: boolean
}

/** Total order for the fuzzy tier's winner: higher score wins; on an EQUAL score
 *  an own-name match beats a match won only through an alias — otherwise a line
 *  that literally names item B could lose to a strong alias on an unrelated item
 *  A, decided only by which item the loop happened to visit first. Remaining ties
 *  break on id ascending so the result never depends on iteration order at all. */
function isBetterFuzzy(a: FuzzyCandidate, b: FuzzyCandidate): boolean {
  if (a.score !== b.score) return a.score > b.score
  if (a.viaAlias !== b.viaAlias) return !a.viaAlias
  return a.id < b.id
}

/** Picks the winning candidate under isBetterFuzzy's total order. Exported so the
 *  ordering itself is unit-tested independently of scoreMatch/normalize — a caller
 *  can feed it plain {id, score, viaAlias} candidates. matchLineItems' hot loop
 *  folds over the inventory with this (a running best, [current, next] each
 *  step) rather than collecting every item into one array per OCR line — same
 *  total order either way, without an O(items) allocation per line. */
export function pickBestFuzzy<T extends FuzzyCandidate>(candidates: T[]): T | null {
  let best: T | null = null
  for (const c of candidates) {
    if (!best || isBetterFuzzy(c, best)) best = c
  }
  return best
}

export const MAX_ALIASES_PER_ITEM = 5

/** Groups learned-rule rows into per-item alias lists for the fuzzy tier: capped
 *  at `max` (the caller orders rows by usefulness — useCount desc, lastUsed desc —
 *  so a cap keeps the strongest ones), de-duplicated case-insensitively (via the
 *  same `normalize` tokenization used for scoring), and skipping any alias whose
 *  normalized form is identical to the item's own name — that case is already
 *  covered by the item's own-name score and would only ever tie it, never beat it.
 *  Preserves the input row order; it does not sort. */
export function groupAliases(
  rows: { inventoryItemId: string; rawDescription: string }[],
  itemNameById: Map<string, string>,
  max: number = MAX_ALIASES_PER_ITEM
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const seenByItem = new Map<string, Set<string>>()
  for (const r of rows) {
    const normKey = normalize(r.rawDescription).join(' ')
    if (!normKey) continue
    const ownName = itemNameById.get(r.inventoryItemId)
    if (ownName && normKey === normalize(ownName).join(' ')) continue
    const seen = seenByItem.get(r.inventoryItemId) ?? new Set<string>()
    if (seen.has(normKey)) continue
    const list = result.get(r.inventoryItemId) ?? []
    if (list.length >= max) continue
    seen.add(normKey)
    seenByItem.set(r.inventoryItemId, seen)
    list.push(r.rawDescription)
    result.set(r.inventoryItemId, list)
  }
  return result
}

/** (supplier, SKU) → item, from this session's own supplier-offer rows (already
 *  scoped to the raw + canonical supplier names — see offerRows). Per item, a
 *  canonical-name row's code overrides a raw-name row's code for the SAME item
 *  (mirrors offerByItemId's precedence). But `InventorySupplierPrice` has only a
 *  non-unique index on (supplierName, supplierItemCode): a stale code can survive
 *  on an old item's offer after a line gets re-matched elsewhere, so after that
 *  per-item resolution a code MAY still name more than one distinct item. That is
 *  ambiguous — there is no signal here for which one is current — so the code is
 *  omitted from the index entirely rather than guessed; the line falls through to
 *  tier 1/2 where a human confirms it. */
export function buildOfferSkuIndex(
  offerRows: { supplierName: string; supplierItemCode: string | null; inventoryItemId: string }[],
  canonicalName?: string | null
): Map<string, string> {
  const skuByItem = new Map<string, string>()
  for (const o of offerRows) {
    if (o.supplierName === canonicalName) continue
    if (o.supplierItemCode) skuByItem.set(o.inventoryItemId, o.supplierItemCode)
  }
  if (canonicalName) {
    for (const o of offerRows) {
      if (o.supplierName !== canonicalName) continue
      if (o.supplierItemCode) skuByItem.set(o.inventoryItemId, o.supplierItemCode)
    }
  }

  const itemsBySku = new Map<string, Set<string>>()
  for (const [itemId, sku] of skuByItem) {
    const set = itemsBySku.get(sku) ?? new Set<string>()
    set.add(itemId)
    itemsBySku.set(sku, set)
  }

  const index = new Map<string, string>()
  for (const [sku, itemIds] of itemsBySku) {
    if (itemIds.size === 1) index.set(sku, [...itemIds][0])
    // more than one distinct item claims this SKU after resolution → ambiguous, omit
  }
  return index
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

  // ── Aliases: descriptions this item has been taught under ANY supplier ────
  // Merging duplicate items carries their match rules along, so an item can
  // now be known by several suppliers' own wordings. The fuzzy tier scores a
  // line against all of them, not just the item's own name — but only as a
  // hint (capAliasConfidence downgrades a HIGH win to MEDIUM for a human to
  // confirm). Scoped to items actually in play (this query's own inventoryItems)
  // and ordered by usefulness so groupAliases's cap keeps the strongest ones —
  // otherwise this read grows with the whole InvoiceMatchRule table forever.
  // Grouped + pre-normalized once, so the per-item/per-line hot loop below never
  // re-tokenizes a string.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let aliasRows: any[] = []
  try {
    aliasRows = await prisma.invoiceMatchRule.findMany({
      where: { inventoryItemId: { in: inventoryItems.map(i => i.id) } },
      select: { inventoryItemId: true, rawDescription: true },
      orderBy: [{ useCount: 'desc' }, { lastUsed: 'desc' }],
    })
  } catch {
    // Table may not exist yet — proceed without aliases
  }
  const itemNameById = new Map(inventoryItems.map(i => [i.id, i.itemName]))
  const groupedAliases = groupAliases(aliasRows, itemNameById)
  const aliasesByItem = new Map<string, InventoryItem[]>()
  for (const [itemId, aliases] of groupedAliases) {
    aliasesByItem.set(itemId, aliases.map(a => ({
      itemName: a,
      _normName: normalize(a),
      _keyName: keyWords(a),
    } as unknown as InventoryItem)))
  }

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
  // Raw-name vs canonical-name partition, computed once and shared by both maps
  // below — a canonical-name row always takes precedence over a raw-name row for
  // the same item (offerByItemId) / SKU (offerBySku via buildOfferSkuIndex).
  const rawOfferRows = offerRows.filter(o => o.supplierName !== canonicalName)
  const canonicalOfferRows = canonicalName ? offerRows.filter(o => o.supplierName === canonicalName) : []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerByItemId = new Map<string, any>()
  // Insert raw-name rows first so canonical-name rows overwrite them when
  // both exist for the same item — the canonical offer wins.
  for (const o of rawOfferRows) offerByItemId.set(o.inventoryItemId, o)
  for (const o of canonicalOfferRows) offerByItemId.set(o.inventoryItemId, o)

  // Offer SKUs are the supplier library itself: (supplier, SKU) → item, even
  // when no match rule was ever saved (e.g. an offer that arrived through a
  // merge). offerRows is already filtered to this supplier's names (raw +
  // canonical) so a SKU only ever resolves within the same supplier; ambiguous
  // SKUs (claimed by more than one distinct item after raw/canonical
  // precedence) are omitted by buildOfferSkuIndex, never guessed.
  const offerBySku = buildOfferSkuIndex(offerRows, canonicalName)
  // Built from inventoryItems (already excludes inactive/tombstoned rows and
  // PREP outputs) so an offer SKU can never resolve to one of those.
  const itemById = new Map(inventoryItems.map(i => [i.id, i]))

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

    // ── 0b. Supplier offer SKU (deterministic, no rule ever saved) ─────────
    const skuItem = ocrItem.supplierItemCode
      ? itemById.get(offerBySku.get(ocrItem.supplierItemCode) ?? '')
      : undefined
    if (skuItem) {
      const ocrPack = (ocrItem.packQty || ocrItem.packSize)
        ? { packQty: ocrItem.packQty ?? 1, packSize: ocrItem.packSize ?? 1, packUOM: ocrItem.packUOM ?? 'each' }
        : parseFormatFromDescription(ocrItem.description)
      return buildMatchResult(ocrItem, skuItem as unknown as InventoryItem, 'HIGH', 100, ocrPack, offerByItemId.get(skuItem.id) ?? null)
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
    // Running best under pickBestFuzzy's total order (higher score; on a tie,
    // an own-name match beats an alias match; remaining ties break on id) — so
    // the winner never depends on the order normalizedItems happens to be in,
    // and a line naming item B outright can't lose to a strong alias on a
    // different item A just because A was visited first.
    let best: FuzzyCandidate | null = null
    let bestItem: InventoryItem | null = null

    for (const item of normalizedItems) {
      let score = scoreMatch(ocrItem.description, item, descNorm, descKey)
      let viaAlias = false
      for (const alias of aliasesByItem.get(item.id) ?? []) {
        const s = scoreMatch(ocrItem.description, alias, descNorm, descKey)
        if (s > score) { score = s; viaAlias = true }
      }
      const candidate: FuzzyCandidate = { id: item.id, score, viaAlias }
      const pool: FuzzyCandidate[] = best ? [best, candidate] : [candidate]
      const winner: FuzzyCandidate | null = pickBestFuzzy(pool)
      if (winner === candidate) bestItem = item
      best = winner
    }

    const bestScore = best?.score ?? 0
    const bestViaAlias = best?.viaAlias ?? false

    // A match won through ANOTHER wording is a hint, not a fact — same downgrade
    // a generic learned rule gets. A human confirms it; approval then saves a
    // rule under this supplier and the next invoice is HIGH via tier 1.
    const confidence = capAliasConfidence(confidenceFromScore(bestScore), bestViaAlias)

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
