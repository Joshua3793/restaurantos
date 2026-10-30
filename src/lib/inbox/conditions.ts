// Pure: what the app itself would file in the Inbox right now, from rows the
// system sync has already read. One Condition per live alert, keyed so the
// same alert always lands on the same item (see the spec's "Where items come
// from" table). No Prisma, no React — the sync in ./system.ts does the I/O.
import type { Severity } from '@/lib/inbox/rules'
import type { Phase } from '@/lib/checklists/rules'
import { PENDING_MAX_AGE_MS } from '@/lib/pin/rules'
import {
  tempNeeds, unattendedCriticalPrep, prepNeed, invoiceNeed, countNeed,
  type StartTempUnit, type StartPrepItem,
} from '@/lib/start-page'

export type BuiltInTag = 'FOOD_SAFETY' | 'CHECKLISTS' | 'PREP' | 'STOCK' | 'MONEY' | 'TEAM'

export type Condition = {
  sourceKey: string
  tagBuiltIn: BuiltInTag
  severity: Severity
  title: string
  body?: string | null
  place?: string | null
  href: string
  managerOnly: boolean
  /** null = every kitchen (shared units, shared prep, price rises, phones). */
  revenueCenterId: string | null
}

/** Each kind of system alert; the sourceKey starts with `<family>:`. */
export const FAMILIES = [
  'temp-bad', 'temp-missing', 'station-open', 'close-unsigned', 'prep',
  'price', 'invoices', 'count-stale', 'phone',
] as const
export type Family = (typeof FAMILIES)[number]

/** Whole-house alerts: one item for every kitchen, never tied to an RC. */
const GLOBAL: ReadonlySet<Family> = new Set<Family>(['price', 'phone'])
/** Kitchen alerts that may also sit on a shared (null-RC) unit or prep item. */
const SHARED_OK: ReadonlySet<Family> = new Set<Family>(['temp-bad', 'prep'])

export function familyOf(sourceKey: string | null): Family | null {
  if (!sourceKey) return null
  const head = sourceKey.slice(0, sourceKey.indexOf(':'))
  return (FAMILIES as readonly string[]).includes(head) ? (head as Family) : null
}

// ── Inputs ──────────────────────────────────────────────────────────────────
// Each source is optional: undefined means it was not loaded (or its loader
// failed), so it raises nothing and — via loadedFamilies — clears nothing.

export type TempUnitIn = StartTempUnit & { revenueCenterId: string | null }
export type PrepItemIn = StartPrepItem & { revenueCenterId: string | null }

export type StationIn = {
  id: string
  name: string
  revenueCenterId: string
  hasRun: boolean
  /** Jobs that would apply today (only read when there is no run). */
  jobCount: number
}

export type CloseRunIn = {
  id: string
  stationName: string
  revenueCenterId: string
  businessDate: string
}

export type PriceAlertIn = {
  id: string
  changePct: number | string
  direction: string
  itemName: string | null
  supplierName: string | null
}

export type PhoneIn = {
  id: string
  name: string
  pairCode: string
  status: string
  createdAt: Date | string
  /** Manager, switched-off login or switched-off cook: can never sign in. */
  blocked: boolean
}

export type ConditionsInput = {
  rcId: string | null
  now: Date
  /** Pacific 'YYYY-MM-DD' — the day in daily keys. */
  date: string
  temps?: TempUnitIn[]
  stations?: { phase: Phase; businessDate: string; list: StationIn[] }
  closeRuns?: CloseRunIn[]
  /** Run ids of open close-unsigned items whose run is still unsigned but has left the window. */
  closeAged?: string[]
  prep?: PrepItemIn[]
  priceAlerts?: PriceAlertIn[]
  invoices?: { awaiting: number }
  /** days null = never counted. */
  count?: { days: number | null }
  phones?: PhoneIn[]
}

// ── Collectors, one per source ──────────────────────────────────────────────

const TEMP_BAD_ID = 'temp-bad-'

