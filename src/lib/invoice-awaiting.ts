// Server-only: which invoice sessions belong to a kitchen, and how many are
// waiting for approval. Shared by GET /api/invoices/kpis and the Inbox sync.
import 'server-only'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/**
 * Session-scoped RC filter. A location = its RCs + legacy null-RC sessions.
 * The default RC also sees legacy null-RC sessions; any other RC only its own.
 * No RC and no location = every session.
 */
export function invoiceRcWhere(opts: {
  rcId: string | null
  isDefault: boolean
  locRcIds: string[] | null
}): Prisma.InvoiceSessionWhereInput {
  const { rcId, isDefault, locRcIds } = opts
  return locRcIds
    ? { OR: [{ revenueCenterId: { in: locRcIds } }, { revenueCenterId: null }] }
    : rcId
      ? (isDefault
          ? { OR: [{ revenueCenterId: rcId }, { revenueCenterId: null }] }
          : { revenueCenterId: rcId })
      : {}
}

/** Sessions in REVIEW — read, matched, waiting for someone to approve them. */
export function countInvoicesAwaiting(rcWhere: Prisma.InvoiceSessionWhereInput): Promise<number> {
  return prisma.invoiceSession.count({
    where: { AND: [{ status: 'REVIEW' }, rcWhere] },
  })
}
