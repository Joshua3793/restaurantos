// Pure: the one-word sign-in status shown for each cook on "Crew sign-in".
import type { Role } from '@prisma/client'
import { atLeast } from '@/lib/roles'

/** Why a cook can never sign in with a PIN, whatever phones they have. */
export type Blocked = 'MANAGER' | 'SWITCHED_OFF'

/**
 * A manager signs in with email, and a switched-off login can't sign in at
 * all: no phone of theirs is waiting on anyone. A cook with no login yet is
 * not blocked.
 */
export function blockedOf(user: { role: Role; isActive: boolean } | null): Blocked | null {
  if (!user) return null
  if (atLeast(user.role, 'MANAGER')) return 'MANAGER'
  return user.isActive ? null : 'SWITCHED_OFF'
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
  if (blocked === 'MANAGER') return { label: 'EMAIL LOGIN', tone: 'grey', phones }
  if (blocked === 'SWITCHED_OFF') return { label: 'SWITCHED OFF', tone: 'red', phones }
  if (!cook.clockId) return { label: 'NO PIN', tone: 'red', phones }
  if (devices.some((d) => d.status === 'PENDING')) return { label: 'WAITING', tone: 'gold', phones }
  if (phones > 0) return { label: 'SET UP', tone: 'green', phones }
  return { label: 'NOT YET', tone: 'grey', phones }
}
