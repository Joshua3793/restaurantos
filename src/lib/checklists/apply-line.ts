// Pure: decides the new state of one run line from a cook's action.
// No Prisma, no React. The route turns `data` into a Prisma update.
import { inRange, parseReading } from './rules'
import { cleanPhotoUrl } from '@/lib/photo-url'

export type LineAction =
  | { action: 'tick' }
  | { action: 'untick' }
  | { action: 'value'; raw: string }
  /** `photoUrl`: an already-uploaded photo of the problem (UploadThing link), optional. */
  | { action: 'flag'; reason: 'BROKEN' | 'RAN_OUT' | 'OTHER'; note?: string; photoUrl?: string | null }

export type LineInput = {
  answer: 'TICK' | 'NUMBER' | 'TEMP'
  safeMin: number | null
  safeMax: number | null
}

/** Prisma update data for ChecklistRunLine. Every action sets `value`: a new answer replaces the old reading. */
export type LinePatch = {
  status: 'TODO' | 'DONE' | 'FLAGGED'
  value: number | null
  doneById: string | null
  doneByName: string | null
  doneAt: Date | null
  flagReason: 'BROKEN' | 'RAN_OUT' | 'OUT_OF_RANGE' | 'OTHER' | null
  flagNote: string | null
  /** Photo of the problem; only a manual flag carries one — every other answer clears it. */
  flagPhotoUrl: string | null
  resolvedById: null
  resolvedByName: null
  resolvedAt: null
}

export type ApplyResult = { data: LinePatch } | { error: string; status: 400 }

export const NOTE_MAX = 300
const FLAG_REASONS = ['BROKEN', 'RAN_OUT', 'OTHER']

// Any new answer wipes a previous "marked fixed".
const UNRESOLVED = { resolvedById: null, resolvedByName: null, resolvedAt: null } as const

export function applyLine(
  line: LineInput,
  input: LineAction,
  who: { id: string; name: string },
  now: Date,
): ApplyResult {
  const done = { doneById: who.id, doneByName: who.name, doneAt: now }

  switch (input?.action) {
    case 'tick':
      if (line.answer !== 'TICK') return { error: 'Enter a reading', status: 400 }
      return { data: { status: 'DONE', value: null, ...done, flagReason: null, flagNote: null, flagPhotoUrl: null, ...UNRESOLVED } }

    case 'untick':
      return {
        data: {
          status: 'TODO', value: null,
          doneById: null, doneByName: null, doneAt: null,
          flagReason: null, flagNote: null, flagPhotoUrl: null, ...UNRESOLVED,
        },
      }

    case 'value': {
      if (line.answer === 'TICK') return { error: 'This job has no reading', status: 400 }
      const value = typeof input.raw === 'string' ? parseReading(input.raw) : null
      if (value == null) return { error: 'Enter a number', status: 400 }
      const ok = inRange(value, line.safeMin, line.safeMax)
      return {
        data: {
          status: ok ? 'DONE' : 'FLAGGED', value, ...done,
          flagReason: ok ? null : 'OUT_OF_RANGE', flagNote: null, flagPhotoUrl: null, ...UNRESOLVED,
        },
      }
    }

    case 'flag': {
      if (!FLAG_REASONS.includes(input.reason as string)) return { error: 'Pick a reason', status: 400 }
      const note = typeof input.note === 'string' ? input.note.trim() : ''
      if (note.length > NOTE_MAX) return { error: `Note is too long (${NOTE_MAX} characters max)`, status: 400 }
      return {
        data: {
          status: 'FLAGGED', value: null, ...done, flagReason: input.reason, flagNote: note || null,
          // A link that is not an UploadThing file is dropped; the flag still saves.
          flagPhotoUrl: cleanPhotoUrl(input.photoUrl),
          ...UNRESOLVED,
        },
      }
    }

    default:
      return { error: 'Unknown action', status: 400 }
  }
}
