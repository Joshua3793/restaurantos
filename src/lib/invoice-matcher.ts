import { prisma } from '@/lib/prisma'
import type { OcrLineItem } from '@/lib/invoice-ocr'
import { parseFormatFromDescription, comparePricesNormalized } from '@/lib/invoice-format'
import { PRICING_SELECT } from '@/lib/item-model'
import { listedPrice, type ChainRow } from '@/lib/cost-basis'
import { offerListedPrice } from '@/lib/offer-price'
import { ALIAS_SELECT, aliasState, type UndoCollector } from '@/lib/invoice/approve-undo'
import { normaliseAliasText } from '@/lib/alias-text'
import { normItemCode } from '@/lib/invoice/line-format'

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
function chainPackFormat(item: { packChain: unknown; baseUnit: string }): PackFormat {
  const chain = Array.isArray(item.packChain) ? (item.packChain as { unit: string; per: number }[]) : []
  if (chain.length === 0) return { packQty: 1, packSize: 1, packUOM: item.baseUnit }
  const leaf = chain[chain.length - 1]
  // Every level above the leaf multiplies into the pack count — a three-level
  // pack `[case 4, pack 6, each 1]` is 24 of the leaf, not 4.
  const packQty = chain.slice(0, -1).reduce((acc, l) => acc * Number(l.per || 0), 1)
  const packSize = Number(leaf.per)
  return { packQty, packSize, packUOM: item.baseUnit }
}

/**
 * The "was" price (`previousPriceFor`) expressed per ONE unit, in the unit it
 * is actually quoted in — so the price comparison never pairs a $/kg rate with
 * a pack total or a gram label:
 *   - a RATE price ($8 per kg) is already per unit → { 8, 'kg' }
 *   - a PACK price ($40 per case of 4 × 2500 g) → { 40 / 10000, 'g' } over the
 *     pack that price belongs to (`inventorySideFormat`)
 * The pricing read is the same one `previousPriceFor` picks: the box's when it
 * has a listed price, else the item's.
 */
export function inventorySidePrice(
  offer: { pricing?: unknown; packChain?: unknown; packQty?: unknown; packSize?: unknown; packUOM?: unknown } | null | undefined,
  item: ChainRow & { packChain: unknown; baseUnit: string },
): { pricePerUnit: number; unit: string } {
  const price = previousPriceFor(offer, item)
  const pricing = (offer && offerListedPrice(offer) > 0 ? offer.pricing : item.pricing) as
    { mode?: string; rateUnit?: string } | null | undefined
  if (pricing?.mode === 'RATE' && pricing.rateUnit) return { pricePerUnit: price, unit: pricing.rateUnit }
  const fmt = inventorySideFormat(offer, item)
  const total = fmt.packQty * fmt.packSize
  return { pricePerUnit: total > 0 ? price / total : 0, unit: fmt.packUOM }
}

type PackFormat = { packQty: number; packSize: number; packUOM: string }

/**
 * The pack the inventory side of the price comparison divides its "was" price
 * by — always the pack THAT price belongs to (see `previousPriceFor`):
 *   - the supplier's box has a price → the box's OWN chain (read like the item's,
 *     in the item's base unit); a box with no chain falls back to its legacy
 *     pack fields; a box with neither, to the item's chain;
 *   - no box, or a box with no price → the "was" price is the item's own, so the
 *     item's chain.
 * Never the box's legacy packQty/packSize/packUOM while it has a chain: a box
 * added or re-packed in the drawer has none, or stale ones, and pairing its
 * price with another pack is what reads as a false big price change.
 */
