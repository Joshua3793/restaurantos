import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import * as XLSX from 'xlsx'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, basePerUnit } from '@/lib/item-model'
import { formatPurchaseDisplay, convertBaseToCountUom } from '@/lib/count-uom'
import { requireSession, AuthError } from '@/lib/auth'
import { fetchInventoryList, parseInventoryListParams, type InventoryListRow } from '@/lib/inventory-list'
import { stockInHandKpis, stockInHandQty, stockInHandValue, theoreticalQty, selectStockInHandRows } from '@/lib/stock-in-hand'
import { PILL_LABELS, INVENTORY_PILLS, type InventoryPill, type PillItem } from '@/lib/inventory-pills'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  // This route serves the full priced catalogue. API routes bypass middleware, so
  // the guard has to live here — it had none at all before.
  let user
  try { user = await requireSession('MANAGER') }
  catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }

  const { searchParams } = new URL(req.url)
  if (searchParams.get('view') === 'stock-in-hand') {
    return stockInHandWorkbook(user, searchParams)
  }

  const items = await prisma.inventoryItem.findMany({
    select: {
      itemName: true,
      category: true,
      supplier: { select: { name: true } },
      storageArea: { select: { name: true } },
      purchasePrice: true,
      ...PRICING_SELECT,
      stockOnHand: true,
      barcode: true,
      isActive: true,
      lastCountDate: true,
      lastCountQty: true,
      location: true,
    },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const totalValue = items.filter(i => i.isActive).reduce((sum, i) =>
    sum + parseFloat(i.stockOnHand.toString()) * pricePerBaseUnit(asChainItem(i)), 0)
  const activeCount = items.filter(i => i.isActive).length
  const countedThisWeek = items.filter(i => {
    if (!i.lastCountDate) return false
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7)
    return new Date(i.lastCountDate) >= weekAgo
  }).length
  const notYetCounted = activeCount - countedThisWeek

  const wb = XLSX.utils.book_new()

  // KPI sheet
  const kpiData = [
    ['CONTROLA OS Inventory Export'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['KPI Summary'],
    ['Total Stock Value', totalValue.toFixed(2)],
    ['Active Items', activeCount],
    ['Total Items', items.length],
    ['Counted This Week', countedThisWeek],
    ['Not Yet Counted', notYetCounted],
  ]
  const kpiSheet = XLSX.utils.aoa_to_sheet(kpiData)
  XLSX.utils.book_append_sheet(wb, kpiSheet, 'KPI Summary')

  // Inventory sheet
  const headers = ['Item Name', 'Category', 'Supplier', 'Storage Area', 'Pack Format', 'Purchase Unit', 'Pricing Mode', 'Count Unit', 'Purchase Price', 'Base Unit', 'Conversion Factor', 'Price/Base Unit', 'Stock On Hand', 'Stock Value', 'Barcode', 'Active', 'Last Count Date', 'Last Count Qty', 'Location']
  const rows = items.map(item => {
    const ci = asChainItem(item)
    const ppb = pricePerBaseUnit(ci)
    const stockValue = parseFloat(item.stockOnHand.toString()) * ppb
    const countUnit = item.countUnit || ci.baseUnit
    return [
      item.itemName,
      item.category,
      item.supplier?.name || '',
      item.storageArea?.name || '',
      formatPurchaseDisplay(item),                       // e.g. "case (12 × 1L)"
      ci.packChain[0]?.unit || ci.baseUnit,              // top-level purchase unit
      ci.pricing.mode,                                   // PACK | RATE
      countUnit,
      parseFloat(item.purchasePrice.toString()),
      item.baseUnit,
      basePerUnit(ci, countUnit),
      ppb,
      parseFloat(item.stockOnHand.toString()),
      stockValue,
      item.barcode || '',
      item.isActive ? 'Yes' : 'No',
      item.lastCountDate ? new Date(item.lastCountDate).toLocaleDateString() : '',
      item.lastCountQty ? parseFloat(item.lastCountQty.toString()) : '',
      item.location || '',
    ]
  })
  const invSheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  XLSX.utils.book_append_sheet(wb, invSheet, 'Inventory')

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  })
}

/**
 * Resolve filter IDs to human names for the KPI sheet. A file that leaves the
 * building has to say what produced it, or it has to be re-derived to be trusted.
 */
