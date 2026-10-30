import { describe, it, expect } from 'vitest'
import { historyCsv, type HistoryRun } from '@/lib/checklists/history-csv'
import type { LineView } from '@/lib/checklists/runs'

const line = (over: Partial<LineView>): LineView => ({
  id: 'l1', runId: 'r1', itemId: 'i1', categoryName: 'Close', title: 'Grill off', howTo: null, isBlocker: false,
  answer: 'TICK', unit: null, safeMin: null, safeMax: null, tempUnitId: null, sortOrder: 1,
  status: 'TODO', value: null, doneById: null, doneByName: null, doneAt: null,
  flagReason: null, flagNote: null, resolvedById: null, resolvedByName: null, resolvedAt: null,
  ...over,
})

const run = (over: Partial<HistoryRun> = {}): HistoryRun => ({
  id: 'r1', stationId: 's1', phase: 'CLOSE', businessDate: '2026-10-28', status: 'SIGNED',
  signedOffByName: 'Leo', signedOffAt: '2026-10-29T05:48:00.000Z', // 22:48 Pacific (PDT)
  handoverNote: null, lines: [], crew: [],
  stationName: 'Grill', color: '#dc2626', isShared: false,
  ...over,
})

const HEADER = 'date,phase,station,job,status,value,unit,by,at,flag,note,signed_by,signed_at'

describe('historyCsv', () => {
  it('has the exact header and nothing else for no runs', () => {
    expect(historyCsv([])).toBe(HEADER)
  })

  it('writes one row per line with Pacific HH:MM times and run sign-off columns', () => {
    const csv = historyCsv([run({
      lines: [line({ status: 'DONE', doneByName: 'Leo', doneAt: '2026-10-29T05:14:00.000Z' })],
    })])
    expect(csv.split('\n')).toEqual([
      HEADER,
      '2026-10-28,CLOSE,Grill,Grill off,DONE,,,Leo,22:14,,,Leo,22:48',
    ])
  })

  it('quotes fields with a comma, a quote or a newline', () => {
    const csv = historyCsv([run({
      lines: [line({
        title: 'Say "hi"', status: 'FLAGGED', doneByName: 'Leo', doneAt: '2026-10-29T05:35:00.000Z',
        flagReason: 'OTHER', flagNote: 'Low on brioche, 1 case left',
      }), line({ id: 'l2', title: 'Two\nlines' })],
    })])
    expect(csv).toContain('"Low on brioche, 1 case left"')
    expect(csv).toContain('"Say ""hi"""')
    expect(csv).toContain('"Two\nlines"')
  })

  it('a flagged reading carries OUT_OF_RANGE, the value and the unit', () => {
    const csv = historyCsv([run({
      lines: [line({
        title: 'Lowboy temp', answer: 'TEMP', unit: '°C', status: 'FLAGGED', value: 9.5,
        doneByName: 'Leo', doneAt: '2026-10-29T05:20:00.000Z', flagReason: 'OUT_OF_RANGE',
      })],
    })])
    expect(csv.split('\n')[1]).toBe('2026-10-28,CLOSE,Grill,Lowboy temp,FLAGGED,9.5,°C,Leo,22:20,OUT_OF_RANGE,,Leo,22:48')
  })

  it('leaves signed columns empty for an unsigned run and times empty for untouched lines', () => {
    const csv = historyCsv([run({ status: 'OPEN', signedOffByName: null, signedOffAt: null, lines: [line({})] })])
    expect(csv.split('\n')[1]).toBe('2026-10-28,CLOSE,Grill,Grill off,TODO,,,,,,,,')
  })

  it('defuses spreadsheet formulas in free text, and only there', () => {
    const csv = historyCsv([run({
      stationName: '@Grill', signedOffByName: '+Leo',
      lines: [line({
        title: '-bad', status: 'FLAGGED', value: -4, doneByName: '=Leo', doneAt: '2026-10-29T05:35:00.000Z',
        flagReason: 'OTHER', flagNote: '=HYPERLINK("x")',
      })],
    })])
    expect(csv).toContain('"\'=HYPERLINK(""x"")"')
    expect(csv.split('\n')[1]).toBe(
      "2026-10-28,CLOSE,'@Grill,'-bad,FLAGGED,-4,,'=Leo,22:35,OTHER,\"'=HYPERLINK(\"\"x\"\")\",'+Leo,22:48",
    )
  })
})
