// Pure: the one-word sign-in status shown for each cook on "Crew sign-in".
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'
import { pinEmail } from '@/lib/pin/rules'

/** Why a cook can never sign in with a PIN, whatever phones they have. */
export type Blocked = 'MANAGER' | 'SWITCHED_OFF' | 'EMAIL_LOGIN'

/**
 * The same refusals the PIN sign-in gives (src/lib/pin/account.ts `admit`):
 * a manager's login, a switched-off login, or a login that is not this cook's
 * own PIN login (an email login — they sign in with email and password).
 * No login yet → null: the first PIN sign-in makes one.
 */
export function pinBlocked(
  cookId: string,
  user: { role: Role; isActive: boolean; email: string } | null,
): Blocked | null {
  if (!user) return null
  if (atLeast(user.role, 'MANAGER')) return 'MANAGER'
  if (!user.isActive) return 'SWITCHED_OFF'
  if (user.email.toLowerCase() !== pinEmail(cookId)) return 'EMAIL_LOGIN'
  return null
}

export type CrewStatus = {
  label: 'SET UP' | 'WAITING' | 'NOT YET' | 'NO PIN' | 'EMAIL LOGIN' | 'SWITCHED OFF'
  tone: 'green' | 'gold' | 'grey' | 'red'
  /** How many phones are approved for this cook. */
  phones: number
}

export function crewStatus(
  cook: { clockId: string | null },
  devices: Array<{ status: string }>,
  blocked: Blocked | null = null,
): CrewStatus {
  const phones = devices.filter((d) => d.status === 'APPROVED').length
  if (blocked === 'MANAGER' || blocked === 'EMAIL_LOGIN') return { label: 'EMAIL LOGIN', tone: 'grey', phones }
  if (blocked === 'SWITCHED_OFF') return { label: 'SWITCHED OFF', tone: 'red', phones }
  if (!cook.clockId) return { label: 'NO PIN', tone: 'red', phones }
  if (devices.some((d) => d.status === 'PENDING')) return { label: 'WAITING', tone: 'gold', phones }
  if (phones > 0) return { label: 'SET UP', tone: 'green', phones }
  return { label: 'NOT YET', tone: 'grey', phones }
}
