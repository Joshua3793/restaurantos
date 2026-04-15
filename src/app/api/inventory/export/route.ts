import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import * as XLSX from 'xlsx'

export async function GET() {
  const items = await prisma.inventoryItem.findMany({
    include: { supplier: true, storageArea: true },
    orderBy: [{ category: 'asc' }, { itemName: 'asc' }],
  })

  const totalValue = items.filter(i => i.isActive).reduce((sum, i) =>
    sum + parseFloat(i.stockOnHand.toString()) * parseFloat(i.pricePerBaseUnit.toString()), 0)
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
  const headers = ['Item Name', 'Abbreviation', 'Category', 'Supplier', 'Storage Area', 'Purchase Unit', 'Qty/Purchase Unit', 'Purchase Price', 'Base Unit', 'Conversion Factor', 'Price/Base Unit', 'Stock On Hand', 'Stock Value', 'Active', 'Last Count Date', 'Last Count Qty', 'Location']
  const rows = items.map(item => {
    const stockValue = parseFloat(item.stockOnHand.toString()) * parseFloat(item.pricePerBaseUnit.toString())
    return [
      item.itemName,
      item.abbreviation || '',
      item.category,
      item.supplier?.name || '',
      item.storageArea?.name || '',
      item.purchaseUnit,
      parseFloat(item.qtyPerPurchaseUnit.toString()),
      parseFloat(item.purchasePrice.toString()),
      item.baseUnit,
      parseFloat(item.conversionFactor.toString()),
      parseFloat(item.pricePerBaseUnit.toString()),
      parseFloat(item.stockOnHand.toString()),
      stockValue,
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
