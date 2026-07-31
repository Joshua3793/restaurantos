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

/**
 * `num()` needs to treat `(1,234.56)` — the standard accounting notation for
 * a negative figure — as `-1234.56`, not as garbage. `$`/`,`/whitespace are
 * stripped as before; parentheses are stripped too, but only when the whole
 * string is wrapped in a *balanced* pair (the same test that flags it as
 * negative). A lone/unbalanced paren — e.g. a truncated `"(12.34"` or a
 * stray `"12.34)"` — must NOT have its paren silently dropped: that would
 * turn an unparseable cell into a plausible-but-wrong positive number with
 * no error anywhere. Such cells fall through to being unparseable, same as
 * before parens were handled at all.
 */
function num(v: unknown): number {
  if (v == null) return NaN
  if (typeof v === 'number') return v
  const s = String(v).trim()
  const negative = /^\(.*\)$/.test(s)
  if (!negative && /[()]/.test(s)) return NaN
  const cleaned = s.replace(/[()$,\s]/g, '')
  if (!cleaned || cleaned === '-') return NaN
  const n = parseFloat(cleaned)
  if (isNaN(n)) return NaN
  return negative ? -Math.abs(n) : n
}

/**
 * Thrown by `toIsoDate` when a value is date-shaped (8 digits, laid out like
 * yyyyMMdd) but the month or day is out of range — a malformed date, not a
 * missing one. Callers must NOT treat this like the `null` return (which
 * means "not a date at all, skip the row") — a date-shaped value that fails
 * validation must reject the row/file outright rather than silently fall
 * through to Excel-serial arithmetic, which turns it into an unrelated,
 * wrong-but-truthy date with no error anywhere.
 */
export class MalformedDateError extends Error {
  constructor(public readonly raw: unknown) {
    super(`"${String(raw)}" is not a valid date`)
    this.name = 'MalformedDateError'
  }
}

function compactDateBounds(mm: number, dd: number): boolean {
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31
}

/**
 * Excel serial (or a parseable date string) → 'YYYY-MM-DD'.
 * Returns null when `v` doesn't look like a date at all (caller skips the
 * row). Throws `MalformedDateError` when `v` IS date-shaped (an 8-digit
 * yyyyMMdd number or string) but out of range — that case must never reach
 * the serial-math branch below.
 */
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
      if (compactDateBounds(mm, dd)) {
        return `${compact[1]}-${compact[2]}-${compact[3]}`
      }
      throw new MalformedDateError(v)
    }
  }
  if (typeof v === 'number' && v > 1000) {
    const ms = Math.round((v - 25569) * 86_400_000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const s = String(v ?? '').trim()
  // Toast writes the day key as yyyyMMdd
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) {
    const mm = Number(compact[2])
    const dd = Number(compact[3])
    if (compactDateBounds(mm, dd)) {
      return `${compact[1]}-${compact[2]}-${compact[3]}`
    }
    throw new MalformedDateError(v)
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const d = new Date(s)
  if (isNaN(d.getTime())) return null
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10)
}

