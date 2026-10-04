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

export function refusalResponse(e: { code: string; message: string }) {
  return NextResponse.json({ error: e.message, code: e.code }, { status: STATUS[e.code] ?? 400 })
}
