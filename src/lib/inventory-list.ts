/**
 * The /api/inventory list fetch, extracted so the xlsx export can return exactly
 * the rows the screen shows. Two implementations of this RC-scoping logic would
 * drift, and the symptom would be a spreadsheet that quietly disagrees with the app.
 *
 * Moved verbatim from src/app/api/inventory/route.ts — behaviour-preserving.
 */
import { type User } from '@prisma/client'
import { prisma } from './prisma'
import { lastCost, listedPrice } from '@/lib/cost-basis'
import { getTheoreticalStockMapCached } from './theoretical-cache'
import { getCountedStockMap, type CountedStock } from './counted-stock'
import { resolveScopedRcIds } from './rc-scope'
import { PRIMARY_SUPPLIER_INCLUDE, withSupplier } from './item-supplier'

export interface InventoryListParams {
  search: string
  category: string
  supplierId: string
  storageAreaId: string
  isActive: string | null
  rcId: string
  isDefault: boolean
  /** location lens — narrows "All" to the revenue centres under this location */
  locationId: string
  includeNonStocked: boolean
}

export interface InventoryListRow {
  id: string
  itemName: string
  category: string
  supplier?: { id: string; name: string } | null
  storageArea?: { name: string } | null
  baseUnit: string
  countUnit?: string | null
  dimension: string
  isActive: boolean
  lastCountDate: string | null
  theoreticalStock: number
  countedStock: number
  /** last physically counted qty (base units) for THIS scope; null = never counted here */
  countedQtyScoped: number | null
  /** ISO date of the oldest count behind countedQtyScoped; null when never counted here */
  countedDateScoped: string | null
  pricePerBaseUnit: number
  parLevel?: number | null
  // packChain, pricing, purchasePrice (computed), stockOnHand, lastCountQty and the rest of the
  // Prisma row ride along untyped, exactly as the route returned them. `supplier` and
  // `supplierId` are derived from the item's primary supplier box (withSupplier).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** Read the list params off a URL. Both the list route and the export use this. */
export function parseInventoryListParams(searchParams: URLSearchParams): InventoryListParams {
  // Location lens: InventoryItem has no RC column and per-RC stock lives in
  // StockAllocation, so a location narrows the list through its REVENUE CENTRES —
  // it behaves as "All revenue centres, limited to this location's". It used to be
  // accepted and ignored, which made a one-RC location (CATERING) show the whole
  // catalogue — every KITCHEN item — under a chip that named only CATERING.
  // Non-stocked (recipe-only) items are hidden from the operational list by default;
  // the inventory page passes includeNonStocked=true to reveal them.
  return {
    search:            searchParams.get('search') || '',
    category:          searchParams.get('category') || '',
    supplierId:        searchParams.get('supplierId') || '',
    storageAreaId:     searchParams.get('storageAreaId') || '',
    isActive:          searchParams.get('isActive'),
    rcId:              searchParams.get('rcId') || '',
    isDefault:         searchParams.get('isDefault') === 'true',
    locationId:        searchParams.get('locationId') || '',
    includeNonStocked: searchParams.get('includeNonStocked') === 'true',
  }
}

/**
 * Theoretical stock comes from the SHARED short-lived cache (theoretical-cache.ts),
 * asked for every active stocked item — never just this page's ids. The movement
 * scans behind it read the whole history for the RC regardless of the id list and
 * each item's balance is independent of the others, so the full map costs the same
 * as a filtered one and gives the same numbers — but one key means a search, a
 * filter change, a revisit or the cost-chrome strip all reuse one computation
 * instead of re-running the most expensive read in the app. Stock-moving writes
 * invalidate it (`invalidatesTheoretical`); the 30 s TTL covers other instances.
 */

/** Attach theoreticalStock, countedStock, lastCountDate and the scoped counted figure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachTheoreticalFields<T extends Record<string, any>>(
  items: T[],
  theoMap: Map<string, number>,
  countedMap: Map<string, CountedStock>,
): (T & {
  theoreticalStock: number
  countedStock: number
  lastCountDate: string | null
  countedQtyScoped: number | null
  countedDateScoped: string | null
  pricePerBaseUnit: number
})[] {
  return items.map(item => {
    // Use a pre-set countedStock when the caller already captured the raw value (e.g. the
    // "All RCs" path pre-sets it before inflating stockOnHand with allocTotal). Otherwise
    // derive it from the current stockOnHand.
    const counted = item.countedStock !== undefined ? Number(item.countedStock) : Number(item.stockOnHand)
    const theoretical = theoMap.has(item.id) ? theoMap.get(item.id)! : counted
    const lastCountDate = item.lastCountDate
      ? (item.lastCountDate instanceof Date ? item.lastCountDate.toISOString() : String(item.lastCountDate))
      : null
    // The last PHYSICALLY counted quantity for the revenue centres this response is
    // scoped to — the Stock in Hand basis. Deliberately not lastCountQty: that column
    // is global, so in a non-default RC it reports another RC's count (see
    // src/lib/counted-stock.ts). Absent from the map = never counted in this scope,
    // which is null and NOT zero.
    const scopedCount = countedMap.get(item.id) ?? null
    // Re-populate the `pricePerBaseUnit` response field by computing it from the
    // chain so client readers (inventory/page, GlobalSearch, setup/categories,
    // wastage selectedItem) survive the legacy column drop.
    return {
      ...item,
      theoreticalStock: theoretical,
      countedStock: counted,
      lastCountDate,
      countedQtyScoped:  scopedCount ? scopedCount.qtyBase : null,
      countedDateScoped: scopedCount ? scopedCount.date    : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pricePerBaseUnit: lastCost(item as any),
      // Computed from the chain's pricing, not a column (the column is retired).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      purchasePrice: listedPrice(item as any),
    }
  })
}

/**
 * `outOfScope` is true when a scoped user asked for an rcId outside their scope —
 * the caller must return an empty result, never another RC's data.
 */
/** Optional stopwatch: the list route reports these phases as a Server-Timing header. */
export type PhaseTimer = <T>(name: string, work: Promise<T>) => Promise<T>
const untimed: PhaseTimer = (_name, work) => work

export async function fetchInventoryList(
  user: User,
  params: InventoryListParams,
  time: PhaseTimer = untimed,
): Promise<{ rows: InventoryListRow[]; outOfScope: boolean }> {
  const { search, category, supplierId, storageAreaId, isActive, rcId, isDefault, locationId, includeNonStocked } = params

  // Inventory items carry no revenueCenterId column (RC association lives in
  // StockAllocation / ItemRevenueCenter), so scopedRcWhere does not apply to the
  // item where-clause. Instead fail closed at the RC boundary: a scoped user that
  // explicitly requests an rcId outside their scope gets nothing (empty list)
  // rather than another RC's allocation/default-pool data. allowed===null
  // (ADMIN / unscoped) keeps every path behaving exactly as before.
  const allowed = await resolveScopedRcIds(user)
  if (rcId && allowed !== null && !allowed.has(rcId)) {
    return { rows: [], outOfScope: true }
  }

  // The location lens is "All revenue centres, narrowed to this location's". It runs
  // through the same allowed-set machinery the "All" path already uses for a scoped
  // user, intersected with that scope so a lens can only ever narrow access, never
  // widen it. An empty intersection yields an empty list, not the whole catalogue.
  let lensRcIds: Set<string> | null = null
  if (locationId && !rcId) {
    const rcs = await prisma.revenueCenter.findMany({ where: { locationId }, select: { id: true } })
    lensRcIds = new Set(
      rcs.map(rc => rc.id).filter(id => allowed === null || allowed.has(id)),
    )
  }
  // What "All" means for this request: the lens when there is one, else the user's scope.
  const scope = lensRcIds ?? allowed

  const itemWhere = {
    AND: [
      search ? { itemName: { contains: search, mode: 'insensitive' as const } } : {},
      category ? { category } : {},
      // "items this supplier sells" — a box from that supplier, primary or not
      supplierId ? { supplierPrices: { some: { supplierId } } } : {},
      storageAreaId ? { storageAreaId } : {},
      isActive !== null && isActive !== '' ? { isActive: isActive === 'true' } : {},
      // Merge tombstones are never listed — not even by "show inactive", which is
      // the one filter that would otherwise surface them (a merge leaves the row
      // inactive on purpose). They carry no stock, no history of their own any
      // more, and nothing may be done to them but undo, from the survivor.
      { mergedIntoId: null },
      includeNonStocked ? {} : { isStocked: true },
    ],
  }

  const itemInclude = {
    ...PRIMARY_SUPPLIER_INCLUDE,
    storageArea: true,
    recipe: { select: { id: true, name: true } },
  }

  // Non-default RC: show the items that are MEMBERS of this RC (ItemRevenueCenter) —
  // the same visibility rule the count uses. Membership is what a theoretical pull/
  // transfer grants (it no longer writes a StockAllocation row), so an item moved into
  // this RC appears here with its theoretical on-hand. StockAllocation is left-joined
  // only for par/reorder (and rcStock as a legacy fallback).
  if (rcId && !isDefault) {
    const [members, allocations] = await time('items', Promise.all([
      prisma.inventoryItem.findMany({
        where: { AND: [itemWhere, { revenueCenters: { some: { revenueCenterId: rcId } } }] },
        include: itemInclude,
        orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
      }),
      prisma.stockAllocation.findMany({
        where: { revenueCenterId: rcId },
        select: { inventoryItemId: true, quantity: true, parLevel: true, reorderQty: true },
      }),
    ]))
    const allocByItemId = Object.fromEntries(allocations.map(a => [a.inventoryItemId, a]))
    const items = members.map(m => {
      const i = withSupplier(m)
      const alloc = allocByItemId[i.id]
      return {
        ...i,
        rcStock:    alloc ? Number(alloc.quantity) : 0,
        parLevel:   alloc?.parLevel   != null ? Number(alloc.parLevel)   : null,
        reorderQty: alloc?.reorderQty != null ? Number(alloc.reorderQty) : null,
      }
    })
    const itemIds = items.map(i => i.id)
    const [theoMap, countedMap] = await Promise.all([
      time('theoretical', getTheoreticalStockMapCached(rcId)),
      time('counted', getCountedStockMap([rcId], itemIds)),
    ])
    return { rows: attachTheoreticalFields(items, theoMap, countedMap), outOfScope: false }
  }

  // Default RC (Cafe): stockOnHand IS Cafe's pool – return as-is
  if (rcId && isDefault) {
    const [items, allocations] = await time('items', Promise.all([
      prisma.inventoryItem.findMany({
        where: itemWhere,
        include: itemInclude,
        orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
      }),
      prisma.stockAllocation.findMany({
        where: { revenueCenterId: rcId },
        select: { inventoryItemId: true, parLevel: true, reorderQty: true },
      }),
    ]))
    const allocByItemId = Object.fromEntries(allocations.map(a => [a.inventoryItemId, a]))
    const result = items.map(raw => {
      const i = withSupplier(raw)
      const alloc = allocByItemId[i.id]
      return {
        ...i,
        parLevel:   alloc?.parLevel !== null && alloc?.parLevel !== undefined ? Number(alloc.parLevel) : null,
        reorderQty: alloc?.reorderQty !== null && alloc?.reorderQty !== undefined ? Number(alloc.reorderQty) : null,
      }
    })
    const itemIds = result.map(i => i.id)
    const [theoMap, countedMap] = await Promise.all([
      time('theoretical', getTheoreticalStockMapCached(rcId)),
      // getCountedStockMap attributes pre-RC (null) count sessions to the default RC,
      // so this path also picks up the counts that predate the revenue-centre model.
      time('counted', getCountedStockMap([rcId], itemIds)),
    ])
    return { rows: attachTheoreticalFields(result, theoMap, countedMap), outOfScope: false }
  }

  // "All Revenue Centers": total physical stock = stockOnHand (Cafe pool) + all RC allocations
  // Exclude default-RC allocations: the default RC's stock already lives in stockOnHand, so
  // summing its allocation on top would double-count it.
  //
  // Scope: `scope` is the set of RCs "All" aggregates over — a scoped user's allowed RCs,
  // or the location lens's RCs when one is selected. We therefore (a) only sum non-default
  // allocations in in-scope RCs, (b) include the default RC's stockOnHand pool only when the
  // default RC is itself in scope, (c) list only items that are members of / allocated to an
  // in-scope RC, and (d) pass the same set into getTheoreticalStockMap / getCountedStockMap
  // so the per-RC sums are limited identically.
  // scope === null (ADMIN / unscoped, no lens) leaves every clause untouched.
  const defaultRc = scope !== null
    ? await prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true } })
    : null
  const defaultRcInScope = scope === null || (defaultRc !== null && scope.has(defaultRc.id))

  // Restrict the listed items to those with membership or a non-default allocation in an
  // in-scope RC (mirrors the per-RC view, which lists items via ItemRevenueCenter). When the
  // default RC is in scope, its pool items (everything) are visible too.
  let scopedItemFilter: Record<string, unknown> = {}
  if (scope !== null) {
    if (defaultRcInScope) {
      // default RC in scope → all items visible (default pool spans the whole catalogue)
      scopedItemFilter = {}
    } else if (scope.size === 0) {
      scopedItemFilter = { id: { in: [] } }
    } else {
      const scopeIds = [...scope]
      scopedItemFilter = {
        OR: [
          { stockAllocations: { some: { revenueCenterId: { in: scopeIds } } } },
          { revenueCenters: { some: { revenueCenterId: { in: scopeIds } } } },
        ],
      }
    }
  }

  const rawItems = await time('items', prisma.inventoryItem.findMany({
    where: { AND: [itemWhere, scopedItemFilter] },
    include: {
      ...itemInclude,
      stockAllocations: {
        where: scope === null
          ? { revenueCenter: { isDefault: false } }
          : { revenueCenter: { isDefault: false }, revenueCenterId: { in: [...scope] } },
        select: { quantity: true },
      },
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  }))
  const items = rawItems.map(({ stockAllocations, ...rawItem }) => {
    const item = withSupplier(rawItem)
    // The default RC's stockOnHand pool only counts toward the aggregate when that RC is in
    // scope; otherwise a scoped user (who can't see the default RC) sees only their allocations.
    const rawStockOnHand = defaultRcInScope ? Number(item.stockOnHand) : 0
    const allocTotal = stockAllocations.reduce((s, a) => s + Number(a.quantity), 0)
    // stockOnHand is inflated for display (pooled total across all RCs), but we pre-attach
    // countedStock from the raw value so attachTheoreticalFields sees the true last-counted figure.
    return { ...item, stockOnHand: rawStockOnHand + allocTotal, countedStock: rawStockOnHand }
  })
  const itemIds = items.map(i => i.id)
  const [theoMap, countedMap] = await Promise.all([
    time('theoretical', getTheoreticalStockMapCached(null, undefined, scope)),
    // Same scope rule as the theoretical map: "All" is Σ over the RCs in scope — the
    // location lens's RCs, or a scoped user's allowed set, or every RC.
    time('counted', getCountedStockMap(scope === null ? null : [...scope], itemIds)),
  ])
  return { rows: attachTheoreticalFields(items, theoMap, countedMap), outOfScope: false }
}