/** Runs `toIsoDate`, turning a `MalformedDateError` into a manager-readable message naming the row. */
function readDate(v: unknown, where: string): string | null {
  try {
    return toIsoDate(v)
  } catch (e) {
    if (e instanceof MalformedDateError) {
      throw new Error(`${where}: “${String(v)}” is not a valid date (month or day out of range). Fix the date and re-export.`)
    }
    throw e
  }
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
  /**
   * Rows that had a valid day key but a net-sales figure `num()` could not
   * parse (garbage text, a stray symbol) — excluded from `iso`/`sales`
   * without a trace unless the caller checks this. `row` is the same 1-based
   * spreadsheet row number used in the malformed-date error message, so a
   * manager can jump straight to the cell. An empty array means nothing was
   * skipped.
   */
  unparsedRows: Array<{ row: number; raw: unknown }>
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

  // Optional tips column, located by header text rather than position. Anchored
  // to a whole-header match — an unanchored /tip (amount|total)/ would also
  // match a column explicitly meaning NOT tips (e.g. "Non-tip amount"), and
  // silently feed it into the pool basis.
  const rawHeader = rows[0] ?? []
  const header = rawHeader.map(c => String(c ?? '').trim().toLowerCase())
  const tipHeaderRe = /^(tips?|tip amount|tip total)$/
  const tipMatches = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => tipHeaderRe.test(h))
  if (tipMatches.length > 1) {
    const names = tipMatches.map(({ i }) => `"${String(rawHeader[i] ?? '').trim()}"`).join(', ')
    throw new Error(`“Sales by day” has more than one column that looks like tips (${names}) — rename all but one and re-export.`)
  }
  const tipCol = tipMatches.length ? tipMatches[0].i : -1

  const iso: string[] = []
  const sales: number[] = []
  const tips: number[] = []
  const unparsedRows: Array<{ row: number; raw: unknown }> = []
  for (const [i, r] of rows.slice(1).entries()) {
    const rowNum = i + 2
    const day = readDate(r?.[0], `“Sales by day” row ${rowNum}`)
    if (!day) continue
    const net = num(r?.[1])
    if (isNaN(net)) { unparsedRows.push({ row: rowNum, raw: r?.[1] }); continue }
    iso.push(day)
    sales.push(Math.round(net * 100) / 100)
    if (tipCol >= 0) {
      const t = num(r?.[tipCol])
      tips.push(isNaN(t) ? 0 : Math.round(t * 100) / 100)
    }
  }
  if (!iso.length) {
    throw new Error(unparsedRows.length > 0
      ? `“Sales by day” had no usable rows — ${unparsedRows.length} row(s) had a date but an unreadable net sales figure.`
      : '“Sales by day” had no usable rows.')
  }

  let reportedNet: number | null = null
  const rev = sheetRows(wb, 'Revenue summary')
  if (rev?.[0]) {
    const i = rev[0].findIndex(h => /^net sales$/i.test(String(h ?? '')))
    if (i >= 0) {
      const v = num(rev[1]?.[i])
      if (!isNaN(v)) reportedNet = v
    }
  }

  return { iso, sales, tips: tipCol >= 0 ? tips : null, reportedNet, unparsedRows }
}

export interface ParsedClocks {
  rows: PunchRow[]
  total: number
  peopleCount: number
  /** Punches whose date falls outside the period window. Kept, flagged by the audit. */
  outside: number
  pending: number
  /**
   * Rows that had a Clock ID and a date but an hours figure `num()` could not
   * parse — excluded from `rows` without a trace unless the caller checks
   * this. `row` is the same 1-based spreadsheet row number used in the
   * malformed-date error message. An empty array means nothing was skipped.
   */
  unparsedRows: Array<{ row: number; clockId: string; raw: unknown }>
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
  const unparsedRows: Array<{ row: number; clockId: string; raw: unknown }> = []
  for (const [i, r] of rows.slice(headerIdx + 1).entries()) {
    const first = String(r?.[C.first] ?? '').trim()
    const last = String(r?.[C.last] ?? '').trim()
    const code = String(r?.[C.code] ?? '').trim()
    // A row named "Totals"/"Total" is the export's own footer sum, not a
    // punch — but only when it ALSO carries no identity (no last name, no
    // clock ID), the way every real footer row does. A real employee named
    // "Totals" still has a last name and a clock ID, so this stays a strict
    // subset of the old, unqualified check — never more aggressive.
    if (!first || (/^totals?$/i.test(first) && !last && !code)) continue
    const hours = Math.round(num(r?.[C.hours]) * 100) / 100
    const rowNum = headerIdx + i + 2
    const iso = readDate(r?.[C.dateIn], `Clocks Summary row ${rowNum} (${first}, clock #${code || '—'})`)
    if (!code || !iso) continue
    if (isNaN(hours)) { unparsedRows.push({ row: rowNum, clockId: code, raw: r?.[C.hours] }); continue }
    out.push({
      clockId: code,
      firstName: first,
      lastName: last,
      position: C.pos >= 0 ? String(r?.[C.pos] ?? '').trim() : '',
      department: C.dept >= 0 ? String(r?.[C.dept] ?? '').trim() : '',
      dayIndex: dayIndexOf(startDate, iso),
      hours,
      status: C.status >= 0 ? String(r?.[C.status] ?? 'Approved').trim() || 'Approved' : 'Approved',
      note: C.notes.map(i => r?.[i]).filter(Boolean).join(' · ') || null,
    })
  }
  if (!out.length) {
    throw new Error(unparsedRows.length > 0
      ? `No punches found in that workbook — ${unparsedRows.length} row(s) had a Clock ID and a date but an unreadable hours figure.`
      : 'No punches found in that workbook.')
  }

  return {
    rows: out,
    total: Math.round(out.reduce((a, r) => a + r.hours, 0) * 100) / 100,
    peopleCount: new Set(out.map(r => r.clockId)).size,
    outside: out.filter(r => r.dayIndex < 0 || r.dayIndex >= dayCount).length,
    pending: out.filter(r => !/approved/i.test(r.status)).length,
    unparsedRows,
  }
}
