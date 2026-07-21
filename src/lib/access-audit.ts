import 'server-only'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type AccessAction =
  | 'INVITED'
  | 'REINVITED'
  | 'INVITE_REVOKED'
  | 'CLEARANCE_CHANGED'
  | 'ASSIGNMENT_ADDED'
  | 'ASSIGNMENT_REMOVED'
  | 'OVERRIDE_SET'
  | 'OVERRIDE_CLEARED'
  | 'DEACTIVATED'
  | 'REACTIVATED'
  | 'REMOVED'

export interface AuditParty {
  /** null when the row is gone (hard delete) — email/name still identify them. */
  id: string | null
  email: string
  name: string | null
}

export interface AuditDetail {
  from?: string | null
  to?: string | null
  locationId?: string | null
  locationName?: string | null
  rcId?: string | null
  rcName?: string | null
  [k: string]: unknown
}

/** Accepts either the singleton or a transaction client, so audit writes can
 *  ride inside the same transaction as the mutation they describe. */
export type AuditClient = PrismaClient | Prisma.TransactionClient

export async function recordAccessEvent(
  client: AuditClient,
  args: {
    actor: AuditParty
    target: AuditParty
    action: AccessAction
    detail?: AuditDetail
  },
): Promise<void> {
  await client.accessAuditEvent.create({
    data: {
      actorId: args.actor.id,
      actorEmail: args.actor.email,
      actorName: args.actor.name,
      targetUserId: args.target.id,
      targetEmail: args.target.email,
      targetName: args.target.name,
      action: args.action,
      detail: (args.detail ?? {}) as Prisma.InputJsonValue,
    },
  })
}

/** Convenience for routes that are not already inside a transaction. */
export const recordAccessEventStandalone = (
  args: Parameters<typeof recordAccessEvent>[1],
) => recordAccessEvent(prisma, args)