function tempConditions(input: ConditionsInput, units: TempUnitIn[]): Condition[] {
  const out: Condition[] = []
  const byId = new Map(units.map(u => [u.id, u]))
  for (const need of tempNeeds(units)) {
    if (need.id.startsWith(TEMP_BAD_ID)) {
      const unit = byId.get(need.id.slice(TEMP_BAD_ID.length))
      if (!unit) continue
      out.push({
        sourceKey: `temp-bad:${unit.id}:${input.date}`,
        tagBuiltIn: 'FOOD_SAFETY',
        severity: 'NOW',
        title: need.title,
        body: need.detail,
        place: unit.name,
        href: '/temps',
        managerOnly: false,
        revenueCenterId: unit.revenueCenterId,
      })
    } else if (need.id === 'temp-missing' && input.rcId) {
      out.push({
        sourceKey: `temp-missing:${input.rcId}:${input.date}`,
        tagBuiltIn: 'FOOD_SAFETY',
        severity: 'NOW',
        title: need.title,
        body: need.detail,
        href: '/temps',
        managerOnly: false,
        revenueCenterId: input.rcId,
      })
    }
  }
  return out
}

function stationConditions(s: NonNullable<ConditionsInput['stations']>): Condition[] {
  if (s.phase !== 'OPEN') return []
  return s.list
    .filter(st => !st.hasRun && st.jobCount > 0)
    .map(st => ({
      sourceKey: `station-open:${st.id}:${s.businessDate}`,
      tagBuiltIn: 'CHECKLISTS' as const,
      severity: 'NOW' as const,
      title: `${st.name} hasn't started opening`,
      body: `${st.jobCount} ${st.jobCount === 1 ? 'job' : 'jobs'} on today's opening list`,
      place: st.name,
      href: '/checklist/today',
      managerOnly: false,
      revenueCenterId: st.revenueCenterId,
    }))
}

/** '2026-10-29' → 'Thu 29 Oct' (read as a calendar day, no timezone drift). */
function dayLabel(ymd: string): string {
  const d = new Date(ymd + 'T12:00:00Z')
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })
  const dm = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${wd} ${dm}`
}

function closeConditions(runs: CloseRunIn[]): Condition[] {
  return runs.map(r => ({
    sourceKey: `close-unsigned:${r.id}`,
    tagBuiltIn: 'CHECKLISTS' as const,
    severity: 'TODAY' as const,
    title: `${r.stationName} closing wasn't signed off`,
    body: `Closing list for ${dayLabel(r.businessDate)}`,
    place: r.stationName,
    href: '/checklist/today',
    managerOnly: false,
    revenueCenterId: r.revenueCenterId,
  }))
}

function prepConditions(input: ConditionsInput, items: PrepItemIn[]): Condition[] {
  return unattendedCriticalPrep(items).map(i => {
    const need = prepNeed(i, null)
    return {
      sourceKey: `prep:${i.id}:${input.date}`,
      tagBuiltIn: 'PREP' as const,
      severity: 'NOW' as const,
      title: need.title,
      body: need.detail,
      href: '/prep',
      managerOnly: false,
      revenueCenterId: (i as PrepItemIn).revenueCenterId,
    }
  })
}

function priceConditions(alerts: PriceAlertIn[]): Condition[] {
  return alerts
    .filter(a => a.direction === 'UP' && a.itemName)
    .map(a => {
      const pct = Math.round(Number(a.changePct))
      return {
        sourceKey: `price:${a.id}`,
        tagBuiltIn: 'MONEY' as const,
        severity: 'TODAY' as const,
        title: `${a.itemName} up ${pct}%${a.supplierName ? ` at ${a.supplierName}` : ''}`,
        body: 'Check the dishes that use it',
        href: '/invoices',
        managerOnly: true,
        revenueCenterId: null,
      }
    })
}

function invoiceConditions(rcId: string, awaiting: number): Condition[] {
  const need = invoiceNeed(awaiting)
  if (!need) return []
  return [{
    sourceKey: `invoices:${rcId}`,
    tagBuiltIn: 'MONEY',
    severity: 'TODAY',
    title: need.title,
    body: need.detail,
    href: '/invoices',
    managerOnly: true,
    revenueCenterId: rcId,
  }]
}

function countConditions(rcId: string, days: number | null): Condition[] {
  const need = countNeed(days)
  if (!need) return []
  return [{
    sourceKey: `count-stale:${rcId}`,
    tagBuiltIn: 'STOCK',
    severity: 'FYI',
    title: need.title,
    body: need.detail,
    href: '/count',
    managerOnly: false,
    revenueCenterId: rcId,
  }]
}

