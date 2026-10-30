// Pure validation for the checklist editor. No Prisma, no React: the routes use it
// to guard writes and the item sheet runs the same rules before it sends.

import { parseReading } from './rules'

export type Answer = 'TICK' | 'NUMBER' | 'TEMP'

export type ItemData = {
  title: string
  howTo: string | null
  isBlocker: boolean
  answer: Answer
  unit: string | null
  safeMin: number | null
  safeMax: number | null
  tempUnitId: string | null
  days: number
  categoryId: string
}

export type ItemInputResult = { ok: true; data: ItemData } | { ok: false; error: string }

export const TITLE_MAX = 120
export const HOW_TO_MAX = 1000
export const NAME_MAX = 40

/** The 8 station colours. The first is the default. */
export const STATION_COLORS = [
  '#71717a', '#dc2626', '#ca8a04', '#ea580c', '#16a34a', '#db2777', '#0d9488', '#2563eb',
] as const
export const DEFAULT_STATION_COLOR = STATION_COLORS[0]

export function isPaletteColor(c: unknown): c is string {
  return typeof c === 'string' && (STATION_COLORS as readonly string[]).includes(c)
}

/** A station or category name: trimmed, 1–40 characters. */
export function parseName(raw: unknown, error: string): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error }
  const name = raw.trim()
  if (name.length < 1 || name.length > NAME_MAX) return { ok: false, error }
  return { ok: true, name }
}

const BAD_RANGE = Symbol('bad')

/** number | numeric text (comma decimal ok) | empty → number | null; anything else is BAD_RANGE. */
function bound(raw: unknown): number | null | typeof BAD_RANGE {
  if (raw === undefined || raw === null) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : BAD_RANGE
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    const n = parseReading(raw)
    return n === null ? BAD_RANGE : n
  }
  return BAD_RANGE
}

export function parseItemInput(body: unknown): ItemInputResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const title = typeof b.title === 'string' ? b.title.trim() : ''
  if (title.length < 1 || title.length > TITLE_MAX) return { ok: false, error: 'Give the job a name' }

  const howToRaw = typeof b.howTo === 'string' ? b.howTo.trim() : ''
  if (howToRaw.length > HOW_TO_MAX) return { ok: false, error: `Keep the how-to under ${HOW_TO_MAX} characters` }
  const howTo = howToRaw === '' ? null : howToRaw

  const answer = b.answer
  if (answer !== 'TICK' && answer !== 'NUMBER' && answer !== 'TEMP') return { ok: false, error: 'Pick how the cook answers' }

  const days = b.days
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 127) {
    return { ok: false, error: 'Pick at least one day' }
  }

  const categoryId = typeof b.categoryId === 'string' ? b.categoryId : ''
  if (!categoryId) return { ok: false, error: 'Pick a category' }

  let unit: string | null = null
  let safeMin: number | null = null
  let safeMax: number | null = null
  let tempUnitId: string | null = null

  if (answer === 'NUMBER') {
    unit = typeof b.unit === 'string' ? b.unit.trim() : ''
    if (!unit) return { ok: false, error: 'Add a unit, e.g. °C' }
    const lo = bound(b.safeMin)
    const hi = bound(b.safeMax)
    if (lo === BAD_RANGE || hi === BAD_RANGE) return { ok: false, error: 'The safe range must be numbers' }
    if (lo != null && hi != null && lo > hi) return { ok: false, error: 'Safe range is back to front' }
    safeMin = lo
    safeMax = hi
  } else if (answer === 'TEMP') {
    tempUnitId = typeof b.tempUnitId === 'string' && b.tempUnitId ? b.tempUnitId : null
    if (!tempUnitId) return { ok: false, error: 'Pick a fridge or unit' }
  }

  return {
    ok: true,
    data: { title, howTo, isBlocker: b.isBlocker === true, answer, unit, safeMin, safeMax, tempUnitId, days, categoryId },
  }
}