export function inventorySideFormat(
  offer: { pricing?: unknown; packChain?: unknown; packQty?: unknown; packSize?: unknown; packUOM?: unknown } | null | undefined,
  item: { packChain: unknown; baseUnit: string },
): PackFormat {
  if (offer && offerListedPrice(offer) > 0) {
    if (Array.isArray(offer.packChain) && offer.packChain.length > 0) {
      return chainPackFormat({ packChain: offer.packChain, baseUnit: item.baseUnit })
    }
    if (offer.packQty != null && offer.packSize != null && offer.packUOM) {
      return { packQty: Number(offer.packQty), packSize: Number(offer.packSize), packUOM: String(offer.packUOM) }
    }
  }
  return chainPackFormat(item)
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

/** A fuzzy match won ONLY through one of this supplier's own wordings (never the
 *  item's own name) is a hint, not a fact. A HIGH score is capped to MEDIUM so a
 *  human confirms it; approval then upserts that wording as this supplier's alias
 *  and the next invoice reads it back as HIGH via tier 1. Every other confidence
 *  is untouched. */
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

/** Tier 3 reads at most this many of one supplier's wordings per item, the most
 *  used first — enough to recognise an item, bounded so one noisy item can't
 *  dominate the fuzzy pass. */
const ALIAS_CAP_PER_ITEM = 5

/** Groups one supplier's alias rows into per-item wording lists for the tier-3
 *  fuzzy pass: capped at `max` (the caller orders rows by usefulness — useCount
 *  desc, lastUsed desc — so a cap keeps the strongest ones), de-duplicated by the
 *  same `normalize` tokenization used for scoring, and skipping any wording
 *  whose normalized form is identical to the item's own name — the own-name
 *  score already covers it and would only ever tie it. Preserves input order. */
export function groupAliases(
  rows: { inventoryItemId: string; rawText: string }[],
  itemNameById: Map<string, string>,
  max: number = ALIAS_CAP_PER_ITEM
): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const seenByItem = new Map<string, Set<string>>()
  for (const r of rows) {
    const normKey = normalize(r.rawText).join(' ')
    if (!normKey) continue
    const ownName = itemNameById.get(r.inventoryItemId)
    if (ownName && normKey === normalize(ownName).join(' ')) continue
    const seen = seenByItem.get(r.inventoryItemId) ?? new Set<string>()
    if (seen.has(normKey)) continue
    const list = result.get(r.inventoryItemId) ?? []
    if (list.length >= max) continue
    seen.add(normKey)
    seenByItem.set(r.inventoryItemId, seen)
    list.push(r.rawText)
    result.set(r.inventoryItemId, list)
  }
  return result
}

/** (supplier, SKU) → item, from one supplier's offer rows (already scoped —
 *  loaded by supplierId). A stale code can survive on an old item's offer after a
 *  line gets re-matched elsewhere, so a code MAY still name more than one distinct
 *  item. That is ambiguous — there is no signal here for which one is current — so
 *  the code is omitted from the index entirely rather than guessed; the line falls
 *  through to tier 1/2 where a human confirms it. */
export function buildOfferSkuIndex(
  offerRows: { supplierId: string; supplierItemCode: string | null; inventoryItemId: string }[]
): Map<string, string> {
  // One row per (item, supplier, SKU): a merged item can carry several SKUs, so
  // every row's SKU is indexed — no one-SKU-per-item collapse.
  const itemsBySku = new Map<string, Set<string>>()
  for (const o of offerRows) {
    if (!o.supplierItemCode) continue
    const set = itemsBySku.get(o.supplierItemCode) ?? new Set<string>()
    set.add(o.inventoryItemId)
    itemsBySku.set(o.supplierItemCode, set)
  }

  const index = new Map<string, string>()
  for (const [sku, itemIds] of itemsBySku) {
    if (itemIds.size === 1) index.set(sku, [...itemIds][0])
    // more than one distinct item claims this SKU after resolution → ambiguous, omit
  }
  return index
}

/**
 * The "was" price shown on a matched line: what THIS supplier charged last time
 * (its offer's listed price), else the primary chain's listed price — box price or
 * rate — the number the legacy column held. Derived from `pricing`, never the
 * `purchasePrice` column itself (it drifts).
 */
