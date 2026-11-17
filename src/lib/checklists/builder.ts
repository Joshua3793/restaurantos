// Pure helpers for the list builder (/checklist/edit): how many lists carry a
// shared job, the "ready by" time of a list, the cook preview and the tidy-up
// suggestions. No Prisma, no React.

import { EVERY_DAY, shiftMinutes, type Phase } from './rules'
import { snapshotLines, type LineCreate } from './snapshot'
import { chipOrder, type EditItem, type EditStation, type EditView } from './edit-format'

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** linkId → the stations that carry it, per phase. */
export function linkStations(view: EditView, phase: Phase): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of view.stations) {
    for (const c of s.phases[phase]) {
      for (const it of c.items) {
        if (!it.linkId) continue
        const list = out.get(it.linkId) ?? []
        if (!list.includes(s.id)) list.push(s.id)
        out.set(it.linkId, list)
      }
    }
  }
  return out
}

/** The station ids a job sits on (itself first, then the other copies). */
export function listsOf(links: Map<string, string[]>, item: EditItem, ownStationId: string): string[] {
  const others = item.linkId ? (links.get(item.linkId) ?? []).filter(id => id !== ownStationId) : []
  return [ownStationId, ...others]
}

/** The latest due time on a list ("ready by"), in shift order; null when no job has one. */
export function readyBy(station: Pick<EditStation, 'phases'>, phase: Phase): string | null {
  let best: string | null = null
  for (const c of station.phases[phase]) {
    for (const it of c.items) {
      if (it.dueBy && (!best || shiftMinutes(it.dueBy) > shiftMinutes(best))) best = it.dueBy
    }
  }
  return best
}

// 2024-01-01 was a Monday: day i (0 = Monday) of that week.
const PREVIEW_WEEK = ['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-07']

/** Monday = 0 … Sunday = 6, for a JS Date in the restaurant's week. */
export function weekdayIndex(d: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(d)
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name)
}

/**
 * What a cook's list would hold on weekday `day` (0 = Monday): the same
 * snapshot rule the shift uses, run over the builder's copy of the list.
 */
export function previewList(
  station: Pick<EditStation, 'phases'>,
  phase: Phase,
  day: number,
  tempRange: (tempUnitId: string | null) => { safeMin: number | null; safeMax: number | null } | null,
): { lines: LineCreate[]; hidden: number } {
  const cats = station.phases[phase].map((c, ci) => ({
    name: c.name,
    sortOrder: ci,
    isActive: true,
    items: c.items.map((it, ii) => ({ ...it, sortOrder: ii, isActive: true, tempUnit: tempRange(it.tempUnitId) })),
  }))
  const total = cats.reduce((n, c) => n + c.items.length, 0)
  const lines = snapshotLines('preview', cats, PREVIEW_WEEK[Math.min(6, Math.max(0, day))])
  return { lines, hidden: total - lines.length }
}

// ── Tidy-up ───────────────────────────────────────────────────────────────

export type TidyUp =
  | { kind: 'share'; key: string; phase: Phase; title: string; stations: string[]; itemIds: string[] }
  | { kind: 'must'; key: string; phase: Phase; stationId: string; station: string; must: number; total: number }
  | { kind: 'merge'; key: string; phase: Phase; stationId: string; station: string; name: string; fromId: string; intoId: string }

const MUST_SHARE = 0.75
const MUST_MIN_JOBS = 4

/** "Alpha, Benny and Grill" */
export function andList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Suggestions for a kitchen's lists, most useful first:
 *  - share: the same job (same name and answer; a temperature on the same fridge)
 *    sits on 2+ lists of one phase as separate copies — share it, done once;
 *  - merge: one list has two categories of the same name;
 *  - must: most of a list (75 %+, 4+ jobs) is must-do, so must-do stops meaning much.
 * `dismissed` keys are left out.
 */
export function tidyUps(view: EditView, dismissed: ReadonlySet<string> = new Set()): TidyUp[] {
  const stations = chipOrder(view.stations)
  const out: TidyUp[] = []

  for (const phase of ['OPEN', 'CLOSE'] as Phase[]) {
    // share
    const groups = new Map<string, { title: string; hits: { station: EditStation; item: EditItem }[] }>()
    for (const s of stations) {
      for (const c of s.phases[phase]) {
        for (const it of c.items) {
          const key = [norm(it.title), it.answer, it.answer === 'TEMP' ? it.tempUnitId ?? '' : ''].join('|')
          const g = groups.get(key) ?? { title: it.title, hits: [] }
          if (!g.hits.some(h => h.station.id === s.id)) g.hits.push({ station: s, item: it })
          groups.set(key, g)
        }
      }
    }
    groups.forEach((g, gkey) => {
      if (g.hits.length < 2) return
      const links = new Set(g.hits.map(h => h.item.linkId))
      if (links.size === 1 && !links.has(null)) return // already one shared job
      const key = `share:${phase}:${gkey}`
      if (dismissed.has(key)) return
      out.push({
        kind: 'share', key, phase, title: g.title,
        stations: g.hits.map(h => h.station.name),
        itemIds: g.hits.map(h => h.item.id),
      })
    })

    // merge
    for (const s of stations) {
      const seen = new Map<string, string>()
      for (const c of s.phases[phase]) {
        const n = norm(c.name)
        const first = seen.get(n)
        if (!first) { seen.set(n, c.id); continue }
        const key = `merge:${phase}:${c.id}`
        if (dismissed.has(key)) continue
        out.push({ kind: 'merge', key, phase, stationId: s.id, station: s.name, name: c.name, fromId: c.id, intoId: first })
      }
    }

    // must
    for (const s of stations) {
      const items = s.phases[phase].flatMap(c => c.items)
      const must = items.filter(i => i.isBlocker).length
      if (items.length < MUST_MIN_JOBS || must / items.length < MUST_SHARE) continue
      const key = `must:${phase}:${s.id}`
      if (dismissed.has(key)) continue
      out.push({ kind: 'must', key, phase, stationId: s.id, station: s.name, must, total: items.length })
    }
  }

  const rank = { share: 0, merge: 1, must: 2 } as const
  return out.sort((a, b) => rank[a.kind] - rank[b.kind])
}

/** "Opening" / "Closing" */
export const phaseWord = (p: Phase) => (p === 'OPEN' ? 'Opening' : 'Closing')

/** An item ready for the job form: every day unless told otherwise. */
export const NEW_DAYS = EVERY_DAY
