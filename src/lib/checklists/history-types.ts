// Shapes of GET /api/checklists/history, shared by the route and the page. Pure.
import type { HistoryRun } from './history-csv'

export type HistoryDay = { date: string; state: 'ok' | 'miss' | 'none' }

export type HistoryView = {
  date: string
  /** The 7 dates ending at `date`, oldest first. */
  days: HistoryDay[]
  runs: HistoryRun[]
  /** The kitchen's active stations, in setup order, for the station filter. */
  stations: { id: string; name: string }[]
}

export type HistoryPeople = { people: { userId: string; name: string }[] }

/** What the cook's log sheet shows under LAST TIME. */
export type LastReading = { value: number; unit: string | null; byName: string | null; at: string }
