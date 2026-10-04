import type { Dimension, PackLink, Pricing } from '@/lib/item-model'
// cost-basis.ts imports Prisma at runtime — type-only import so it isn't bundled client-side.
import type { ItemCostBasis } from '@/lib/cost-basis'
import { convertBaseToCountUom, resolveCountUom } from '@/lib/count-uom'
import { getUnitGroup } from '@/lib/uom'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Format a 'YYYY-MM-DD' business day for display, with no timezone in the path.
 *  Falls back to an ISO instant for a response predating the dayKey field. */
export function formatDay(dayKey: string | null | undefined, isoFallback?: string | null): string {
  const key = dayKey ?? (isoFallback ? isoFallback.slice(0, 10) : null)
  if (!key) return ''
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-CA', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  })
}

export type MovementType = 'SALE' | 'WASTAGE' | 'PREP_IN' | 'PREP_OUT' | 'PURCHASE' | 'TRANSFER'

export interface StockMovement {
  id: string; date: string
  /** 'YYYY-MM-DD' — already resolved to the restaurant's calendar day. Render this,
   *  never `date`: business dates are UTC-midnight markers and a local-timezone
   *  format walks them back a day. */
  dayKey?: string
  type: MovementType
  qty: number; unit: string; description: string
  unbridged?: { qty: number; unit: string }
}

export interface StockReconciliation {
  opening: number; additions: number; consumptions: number
  adjustment: number; theoretical: number; unit: string; movementCount: number
  unbridgedCount?: number
}

export interface StockMovementsResponse {
  lastCount: { qty: number; unit: string; date: string | null; dayKey?: string | null }
  theoretical: { qty: number; unit: string }
  movements: StockMovement[]
  reconciliation?: StockReconciliation
}

/** One row of GET /api/inventory/[id]/price-history. */
export interface PriceHistoryRow {
  invoiceDate: string | null; dayKey: string | null; invoiceNumber: string; supplierName: string;
  qtyPurchased: number | null; unitPrice: number; lineTotal: number | null
}

export interface InventoryItem {
  id: string; itemName: string; category: string
  supplier?: { id: string; name: string } | null
  supplierId?: string | null
  storageArea?: { id: string; name: string } | null
  storageAreaId?: string | null
  purchasePrice: number; baseUnit: string
  pricePerBaseUnit: number
  stockOnHand: number
  allergens?: string[]
  barcode?: string | null
  isActive: boolean
  isStocked?: boolean
  lastCountDate?: string | null; lastCountQty?: number | null
  recipe?: { id: string; name: string } | null
  /** 30-day weighted-average cost basis (null for PREP-linked items — they're never averaged). */
  costBasis?: ItemCostBasis | null
  // Chain model (authoritative)
  dimension?: Dimension | null
  packChain?: PackLink[] | null
  pricing?: Pricing | null
  countUnit?: string | null
  // Count↔weight bridge
  eachMeasureQty?: number | string | null
  eachMeasureUnit?: string | null
  // Density bridge
  densityGPerMl?: number | string | null
  // Edit rules (GET /api/inventory/[id]) — what the drawer may offer to change.
  /** Counts, deliveries or recipes are recorded in its measure → measure locked. */
  hasHistory?: boolean
  /** Supplier boxes — with any, the price and pack live on the box. */
  offerCount?: number
  /** Recipes that cost this item only through its "1 each = N g" bridge. */
  bridgeUsedBy?: { id: string; name: string; type: string }[]
  /** The row version every save names (a mismatch → 409 STALE). */
  lastUpdated?: string
}

export interface EditForm {
  itemName: string; category: string
  storageAreaId: string; storageAreaName: string
  // Chain pricing model
  dimension: Dimension
  chain: PackLink[]
  pricing: Pricing
  countUnit: string
  isActive: boolean
  isStocked: boolean
  allergens: string[]
  barcode: string | null
  // Count↔weight bridge
  eachMeasureQty: number | null
  eachMeasureUnit: string
  // Density bridge
  densityGPerMl: number | null
}

// Default chain state for a brand-new item.
export const DEFAULT_CHAIN: PackLink[] = [{ unit: 'case', per: 1 }]
export const DEFAULT_PRICING: Pricing = { mode: 'PACK', purchasePrice: 0 }

