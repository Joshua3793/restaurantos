// Pure: the History page's CSV export. No Prisma and no React, so the page builds
// it in the browser from the runs it is showing. Type-only import of RunView:
// runs.ts is server-only, but a type import is erased.
import type { RunView } from './runs'
import { pacificHHMM } from './rules'

/** A run as the History screen reads it: the run plus its station's name and colour. */
export type HistoryRun = RunView & { stationName: string; color: string; isShared: boolean }

const HEADER = [
  'date', 'phase', 'station', 'job', 'status', 'value', 'unit', 'by', 'at', 'flag', 'note', 'signed_by', 'signed_at',
]

/** Quoted only when it holds a comma, a quote or a line break; quotes are doubled. */
function field(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Free text a spreadsheet could run as a formula (=, +, -, @) gets a leading
 * apostrophe, which Excel and Sheets read as "this is text".
 */
function text(v: string | null | undefined): string {
  return v != null && /^[=+\-@]/.test(v) ? `'${v}` : (v ?? '')
}

const time = (iso: string | null): string => (iso ? pacificHHMM(new Date(iso)) : '')

/** One row per line, in the order given. Times are Pacific HH:MM. */
export function historyCsv(runs: HistoryRun[]): string {
  const rows: string[] = [HEADER.join(',')]
  for (const r of runs) {
    for (const l of r.lines) {
      rows.push([
        r.businessDate, r.phase, text(r.stationName), text(l.title), l.status, l.value, l.unit, text(l.doneByName),
        time(l.doneAt), l.flagReason, text(l.flagNote), text(r.signedOffByName), time(r.signedOffAt),
      ].map(field).join(','))
    }
  }
  return rows.join('\n')
}
