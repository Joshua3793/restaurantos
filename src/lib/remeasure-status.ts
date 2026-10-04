// HTTP status for each "change how it's measured" refusal code. Pure — kept
// out of the server-only exec module so the routes' mapping is testable with
// the exec mocked.
import { NextResponse } from 'next/server'

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  PREP_OWNED: 409,
  TOMBSTONE: 409,
  OPEN_COUNT: 409,
  STALE: 409,
  UNDO_UNSAFE: 409,
  SAME_MEASURE: 400,
  NEEDS_BRIDGE: 400,
  INVALID: 400,
}

/** `details` (INVALID only): every planner error, when `error` carries the first. */
export function refusalResponse(e: { code: string; message: string; details?: string[] }) {
  return NextResponse.json(
    { error: e.message, code: e.code, ...(e.details?.length ? { details: e.details } : {}) },
    { status: STATUS[e.code] ?? 400 },
  )
}
