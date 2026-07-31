import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSalesWorkbook, parseClocksWorkbook } from '@/lib/tips/xlsx'

function book(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

describe('parseSalesWorkbook', () => {
  it('reads the "Sales by day" sheet into ISO dates and net sales', () => {
    const buf = book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, 12698.27],
        [20260713, 9112.81],
      ],
      'Revenue summary': [['Net sales', 'Gross'], [21811.08, 24000]],
    })
    const r = parseSalesWorkbook(buf)
    expect(r.iso).toEqual(['2026-07-12', '2026-07-13'])
    expect(r.sales).toEqual([12698.27, 9112.81])
    expect(r.reportedNet).toBeCloseTo(21811.08, 2)
  })

  it('reports tips as null when the export has no tips column', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [['Date', 'Net sales'], [20260712, 100]],
    }))
    expect(r.tips).toBeNull()
  })

  it('reads a tips column when the export carries one, wherever it sits', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales', 'Discounts', 'Tips'],
        [20260712, 100, 5, 18.5],
        [20260713, 200, 0, 31.25],
      ],
    }))
    expect(r.tips).toEqual([18.5, 31.25])
  })

  it('throws a manager-readable error when the sheet is missing', () => {
    expect(() => parseSalesWorkbook(book({ Summary: [['nope']] })))
      .toThrow(/Sales by day/)
  })
})

describe('parseClocksWorkbook', () => {
  const rows = [
    ['Clocks Summary'],
    ['First Name', 'Last Name', 'Clock ID', 'Position', 'Department', 'Date In', 'Total Less Break', 'Status', 'Manager Comments'],
    ['Liam', 'Sjogren', '706', 'Sous Chef', 'Back of House', '2026-07-12', 9.62, 'Approved', ''],
    ['Thaign', 'Lillie', '1155', 'BOH team', 'Back of House', '2026-07-13', 10, 'Approved', 'iPad had no power'],
    ['Ghost', 'Shift', '999', 'BOH team', 'Back of House', '2026-08-30', 4, 'Approved', ''],
    ['Totals', '', '', '', '', '', 23.62, '', ''],
  ]

  it('maps punches onto day indexes relative to the period start', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toMatchObject({ clockId: '706', dayIndex: 0, hours: 9.62, department: 'Back of House' })
    expect(r.rows[1]).toMatchObject({ clockId: '1155', dayIndex: 1, note: 'iPad had no power' })
    expect(r.peopleCount).toBe(3)
    expect(r.total).toBeCloseTo(23.62, 2)
  })

  it('counts punches dated outside the period without dropping them', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.outside).toBe(1)
    expect(r.rows.find(x => x.clockId === '999')!.dayIndex).toBeGreaterThan(13)
  })

  it('drops the Totals footer row', () => {
    const r = parseClocksWorkbook(book({ Sheet1: rows }), '2026-07-12', 14)
    expect(r.rows.some(x => x.firstName === 'Totals')).toBe(false)
  })

  it('throws when the header row is not the Clocks Summary layout', () => {
    expect(() => parseClocksWorkbook(book({ Sheet1: [['a', 'b']] }), '2026-07-12', 14))
      .toThrow(/Clocks Summary/)
  })
})
