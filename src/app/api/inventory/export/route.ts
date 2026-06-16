import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import * as XLSX from 'xlsx'
import { PRICING_SELECT, asChainItem, pricePerBaseUnit, basePerUnit } from '@/lib/item-model'

export const dynamic = 'force-dynamic'

export async function GET() {
  const items = await prisma.inventoryItem.findMany({
    select: {
      itemName: true,
      category: true,
      supplier: { select: { name: true } },
      storageArea: { select: { name: true } },
      purchaseUnit: true,
      qtyPerPurchaseUnit: true,
      qtyUOM: true,
      priceType: true,
      packSize: true,
      packUOM: true,
      countUOM: true,
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
  const headers = ['Item Name', 'Category', 'Supplier', 'Storage Area', 'Purchase Unit', 'Qty/Purchase Unit', 'Qty UOM', 'Price Type', 'Pack Size', 'Pack UOM', 'Count UOM', 'Purchase Price', 'Base Unit', 'Conversion Factor', 'Price/Base Unit', 'Stock On Hand', 'Stock Value', 'Barcode', 'Active', 'Last Count Date', 'Last Count Qty', 'Location']
  const rows = items.map(item => {
    const ppb = pricePerBaseUnit(asChainItem(item))
    const stockValue = parseFloat(item.stockOnHand.toString()) * ppb
    return [
      item.itemName,
      item.category,
      item.supplier?.name || '',
      item.storageArea?.name || '',
      item.purchaseUnit,
      parseFloat(item.qtyPerPurchaseUnit.toString()),
      item.qtyUOM,
      item.priceType,
      parseFloat(item.packSize.toString()),
      item.packUOM,
      item.countUOM,
      parseFloat(item.purchasePrice.toString()),
      item.baseUnit,
      basePerUnit(asChainItem(item), item.countUOM),
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