async function resolveFilterLabels(searchParams: URLSearchParams) {
  const supplierId    = searchParams.get('supplierId') || ''
  const storageAreaId = searchParams.get('storageAreaId') || ''
  const rcId          = searchParams.get('rcId') || ''

  const [supplier, storageArea, rc] = await Promise.all([
    supplierId    ? prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } })       : null,
    storageAreaId ? prisma.storageArea.findUnique({ where: { id: storageAreaId }, select: { name: true } }) : null,
    rcId          ? prisma.revenueCenter.findUnique({ where: { id: rcId }, select: { name: true } })        : null,
  ])

  const rawPill = searchParams.get('pill') || 'all'
  const pill = (INVENTORY_PILLS as string[]).includes(rawPill) ? rawPill as InventoryPill : 'all'

  // Read isActive exactly the way parseInventoryListParams/fetchInventoryList do:
  // null or '' applies no filter at all; 'true' keeps active items; anything else
  // (the page sends 'false') keeps inactive ones.
  const rawActive = searchParams.get('isActive')
  const activeLabel = rawActive === null || rawActive === ''
    ? 'active and inactive items'
    : rawActive === 'true' ? 'active items only' : 'inactive items only'

  return {
    pill,
    rows: [
      ['Search',         searchParams.get('search') || '(none)'],
      ['Category',       searchParams.get('category') || 'all'],
      ['Supplier',       supplier?.name    ?? 'all'],
      ['Storage area',   storageArea?.name ?? 'all'],
      ['Revenue centre', rc?.name ?? (rcId ? `(unknown: ${rcId})` : 'all')],
      ['Status filter',  PILL_LABELS[pill]],
      ['Needs review',   searchParams.get('needsReview') === 'true' ? 'flagged items only' : 'all'],
      ['Item status',    activeLabel],
      ['Non-stocked items', searchParams.get('includeNonStocked') === 'true' ? 'included' : 'excluded'],
    ] as (string | number)[][],
  }
}

const BASIS_STATEMENT =
  'Showing last physically counted quantities at current prices. ' +
  'No sales, prep, wastage or purchase movement applied.'

// Always true, independent of scope comparability: an RC-scoped count overwrites the
// GLOBAL lastCountQty on the item without touching that RC's stockOnHand allocation
// (see src/lib/count-finalize.ts ~117-124), so a counted quantity read anywhere — even
// in the comparable default-RC or unscoped case — may have been physically counted in
// a different revenue centre than the one the export is scoped to.
const COUNT_SCOPE_CAVEAT =
  'Note: lastCountQty is a single global field on the item, not per revenue centre. An ' +
  'RC-scoped count writes it but leaves that RC’s allocation alone, so a counted quantity ' +
  'always reads "last count of this item anywhere" — it may have been counted in a ' +
  'different revenue centre than the one this export is scoped to.'

// Only true when the scope makes the counted (global) and theoretical (scope-filtered)
// bases outright incomparable, not merely "counted somewhere else".
const CROSS_RC_NOTE =
  'Scope note: theoretical stock, unlike lastCountQty, is scoped to this view. Outside ' +
  'the whole default stock pool the two bases are therefore not comparable: Unverified ' +
  'Movement is reported as n/a and the per-row Unverified Movement Value column is left ' +
  'blank rather than printing a difference between two different scopes.'

const UNVERIFIED_NA_REASON =
  'counted quantities are global, theoretical stock is scoped to this view'

/**
 * Unverified Movement subtracts a GLOBAL counted value (InventoryItem.lastCountQty)
 * from a SCOPE-FILTERED theoretical value, so the subtraction only means something
 * when the view IS the whole default stock pool. The export sees only the scope
 * params the page writes via setScopeParams, which is enough to reconstruct the
 * page's own predicate exactly:
 *   rcId + isDefault=true → the default RC        (comparable)
 *   rcId, no isDefault    → a non-default RC      (not comparable)
 *   locationId            → a location lens       (not comparable)
 *   neither               → the unscoped All view (comparable)
 */
function scopeIsComparable(searchParams: URLSearchParams): boolean {
  const rcId = searchParams.get('rcId') || ''
  if (rcId) return searchParams.get('isDefault') === 'true'
  return !(searchParams.get('locationId') || '')
}

/** The count-UOM facts resolveCountUom / convertBaseToCountUom read off a list row. */
function countDims(row: InventoryListRow) {
  return {
    dimension: row.dimension,
    baseUnit: row.baseUnit,
    packChain: row.packChain,
    countUnit: row.countUnit ?? undefined,
  }
}

