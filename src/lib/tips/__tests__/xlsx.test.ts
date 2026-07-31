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

  // ── CRITICAL 1: a malformed date-shaped number/string must reject, not misparse ──

  it('rejects a numeric date with an out-of-range month instead of silently misparsing it as an Excel serial', () => {
    const buf = book({
      'Sales by day': [['Date', 'Net sales'], [20261399, 100]], // month 13
    })
    expect(() => parseSalesWorkbook(buf)).toThrow(/20261399/)
  })

  it('rejects a string-form date with an out-of-range day the same way as the numeric form', () => {
    const buf = book({
      'Sales by day': [['Date', 'Net sales'], ['20260732', 100]], // day 32
    })
    expect(() => parseSalesWorkbook(buf)).toThrow(/20260732/)
  })

  // ── CRITICAL 2: the tips column match must be anchored and unambiguous ──

  it('does NOT adopt a column that merely contains "tip" as a substring (e.g. "Non-tip amount")', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales', 'Non-tip amount'],
        [20260712, 100, 999],
      ],
    }))
    expect(r.tips).toBeNull()
  })

  it('throws when more than one column looks like a tips column, naming the candidates', () => {
    const buf = book({
      'Sales by day': [
        ['Date', 'Net sales', 'Tip Amount', 'Tip Total'],
        [20260712, 100, 10, 12],
      ],
    })
    expect(() => parseSalesWorkbook(buf)).toThrow(/Tip Amount/)
    expect(() => parseSalesWorkbook(buf)).toThrow(/Tip Total/)
  })

  // ── IMPORTANT 3: accounting-format negatives and unparseable figures ──

  it('reads an accounting-format negative like "($1,234.56)" as -1234.56, keeping the day', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, '($1,234.56)'],
        [20260713, 500],
      ],
    }))
    expect(r.iso).toEqual(['2026-07-12', '2026-07-13'])
    expect(r.sales).toEqual([-1234.56, 500])
  })

  it('surfaces a genuinely unparseable net-sales figure via unparsedRows instead of silently dropping the day', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, 'N/A'],
        [20260713, 500],
      ],
    }))
    expect(r.iso).toEqual(['2026-07-13'])
    expect(r.sales).toEqual([500])
    expect(r.unparsedRows).toEqual([{ row: 2, raw: 'N/A' }])
  })

  it('reports the spreadsheet row number and raw value for an unparsed row, not just a count', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, 500],
        [20260713, 'garbage'],
        [20260714, 600],
      ],
    }))
    expect(r.unparsedRows).toEqual([{ row: 3, raw: 'garbage' }])
  })

  // ── unbalanced accounting parens must not silently flip sign ──

  it('rejects a truncated accounting negative with no closing paren instead of reading it as positive', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, '(12.34'],
        [20260713, 500],
      ],
    }))
    expect(r.iso).toEqual(['2026-07-13'])
    expect(r.sales).toEqual([500])
    expect(r.unparsedRows).toEqual([{ row: 2, raw: '(12.34' }])
  })

  it('rejects a stray trailing paren with no opening paren instead of reading it as positive', () => {
    const r = parseSalesWorkbook(book({
      'Sales by day': [
        ['Date', 'Net sales'],
        [20260712, '12.34)'],
        [20260713, 500],
      ],
    }))
    expect(r.iso).toEqual(['2026-07-13'])
    expect(r.sales).toEqual([500])
    expect(r.unparsedRows).toEqual([{ row: 2, raw: '12.34)' }])
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

  // ── CRITICAL 1: a malformed date-shaped Date In value must reject, not become dayIndex NaN ──

  it('rejects a numeric Date In with an out-of-range month instead of letting it through as dayIndex NaN', () => {
    const badRows = [
      ['First Name', 'Last Name', 'Clock ID', 'Date In', 'Total Less Break', 'Status'],
      ['Liam', 'Sjogren', '706', 20261399, 9.62, 'Approved'], // month 13
    ]
    expect(() => parseClocksWorkbook(book({ Sheet1: badRows }), '2026-07-12', 14))
      .toThrow(/20261399/)
  })

  it('rejects a string-form Date In with an out-of-range day the same way as the numeric form', () => {
    const badRows = [
      ['First Name', 'Last Name', 'Clock ID', 'Date In', 'Total Less Break', 'Status'],
      ['Liam', 'Sjogren', '706', '20260732', 9.62, 'Approved'], // day 32
    ]
    expect(() => parseClocksWorkbook(book({ Sheet1: badRows }), '2026-07-12', 14))
      .toThrow(/20260732/)
  })

  // ── IMPORTANT 3: an unparseable hours figure must be surfaced, not silently drop the punch ──

  it('surfaces a genuinely unparseable hours figure via unparsedRows instead of silently dropping the punch', () => {
    const partial = [
      ['First Name', 'Last Name', 'Clock ID', 'Date In', 'Total Less Break', 'Status'],
      ['Liam', 'Sjogren', '706', '2026-07-12', 'N/A', 'Approved'],
      ['Thaign', 'Lillie', '1155', '2026-07-13', 10, 'Approved'],
    ]
    const r = parseClocksWorkbook(book({ Sheet1: partial }), '2026-07-12', 14)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].clockId).toBe('1155')
    expect(r.unparsedRows).toEqual([{ row: 2, clockId: '706', raw: 'N/A' }])
  })

  it('reports the spreadsheet row number, clock id, and raw value for an unparsed punch, not just a count', () => {
    const partial = [
      ['First Name', 'Last Name', 'Clock ID', 'Date In', 'Total Less Break', 'Status'],
      ['Liam', 'Sjogren', '706', '2026-07-12', 9.62, 'Approved'],
      ['Thaign', 'Lillie', '1155', '2026-07-13', 'garbage', 'Approved'],
    ]
    const r = parseClocksWorkbook(book({ Sheet1: partial }), '2026-07-12', 14)
    expect(r.unparsedRows).toEqual([{ row: 3, clockId: '1155', raw: 'garbage' }])
  })
})
