// Pure: the one-word sign-in status shown for each cook on "Crew sign-in".
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'
import { isPinEmail, pinEmail } from '@/lib/pin/rules'

/** Why a cook can never sign in with a PIN, whatever phones they have. */
export type Blocked = 'MANAGER' | 'SWITCHED_OFF' | 'MISLINKED'

/**
 * The same refusals the PIN sign-in gives (src/lib/pin/account.ts `admit`):
 * a manager's login, a switched-off login, or another cook's PIN login.
 * A cook with their own email login (below MANAGER) can use their PIN too.
 * No login yet → null: the first PIN sign-in makes one.
 */
export function pinBlocked(
  cookId: string,
  user: { role: Role; isActive: boolean; email: string } | null,
): Blocked | null {
  if (!user) return null
  if (atLeast(user.role, 'MANAGER')) return 'MANAGER'
  if (!user.isActive) return 'SWITCHED_OFF'
  if (isPinEmail(user.email) && user.email.trim().toLowerCase() !== pinEmail(cookId)) return 'MISLINKED'
  return null
}

export type CrewStatus = {
  label: 'SET UP' | 'WAITING' | 'NOT YET' | 'NO PIN' | 'EMAIL LOGIN' | 'SWITCHED OFF' | 'NEEDS FIX'
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
  if (blocked === 'MANAGER') return { label: 'EMAIL LOGIN', tone: 'grey', phones }
  if (blocked === 'MISLINKED') return { label: 'NEEDS FIX', tone: 'red', phones }
  if (blocked === 'SWITCHED_OFF') return { label: 'SWITCHED OFF', tone: 'red', phones }
  if (!cook.clockId) return { label: 'NO PIN', tone: 'red', phones }
  if (devices.some((d) => d.status === 'PENDING')) return { label: 'WAITING', tone: 'gold', phones }
  if (phones > 0) return { label: 'SET UP', tone: 'green', phones }
  return { label: 'NOT YET', tone: 'grey', phones }
}
