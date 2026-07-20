/**
 * Write-path validators for Service rows. Pure — no DB, no next/server — so both
 * `/api/services` and `/api/services/[id]` can share them without one route module
 * importing the other's export surface, and so they are directly testable.
 */

/** Range-checks a minute-of-day. `field` names the offending field in the message. */
export function validateTimeMinutes(value: unknown, field = 'timeMinutes'): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1439) {
    return `${field} must be an integer between 0 and 1439`
  }
  return null
}

/**
 * A zero-length window passes the range check but is silently broken:
 * `currentService()` (src/lib/service-hours.ts) tests `now >= start && now < end`,
 * which is unsatisfiable when start === end — the service would never once report
 * as underway. Reject it on write rather than store a row that can never fire.
 *
 * `end < start` is legal: that is the midnight-crossing case.
 */
export function validateSpan(timeMinutes: unknown, endMinutes: unknown): string | null {
  if (typeof timeMinutes === 'number' && typeof endMinutes === 'number' && timeMinutes === endMinutes) {
    return 'endMinutes must differ from timeMinutes — a zero-length service window is ambiguous'
  }
  return null
}