// Derive the chain-form pieces from an item, falling back to safe defaults so a
// row missing chain columns still opens cleanly.
export function chainFromItem(item: InventoryItem): Pick<EditForm, 'dimension' | 'chain' | 'pricing' | 'countUnit'> {
  const dimension = (item.dimension ?? 'COUNT') as Dimension
  const chain = Array.isArray(item.packChain) && item.packChain.length
    ? item.packChain.map(l => ({ unit: l.unit, per: Number(l.per) }))
    : [...DEFAULT_CHAIN]
  const pricing = item.pricing ?? DEFAULT_PRICING
  const countUnit = item.countUnit ?? 'each'
  return { dimension, chain, pricing, countUnit }
}

/** The chain-form pieces of an item, as `chainFromItem` returns them. */
export type ItemChainForm = ReturnType<typeof chainFromItem>

/** Did the form change what the item IS or costs (measure, pack, price)? Those
 *  go through the pricing route, never the item edit. Compared field by field so
 *  a key-order or string-number difference is not mistaken for an edit. */
export function chainChanged(item: InventoryItem, f: EditForm): boolean {
  const c = chainFromItem(item)
  const priceKey = (p: Pricing) => p.mode === 'PACK'
    ? `PACK:${Number(p.purchasePrice)}`
    : `RATE:${Number(p.rate)}:${p.rateUnit}`
  const chainKey = (ch: PackLink[]) => ch.map(l => `${l.unit}:${Number(l.per)}`).join('|')
  return c.dimension !== f.dimension
    || chainKey(c.chain) !== chainKey(f.chain)
    || priceKey(c.pricing) !== priceKey(f.pricing)
}

// Build a fresh EditForm (chain pricing + non-pricing fields) from an item.
// Stock is not on the form: it changes only through a count.
export function buildEditForm(item: InventoryItem): EditForm {
  const c = chainFromItem(item)
  return {
    itemName: item.itemName,
    category: item.category,
    storageAreaId: item.storageAreaId || '',
    storageAreaName: item.storageArea?.name || '',
    dimension: c.dimension,
    chain: c.chain,
    pricing: c.pricing,
    countUnit: c.countUnit,
    isActive: item.isActive,
    isStocked: item.isStocked ?? true,
    allergens: item.allergens ?? [],
    barcode: item.barcode ?? null,
    // Count↔weight bridge. Prisma Decimal arrives as a string — coerce with Number().
    eachMeasureQty: item.eachMeasureQty != null ? Number(item.eachMeasureQty) : null,
    eachMeasureUnit: item.eachMeasureUnit ?? 'g',
    // Density bridge. Prisma Decimal arrives as a string — coerce with Number().
    densityGPerMl: item.densityGPerMl != null ? Number(item.densityGPerMl) : null,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function itemChainDims(item: InventoryItem) {
  return {
    dimension: (item.dimension ?? 'COUNT') as string,
    baseUnit:  item.baseUnit,
    packChain: (Array.isArray(item.packChain) ? item.packChain : []) as unknown,
    countUnit: item.countUnit ?? null,
  }
}

export function normalizeItem(item: InventoryItem): InventoryItem {
  return { ...item, countUnit: resolveCountUom(itemChainDims(item)) }
}

// Convert any baseUnit quantity to the item's count unit for display.
export function baseToDisplay(item: InventoryItem, base: number): number {
  return convertBaseToCountUom(base, resolveCountUom(itemChainDims(item)), itemChainDims(item))
}

export function displayStock(item: InventoryItem): number {
  return baseToDisplay(item, Number(item.stockOnHand))
}

/** What the manager should do about a movement the item could not convert. */
export function unbridgedAdvice(unit: string, baseUnit: string): string {
  const movement = getUnitGroup(unit)
  const base = getUnitGroup(baseUnit)
  if (base === 'Count' && (movement === 'Weight' || movement === 'Volume')) {
    return 'tell it how much one each weighs (1 each = ? g) in Edit so they count'
  }
  const ownUnits = base === 'Weight' ? 'g or kg' : base === 'Volume' ? 'ml or l' : 'each'
  return `they were logged in ${unit}, which this item cannot convert — log them in ${ownUnits}`
}