export function previousPriceFor(offer: { pricing?: unknown } | null | undefined, item: ChainRow): number {
  const offerLast = offer ? offerListedPrice(offer) : 0
  return offerLast > 0 ? offerLast : listedPrice(item)
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
  // "was" price = what THIS supplier charged last time, when known; else the
  // primary chain's listed price (box price or rate — what the legacy column held; see previousPriceFor).
  const previousPrice = previousPriceFor(offer, { ...bestItem, countUnit: bestItem.countUnit ?? undefined })
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
      // Inventory side of the comparison: the "was" price per ONE unit, in the
      // unit it is quoted in — a rate keeps its own unit ($8 per kg stays per
      // kg), a pack price is spread over the pack it belongs to (the supplier's
      // own box chain when the price is the box's, else the item's). Recomputed
      // from raw fields so we never rely on a stored pricePerBaseUnit.
      const invSide = inventorySidePrice(offer, { ...bestItem, countUnit: bestItem.countUnit ?? undefined })
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, invoiceUnit,       // invoice: $/packUOM
        invSide.pricePerUnit,   invSide.unit       // inventory: $/unit (recomputed)
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

/** W4 — the only items any tier may answer with: live, not merged away, and not
 *  a PREP recipe's output (made in-house, never bought). The items query applies
 *  it in SQL; an alias's joined item is checked with this, so an alias whose item
 *  fails it is ignored (never deleted). */
type MatchableFacts = { isActive: boolean; mergedIntoId: string | null; recipe: { type: string } | null }
function isMatchable(item: MatchableFacts | null | undefined): boolean {
  return !!item && item.isActive && item.mergedIntoId == null && item.recipe?.type !== 'PREP'
}

const ITEM_FOR_MATCH = {
  id: true,
  itemName: true,
  isActive: true,
  mergedIntoId: true,
  recipe: { select: { type: true } },
  ...PRICING_SELECT,
} as const

type AliasPack = { packQty: unknown; packSize: unknown; packUOM: string | null }

/** The pack an alias learned, when it learned one; else whatever the line's own
 *  wording says. */
function aliasFormat(a: AliasPack, description: string) {
  return a.packQty && a.packSize
    ? { packQty: Number(a.packQty), packSize: Number(a.packSize), packUOM: a.packUOM ?? 'each' }
    : parseFormatFromDescription(description)
}

/**
 * Match OCR lines to inventory items. Tiers, in order — every alias tier is
 * scoped to `supplierId` (the session's linked supplier) and never borrows
 * another supplier's wording:
 *   0  this supplier's alias by item code        → HIGH 100
 *      (a code live aliases give to 2+ items is ambiguous → skipped)
 *   0b this supplier's OFFER SKU (box library)   → HIGH 100
 *      (stands down when tier 1's alias names a different item)
 *   1  this supplier's alias by wording          → HIGH 100
 *   2  fuzzy against item names                  → confidenceFromScore
 *   3  fuzzy against this supplier's wordings    → capped MEDIUM (capAliasConfidence)
 * Tiers 2 and 3 run as one pass (pickBestFuzzy; an own name beats an alias on a
 * tie). With no `supplierId`, tiers 0, 0b, 1 and 3 are skipped: names only.
 * `supplierName` / `canonicalName` no longer take part in matching — they are
 * kept in the signature for the callers and used for logging only.
 */
export async function matchLineItems(
  ocrItems: OcrLineItem[],
  supplierName?: string | null,
  canonicalName?: string | null,
  supplierId?: string | null
): Promise<(OcrLineItem & MatchResult)[]> {
  const inventoryItems = await prisma.inventoryItem.findMany({
    where: {
      isActive: true,
      mergedIntoId: null,
      // Exclude PREP recipe outputs — they're made in-house, not purchasable,
      // so an invoice line must never fuzzy-match to one (e.g. "Adobo Pulled Pork").
      NOT: { recipe: { type: 'PREP' } },
    },
    select: {
      id: true,
      itemName: true,
      ...PRICING_SELECT,
    },
  })

  if (!supplierId && ocrItems.length > 0) {
    const who = canonicalName || supplierName
    console.debug(`[matcher] no linked supplier${who ? ` for "${who}"` : ''} — matching on item names only`)
  }

  // ── This supplier's own wordings and codes (tiers 0 and 1) ─────────────────
  // One read: every alias of this supplier whose normalised wording or item code
  // appears on this invoice. A stale client / missing table degrades to fuzzy.
  const texts = Array.from(new Set(ocrItems.map(i => normaliseAliasText(i.description)).filter(Boolean)))
  const codes = Array.from(new Set(ocrItems.map(i => normItemCode(i.supplierItemCode)).filter(Boolean)))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exactAliases: any[] = []
  if (supplierId && (texts.length > 0 || codes.length > 0)) {
    try {
      exactAliases = await prisma.itemSupplierAlias.findMany({
        where: {
          supplierId,
          OR: [
            ...(texts.length ? [{ text: { in: texts } }] : []),
            ...(codes.length ? [{ supplierItemCode: { in: codes } }] : []),
          ],
        },
        include: { inventoryItem: { select: ITEM_FOR_MATCH } },
        orderBy: [{ useCount: 'desc' }, { lastUsed: 'desc' }],
      })
    } catch (e) {
      console.error('[matcher] supplier wordings unavailable — fuzzy only:', e)
    }
  }
  // First (most used) live alias per code / per wording. An alias whose item
  // fails W4 is skipped here, so the line falls through to the next tier.
  // A code that live aliases of this supplier give to more than one distinct
  // item is ambiguous — no signal says which is current — so it is omitted from
  // tier 0 entirely, exactly as buildOfferSkuIndex treats a shared offer SKU.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aliasByCode = new Map<string, any>()
  const ambiguousCodes = new Set<string>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aliasByText = new Map<string, any>()
  for (const a of exactAliases) {
    if (!isMatchable(a.inventoryItem)) continue
    if (a.supplierItemCode) {
      const held = aliasByCode.get(a.supplierItemCode)
      if (!held) aliasByCode.set(a.supplierItemCode, a)
      else if (held.inventoryItem.id !== a.inventoryItem.id) ambiguousCodes.add(a.supplierItemCode)
    }
    if (!aliasByText.has(a.text)) aliasByText.set(a.text, a)
  }
  for (const c of ambiguousCodes) aliasByCode.delete(c)

  // ── This supplier's wordings for the items in play (tier 3) ────────────────
  // Scoped to the W4 items above and ordered by usefulness so the per-item cap
  // keeps the strongest; grouped + pre-normalised once so the per-line hot loop
  // never re-tokenizes a string. No row cap on the query: a global cap would
  // drop whole items' wordings once one supplier passed it, and the per-item
  // cap (ALIAS_CAP_PER_ITEM, applied in groupAliases) is the real bound.
  let fuzzyAliasRows: { inventoryItemId: string; rawText: string }[] = []
  if (supplierId && inventoryItems.length > 0) {
    try {
      fuzzyAliasRows = await prisma.itemSupplierAlias.findMany({
        where: { supplierId, inventoryItemId: { in: inventoryItems.map(i => i.id) } },
        select: { inventoryItemId: true, rawText: true },
        orderBy: [{ useCount: 'desc' }, { lastUsed: 'desc' }],
      })
    } catch {
      // stale client / missing table — names only
    }
  }
  const itemNameById = new Map(inventoryItems.map(i => [i.id, i.itemName]))
  const aliasesByItem = new Map<string, InventoryItem[]>()
  for (const [itemId, aliases] of groupAliases(fuzzyAliasRows, itemNameById)) {
    aliasesByItem.set(itemId, aliases.map(a => ({
      itemName: a,
      _normName: normalize(a),
      _keyName: keyWords(a),
    } as unknown as InventoryItem)))
  }

  // ── This supplier's offers: per-supplier last price + pack format ─────────
  // Comparing a line against the supplier's OWN offer (not the item's single
  // price/format fields) is what stops supplier alternation from reading as
  // price changes and format mismatches on every invoice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let offerRows: any[] = []
  if (supplierId) {
    try { offerRows = await prisma.inventorySupplierPrice.findMany({ where: { supplierId } }) }
    catch { /* stale client — fall back to item comparison */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerByItemId = new Map<string, any>()
  for (const o of offerRows) if (!offerByItemId.has(o.inventoryItemId) || o.isPrimary) offerByItemId.set(o.inventoryItemId, o)

  // Offer SKUs are the supplier library itself: (supplier, SKU) → item, even
  // when no alias was ever saved (e.g. an offer that arrived through a merge).
  // offerRows is already this supplier's (loaded by supplierId) so a SKU only
  // ever resolves within the same supplier; ambiguous SKUs (claimed by more than
  // one distinct item) are omitted by buildOfferSkuIndex, never guessed.
  const offerBySku = buildOfferSkuIndex(offerRows)
  // Built from inventoryItems (already W4-filtered) so an offer SKU can never
  // resolve to an inactive, merged or PREP-output item.
  const itemById = new Map(inventoryItems.map(i => [i.id, i]))

  // Pre-normalize all inventory item names once — avoids re-computing per OCR item
  const normalizedItems = inventoryItems.map(item => ({
    ...item,
    _normName: normalize(item.itemName),
    _keyName:  keyWords(item.itemName),
  })) as unknown as InventoryItem[]

  return ocrItems.map((ocrItem) => {
    // ── 0. This supplier's alias by item code (deterministic) ──────────────
    const code = normItemCode(ocrItem.supplierItemCode)
    const byCode = code ? aliasByCode.get(code) : undefined
    if (byCode) {
      return buildMatchResult(
        ocrItem,
        byCode.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        aliasFormat(byCode, ocrItem.description),
        offerByItemId.get(byCode.inventoryItem.id) ?? null
      )
    }

    // ── 0b. This supplier's offer SKU (the box library) ────────────────────
    // Stands down when this supplier's taught wording for this exact line (a
    // live alias, tier 1's own lookup) names a DIFFERENT item: a code left on an
    // old item's box is stale, and the human-taught wording is the fresher fact.
    // An alias that agrees with the SKU, or none at all, leaves 0b in charge.
    const byText = aliasByText.get(normaliseAliasText(ocrItem.description))
    const skuItem = ocrItem.supplierItemCode
      ? itemById.get(offerBySku.get(ocrItem.supplierItemCode) ?? '')
      : undefined
    if (skuItem && !(byText && byText.inventoryItem.id !== skuItem.id)) {
      const ocrPack = (ocrItem.packQty || ocrItem.packSize)
        ? { packQty: ocrItem.packQty ?? 1, packSize: ocrItem.packSize ?? 1, packUOM: ocrItem.packUOM ?? 'each' }
        : parseFormatFromDescription(ocrItem.description)
      return buildMatchResult(ocrItem, skuItem as unknown as InventoryItem, 'HIGH', 100, ocrPack, offerByItemId.get(skuItem.id) ?? null)
    }

    // ── 1. This supplier's alias by wording ────────────────────────────────
    if (byText) {
      return buildMatchResult(
        ocrItem,
        byText.inventoryItem as unknown as InventoryItem,
        'HIGH',
        100,
        aliasFormat(byText, ocrItem.description),
        offerByItemId.get(byText.inventoryItem.id) ?? null
      )
    }

    // ── 2 + 3. Fuzzy: item names, and this supplier's own wordings ─────────
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

    // A match won through one of this supplier's wordings is a hint, not a fact:
    // a human confirms it; approval then upserts the wording and the next
    // invoice is HIGH via tier 1.
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

/**
 * Learn one supplier's wording (and item code, and pack) for an item — W2:
 * every approved line with a supplier, CREATE_NEW lines included. Keyed by
 * `(supplierId, normaliseAliasText(rawDescription))`, so spellings that differ
 * only in case or punctuation are one alias.
 *
 * Learns nothing with no supplier (an unlinked invoice has nobody to attribute
 * the wording to) or a blank wording.
 *
 * Undo (invoice approve): reads only — every write keeps its exact payload and
 * order. Approve wraps the call in `.catch`, so a failed pre-write read must
 * never abort the writes, and is never mistaken for "nothing there".
 */
export async function saveAlias(a: {
  rawDescription: string
  inventoryItemId: string
  supplierId: string | null | undefined
  supplierItemCode?: string | null
  format?: { packQty: number; packSize: number; packUOM: string } | null
  source: 'APPROVE' | 'CREATE_NEW'
  undo?: UndoCollector
}): Promise<void> {
  const text = normaliseAliasText(a.rawDescription)
  if (!a.supplierId || !text) {
    console.debug(`[saveAlias] nothing learned for "${a.rawDescription}": ${!a.supplierId ? 'no linked supplier' : 'blank wording'}`)
    return
  }
  const { supplierId, inventoryItemId, undo } = a
  const code = normItemCode(a.supplierItemCode) || null

  // A code maps to exactly one item per supplier. If sibling aliases (other
  // wordings) under this supplier carry this code but point at a different
  // item, the fresh confirmation wins — strip the code from them so tier 0
  // can't keep resurrecting the old mapping.
  if (code) {
    const siblingWhere = { supplierId, supplierItemCode: code, inventoryItemId: { not: inventoryItemId } }
    if (undo) {
      // A caught failure here is "unknown", not "no siblings": `.catch` returns
      // [] so nothing is recorded for rows this run could not read. The write
      // below is not gated on the read and always runs.
      const siblings = await prisma.itemSupplierAlias
        .findMany({ where: siblingWhere, select: { id: true, ...ALIAS_SELECT } })
        .catch(() => [])
      siblings.forEach((r) => undo.before('ALIAS', r.id, aliasState(r)))
    }
    await prisma.itemSupplierAlias.updateMany({ where: siblingWhere, data: { supplierItemCode: null } })
  }

  // The upsert's target, read before it is written: an existing row is captured
  // as `prev`, a fresh one is recorded as created (so undo deletes it). A failed
  // read must NOT be treated as "not found" — that would `created()` an alias
  // that may have existed all along, and a rollback would delete it.
  // Read with or without an undo collector: it also tells whether this wording
  // is MOVING to another item, whose count then restarts (below).
  const where = { supplierId_text: { supplierId, text } }
  let existingReadFailed = false
  const existing = await prisma.itemSupplierAlias
    .findUnique({ where, select: { id: true, ...ALIAS_SELECT } })
    .catch(() => {
      existingReadFailed = true
      return null
    })
  if (existing) undo?.before('ALIAS', existing.id, aliasState(existing))
  // A wording re-pointed at another item never earned its old count there:
  // restart at 1. Same item, or an unreadable row (unknown ≠ moved) → +1.
  const moved = !!existing && existing.inventoryItemId !== inventoryItemId

  const row = await prisma.itemSupplierAlias.upsert({
    where,
    create: {
      inventoryItemId,
      supplierId,
      text,
      rawText: a.rawDescription,
      supplierItemCode: code,
      packQty: a.format?.packQty ?? null,
      packSize: a.format?.packSize ?? null,
      packUOM: a.format?.packUOM ?? null,
      source: a.source,
      useCount: 1,
    },
    update: {
      inventoryItemId,
      rawText: a.rawDescription,
      useCount: moved ? 1 : { increment: 1 },
      lastUsed: new Date(),
      ...(code ? { supplierItemCode: code } : {}),
      ...(a.format ? { packQty: a.format.packQty, packSize: a.format.packSize, packUOM: a.format.packUOM } : {}),
    },
    select: { id: true },
  })
  if (undo && !existing && !existingReadFailed) undo.created('ALIAS', row.id)
}
