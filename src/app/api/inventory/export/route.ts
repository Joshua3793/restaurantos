import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import * as XLSX from 'xlsx'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, basePerUnit } from '@/lib/item-model'
import { formatPurchaseDisplay, convertBaseToCountUom } from '@/lib/count-uom'
import { requireSession, AuthError } from '@/lib/auth'
import { fetchInventoryList, parseInventoryListParams, type InventoryListRow } from '@/lib/inventory-list'
import { stockInHandKpis, stockInHandQty, stockInHandValue, theoreticalQty } from '@/lib/stock-in-hand'
import { matchesPill, PILL_LABELS, INVENTORY_PILLS, type InventoryPill, type PillItem } from '@/lib/inventory-pills'

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

  return {
    pill,
    rows: [
      ['Search',         searchParams.get('search') || '(none)'],
      ['Category',       searchParams.get('category') || 'all'],
      ['Supplier',       supplier?.name    ?? 'all'],
      ['Storage area',   storageArea?.name ?? 'all'],
      ['Revenue centre', rc?.name ?? (rcId ? `(unknown: ${rcId})` : 'all')],
      ['Status filter',  PILL_LABELS[pill]],
      ['Non-stocked items', searchParams.get('includeNonStocked') === 'true' ? 'included' : 'excluded'],
    ] as (string | number)[][],
  }
}

const BASIS_STATEMENT =
  'Showing last physically counted quantities at current prices. ' +
  'No sales, prep, wastage or purchase movement applied.'

const CROSS_RC_NOTE =
  'lastCountQty is a single global field on the item. An RC-scoped count writes it ' +
  'but leaves that RC’s allocation alone, so on a non-default revenue centre this ' +
  'reads "last count of this item anywhere", not "last count in this revenue centre".'

/** Quantity in the item's count UOM. Value must NOT be converted — ppb is per base unit. */
function countQty(row: InventoryListRow, baseQty: number): number {
  return convertBaseToCountUom(baseQty, row.countUnit || row.baseUnit, {
    dimension: row.dimension,
    baseUnit: row.baseUnit,
    packChain: row.packChain,
    countUnit: row.countUnit ?? undefined,
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stockInHandWorkbook(user: any, searchParams: URLSearchParams) {
  const { rows: allRows, outOfScope } = await fetchInventoryList(user, parseInventoryListParams(searchParams))
  const { pill, rows: filterRows } = await resolveFilterLabels(searchParams)

  // Apply the same pill predicate the page applies, so the file matches the screen.
  // InventoryListRow carries packChain via its `[key: string]: any` catch-all (not a
  // statically declared field), so it satisfies PillItem at runtime but not structurally.
  // Narrow the assertion to just the one genuinely-missing named field (packChain) so
  // every other PillItem field stays under real structural checking — if PillItem later
  // gains a required field InventoryListRow doesn't populate, this call site should fail.
  const rows = outOfScope ? [] : allRows.filter(r =>
    matchesPill(pill, r as InventoryListRow & Pick<PillItem, 'packChain'>))
  const kpis = stockInHandKpis(rows)

  const wb = XLSX.utils.book_new()

  const kpiData: (string | number)[][] = [
    ['Stock in Hand'],
    ['Generated:', new Date().toLocaleString()],
    [],
    ['Basis'],
    [BASIS_STATEMENT],
    [CROSS_RC_NOTE],
    [],
    ['Filters applied'],
    ...filterRows,
    [],
    ['KPI Summary'],
    ['Stock in Hand Value',  Number(kpis.value.toFixed(2))],
    ['Coverage',             `${kpis.counted} / ${kpis.total}`],
    ['Never Counted',        kpis.neverCounted],
    ['Oldest Count',         kpis.oldestCountDate ? new Date(kpis.oldestCountDate).toLocaleDateString() : '—'],
    ['Unverified Movement',  Number(kpis.unverifiedMovement.toFixed(2))],
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
      theo * ppb - val,
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
