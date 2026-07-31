/**
 * Reads the two POS workbooks that drive a tip period.
 *
 * Runs on the server with SheetJS (already a dependency, and already how
 * /api/sales/import and the inventory import read workbooks) rather than the
 * design mock's hand-rolled DecompressionStream unzip — punches are persisted,
 * so there is nothing to gain from keeping the bytes in the browser.
 *
 * Every thrown message is written for the manager staring at the drop zone.
 */
import * as XLSX from 'xlsx'
import { dayIndexOf } from './period'
import type { PunchRow } from './audit'

type Row = unknown[]

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] | null {
  const key = wb.SheetNames.find(n => n.toLowerCase() === name.toLowerCase())
  if (!key) return null
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[key], { header: 1, defval: null, raw: true })
}

function num(v: unknown): number {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  return parseFloat(String(v).replace(/[$,\s]/g, ''))
}

/** Excel serial (or a parseable date string) → 'YYYY-MM-DD'. */
function toIsoDate(v: unknown): string | null {
  // Toast writes the day key as yyyyMMdd. SheetJS hands back a plain number
  // for a numeric-looking cell (raw: true), so this has to be checked before
  // the Excel-serial branch below — an 8-digit day key like 20260712 is far
  // outside any real Excel serial range and must not be run through the
  // serial→date math, which silently produces a garbage year.
  if (typeof v === 'number' && Number.isInteger(v)) {
    const compact = String(v).match(/^(\d{4})(\d{2})(\d{2})$/)
    if (compact) {
      const mm = Number(compact[2])
      const dd = Number(compact[3])
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return `${compact[1]}-${compact[2]}-${compact[3]}`
      }
    }
  }
  if (typeof v === 'number' && v > 1000) {
    const ms = Math.round((v - 25569) * 86_400_000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v ?? '').trim()
  // Toast writes the day key as yyyyMMdd
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
}

export interface ParsedSales {
  iso: string[]
  sales: number[]
  /**
   * Tips per day, when the export carries a tips column — Toast's Sales Summary
   * includes one on some configurations and not others. `null` means the
   * workbook said nothing about tips, which must NOT be read as zero.
   */
  tips: number[] | null
  /** "Net sales" from the Revenue summary sheet, when present — a cross-check. */
  reportedNet: number | null
}

/**
 * Sales Summary workbook → one net-sales figure per calendar day, plus tips
 * when the export carries them.
 * Needs the "Sales by day" sheet: column A the day key, column B net sales.
 */
export function parseSalesWorkbook(buffer: Buffer): ParsedSales {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const rows = sheetRows(wb, 'Sales by day')
  if (!rows) {
    throw new Error('No “Sales by day” sheet — export the Sales Summary with day detail turned on.')
  }

  // Optional tips column, located by header text rather than position.
  const header = (rows[0] ?? []).map(c => String(c ?? '').trim().toLowerCase())
  const tipCol = header.findIndex(h => /^tips?$/.test(h) || /tip (amount|total)/.test(h))

  const iso: string[] = []
  const sales: number[] = []
  const tips: number[] = []
  for (const r of rows.slice(1)) {
    const day = toIsoDate(r?.[0])
    const net = num(r?.[1])
    if (!day || isNaN(net)) continue
    iso.push(day)
    sales.push(Math.round(net * 100) / 100)
    if (tipCol >= 0) {
      const t = num(r?.[tipCol])
      tips.push(isNaN(t) ? 0 : Math.round(t * 100) / 100)
    }
  }
  if (!iso.length) throw new Error('“Sales by day” had no usable rows.')

  let reportedNet: number | null = null
  const rev = sheetRows(wb, 'Revenue summary')
  if (rev?.[0]) {
    const i = rev[0].findIndex(h => /^net sales$/i.test(String(h ?? '')))
    if (i >= 0) {
      const v = num(rev[1]?.[i])
      if (!isNaN(v)) reportedNet = v
    }
  }

  return { iso, sales, tips: tipCol >= 0 ? tips : null, reportedNet }
}

export interface ParsedClocks {
  rows: PunchRow[]
  total: number
  peopleCount: number
  /** Punches whose date falls outside the period window. Kept, flagged by the audit. */
  outside: number
  pending: number
}

/**
 * Clocks Summary workbook → one PunchRow per approved-or-not punch.
 * Hours are matched to people by Clock ID only — never by name, so a spelling
 * change in the POS cannot silently drop somebody from the payout.
 */
export function parseClocksWorkbook(
  buffer: Buffer,
  startDate: string,
  dayCount: number,
): ParsedClocks {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.SheetNames[0]
  if (!sheet) throw new Error('That workbook has no sheets.')
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet], { header: 1, defval: null, raw: true })

  const headerIdx = rows.findIndex(r => r?.some(c => /^first name$/i.test(String(c ?? '').trim())))
  if (headerIdx < 0) {
    throw new Error('No header row found — this does not look like a Clocks Summary export.')
  }
  const header = rows[headerIdx].map(c => String(c ?? '').trim().toLowerCase())
  const col = (...names: string[]) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i }
    return -1
  }
  const C = {
    first: col('first name'),
    last: col('last name'),
    code: col('clock id', 'employee number'),
    pos: col('position'),
    dept: col('department'),
    dateIn: col('date in'),
    hours: col('total less break', 'total'),
    status: col('status'),
    notes: [col('time in comments'), col('time out comments'), col('manager comments')].filter(i => i >= 0),
  }
  if (C.code < 0 || C.dateIn < 0 || C.hours < 0) {
    throw new Error('Missing a Clock ID, Date In or Total Less Break column — re-export the Clocks Summary.')
  }

  const out: PunchRow[] = []
  for (const r of rows.slice(headerIdx + 1)) {
    const first = String(r?.[C.first] ?? '').trim()
    if (!first || /^totals?$/i.test(first)) continue
    const code = String(r?.[C.code] ?? '').trim()
    const hours = Math.round(num(r?.[C.hours]) * 100) / 100
    const iso = toIsoDate(r?.[C.dateIn])
    if (!code || isNaN(hours) || !iso) continue
    out.push({
      clockId: code,
      firstName: first,
      lastName: C.last >= 0 ? String(r?.[C.last] ?? '').trim() : '',
      position: C.pos >= 0 ? String(r?.[C.pos] ?? '').trim() : '',
      department: C.dept >= 0 ? String(r?.[C.dept] ?? '').trim() : '',
      dayIndex: dayIndexOf(startDate, iso),
      hours,
      status: C.status >= 0 ? String(r?.[C.status] ?? 'Approved').trim() || 'Approved' : 'Approved',
      note: C.notes.map(i => r?.[i]).filter(Boolean).join(' · ') || null,
    })
  }
  if (!out.length) throw new Error('No punches found in that workbook.')

  return {
    rows: out,
    total: Math.round(out.reduce((a, r) => a + r.hours, 0) * 100) / 100,
    peopleCount: new Set(out.map(r => r.clockId)).size,
    outside: out.filter(r => r.dayIndex < 0 || r.dayIndex >= dayCount).length,
    pending: out.filter(r => !/approved/i.test(r.status)).length,
  }
}
