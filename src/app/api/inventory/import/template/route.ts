import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { PRICE_BASES, CONTENT_UNITS } from '@/lib/inventory-import'

export const dynamic = 'force-dynamic'

export async function GET() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Inventory Import')

  ws.columns = [
    { header: 'Item Name',      key: 'itemName',      width: 28 },
    { header: 'Purchase Price', key: 'purchasePrice', width: 16 },
    { header: 'Price Basis',    key: 'priceBasis',    width: 14 },
    { header: 'Case Contains',  key: 'caseContains',  width: 15 },
    { header: 'Content Unit',   key: 'contentUnit',   width: 14 },
    { header: 'Stock On Hand',  key: 'stockOnHand',   width: 15 },
    { header: 'Barcode',        key: 'barcode',       width: 18 },
  ]
  ws.getRow(1).font = { bold: true }

  // Two example rows
  ws.addRow({
    itemName: 'Diced Tomatoes', purchasePrice: 24, priceBasis: 'Per Case',
    caseContains: 24, contentUnit: 'each', stockOnHand: 12, barcode: '',
  })
  ws.addRow({
    itemName: 'All Purpose Flour', purchasePrice: 18.5, priceBasis: 'Per kg',
    caseContains: '', contentUnit: '', stockOnHand: 40, barcode: '',
  })

  // Dropdowns on Price Basis (col C) and Content Unit (col E), rows 2..500.
  const priceBasisList = `"${PRICE_BASES.join(',')}"`
  const contentUnitList = `"${CONTENT_UNITS.join(',')}"`
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`C${r}`).dataValidation = {
      type: 'list', allowBlank: false, formulae: [priceBasisList],
    }
    ws.getCell(`E${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: [contentUnitList],
    }
  }

  const arrayBuffer = await wb.xlsx.writeBuffer()
  return new NextResponse(Buffer.from(arrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="inventory-import-template.xlsx"',
    },
  })
}