/** Quantity in the item's count UOM. Value must NOT be converted — ppb is per base unit. */
function countQty(row: InventoryListRow, baseQty: number): number {
  return convertBaseToCountUom(baseQty, row.countUnit || row.baseUnit, countDims(row))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stockInHandWorkbook(user: any, searchParams: URLSearchParams) {
  const { rows: rawRows, outOfScope } = await fetchInventoryList(user, parseInventoryListParams(searchParams))
  const { pill, rows: filterRows } = await resolveFilterLabels(searchParams)
  const comparable = scopeIsComparable(searchParams)

  // Repair the count unit BEFORE anything reads it, then apply the same pill predicate
  // the page applies — in that order, so the file matches the screen. Extracted into
  // selectStockInHandRows (src/lib/stock-in-hand.ts) so a test can pin the ordering
  // without pulling Prisma/Next into the test's import graph: InventoryItem.countUnit
  // defaults to "each", so a MASS/VOLUME item that never had one set would otherwise be
  // exported as "12.5 each" where the app says "12.5 kg", and the lowStock predicate
  // compares par against a quantity converted through this unit, so an unresolvable
  // stored unit (a cross-dimension leftover, an unknown container name, an empty string)
  // would select a different row set than the screen did if filtered before normalizing.
  //
  // InventoryListRow carries packChain via its `[key: string]: any` catch-all (not a
  // statically declared field), so it satisfies PillItem at runtime but not structurally.
  // Narrow the assertion to just the one genuinely-missing named field (packChain) so
  // every other PillItem field stays under real structural checking — if PillItem later
  // gains a required field InventoryListRow doesn't populate, this call site should fail.
  // outOfScope stays a short-circuit at this call site (not inside the pure helper) so
  // the fail-closed empty result doesn't depend on — or get diluted by — row-selection logic.
  const rows = outOfScope
    ? []
    : selectStockInHandRows(rawRows as (InventoryListRow & Pick<PillItem, 'packChain'>)[], pill)
  const kpis = stockInHandKpis(rows)

  const wb = XLSX.utils.book_new()

  const kpiData: (string | number)[][] = [
    ['Stock in Hand'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['Basis'],
    [BASIS_STATEMENT],
    // Always true — a counted quantity is global, not per-RC, regardless of whether this
    // view's scope happens to be comparable to it — plus, only when the scope makes the
    // counted and theoretical bases outright incomparable, the incomparability explanation.
    [COUNT_SCOPE_CAVEAT],
    ...(comparable ? [] : [[CROSS_RC_NOTE]]),
    [],
    ['Filters applied'],
    ...filterRows,
    [],
    ['KPI Summary'],
    ['Stock in Hand Value',  Number(kpis.value.toFixed(2))],
    ['Coverage',             `${kpis.counted} / ${kpis.total}`],
    ['Never Counted',        kpis.neverCounted],
    ['Oldest Count',         kpis.oldestCountDate ? new Date(kpis.oldestCountDate).toLocaleDateString() : '—'],
    comparable
      ? ['Unverified Movement', Number(kpis.unverifiedMovement.toFixed(2))]
      : ['Unverified Movement', 'n/a', UNVERIFIED_NA_REASON],
  ]
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kpiData), 'KPI Summary')

  const headers = [
    'Item Name', 'Category', 'Supplier', 'Storage Area', 'Count Unit',
    'Stock in Hand (count unit)', 'Base Unit', 'Stock in Hand (base)',
    'Price/Base Unit', 'Stock in Hand Value', 'Last Count Date', 'Counted?',
    'Theoretical Stock (base)', 'Unverified Movement Value',
  ]

  const dataRows = rows.map(row => {
    const qty  = stockInHandQty(row)          // base units, null = never counted
    const ppbRaw = Number(row.pricePerBaseUnit)
    // Mirror stock-in-hand.ts's private num() normalization (null/undefined/''/non-finite
    // -> 0) so a bad price can't leak NaN into the sheet without duplicating that module's
    // behaviour or exporting an internal helper for one call site.
    const ppb  = Number.isFinite(ppbRaw) ? ppbRaw : 0
    const val  = stockInHandValue(row)
    const theo = theoreticalQty(row)
    return [
      row.itemName,
      row.category,
      row.supplier?.name ?? '',
      row.storageArea?.name ?? '',
      row.countUnit || row.baseUnit,
      qty === null ? '' : countQty(row, qty),  // blank, never 0 — a gap is not a zero
      row.baseUnit,
      qty === null ? '' : qty,
      ppb,
      val,
      row.lastCountDate ? new Date(row.lastCountDate).toLocaleDateString() : '',
      qty === null ? 'Never' : 'Yes',
      theo,
      // A global counted value minus a scope-filtered theoretical one is a fabricated
      // number outside the default stock pool — leave the cell blank instead.
      comparable ? theo * ppb - val : '',
    ]
  })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...dataRows]), 'Stock in Hand')

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="stock-in-hand-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  })
}