function phoneConditions(now: Date, phones: PhoneIn[]): Condition[] {
  const staleBefore = now.getTime() - PENDING_MAX_AGE_MS
  return phones
    .filter(p => p.status === 'PENDING' && !p.blocked && new Date(p.createdAt).getTime() >= staleBefore)
    .map(p => ({
      sourceKey: `phone:${p.id}`,
      tagBuiltIn: 'TEAM' as const,
      severity: 'TODAY' as const,
      title: `${p.name}'s phone wants your OK`,
      body: `Code ${p.pairCode}`,
      href: '/checklist/crew',
      managerOnly: true,
      revenueCenterId: null,
    }))
}

/** Every live system alert for this sync. Keys are unique (first one wins). */
export function collectConditions(input: ConditionsInput): Condition[] {
  const all: Condition[] = []
  if (input.temps) all.push(...tempConditions(input, input.temps))
  if (input.stations) all.push(...stationConditions(input.stations))
  if (input.closeRuns) all.push(...closeConditions(input.closeRuns))
  if (input.prep) all.push(...prepConditions(input, input.prep))
  if (input.priceAlerts) all.push(...priceConditions(input.priceAlerts))
  if (input.rcId && input.invoices) all.push(...invoiceConditions(input.rcId, input.invoices.awaiting))
  if (input.rcId && input.count) all.push(...countConditions(input.rcId, input.count.days))
  if (input.phones) all.push(...phoneConditions(input.now, input.phones))
  const seen = new Set<string>()
  return all.filter(c => (seen.has(c.sourceKey) ? false : (seen.add(c.sourceKey), true)))
}

/** The families this sync actually read — only these may clear items. */
export function loadedFamilies(input: ConditionsInput): Set<Family> {
  const f = new Set<Family>()
  if (input.temps) {
    f.add('temp-bad')
    if (input.rcId) f.add('temp-missing')
  }
  if (input.stations && input.rcId) f.add('station-open')
  if (input.closeRuns && input.rcId) f.add('close-unsigned')
  if (input.prep) f.add('prep')
  if (input.priceAlerts) f.add('price')
  if (input.invoices && input.rcId) f.add('invoices')
  if (input.count && input.rcId) f.add('count-stale')
  if (input.phones) f.add('phone')
  return f
}

/**
 * May this sync clear the item when its condition is absent? Only for a
 * family it read, and only for its own kitchen — never another RC's item.
 * Whole-house families (price, phone) are judged by their global condition;
 * shared temp units and shared prep (null RC) are read by every kitchen's sync.
 */
export function ownsItem(
  item: { sourceKey: string | null; revenueCenterId: string | null },
  rcId: string | null,
  loaded: Set<Family>,
): boolean {
  const family = familyOf(item.sourceKey)
  if (!family || !loaded.has(family)) return false
  if (GLOBAL.has(family)) return true
  if (item.revenueCenterId == null) return SHARED_OK.has(family)
  return rcId != null && item.revenueCenterId === rcId
}

// ── Why an item cleared ─────────────────────────────────────────────────────

export const CLEAR_NOTES = {
  resolved: 'Cleared itself',
  openingEnded: 'Opening window ended — never started',
  dayEnded: 'Day ended — not fixed',
  closeAged: 'Older than 2 days — never signed',
} as const

/** The 'YYYY-MM-DD' a daily key ends with, or null for an undated key. */
export function keyDate(sourceKey: string): string | null {
  const last = sourceKey.slice(sourceKey.lastIndexOf(':') + 1)
  return /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null
}

/**
 * The CLEARED note for an owned item whose condition is absent. "Cleared
 * itself" only when the problem genuinely went away; an expiry says so.
 */
export function clearNote(sourceKey: string, input: ConditionsInput): string {
  const family = familyOf(sourceKey)
  const date = keyDate(sourceKey)
  if (date && date < input.date) return CLEAR_NOTES.dayEnded
  if (family === 'station-open' && input.stations && input.stations.phase !== 'OPEN') {
    return CLEAR_NOTES.openingEnded
  }
  if (family === 'close-unsigned' && input.closeAged?.includes(sourceKey.slice('close-unsigned:'.length))) {
    return CLEAR_NOTES.closeAged
  }
  return CLEAR_NOTES.resolved
}
