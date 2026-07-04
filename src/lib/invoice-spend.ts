// src/lib/invoice-spend.ts
import { prisma } from '@/lib/prisma'

export interface RcSpendResult {
  /** rcId -> total amount paid attributed to that RC in the window */
  byRc: Map<string, number>
  /** rcId -> number of parent invoices that contributed any spend to that RC */
  invoiceCountByRc: Map<string, number>
  /** total parent invoices in the window (distinct) */
  totalInvoices: number
  defaultRcId: string | null
}

/**
 * Canonical "amount paid" per revenue center for APPROVED invoices in [start, end),
 * windowed by the invoice's own date (session.purchaseDate — see
 * src/lib/purchase-date.ts), NOT the day it was approved.
 *
 * Attribution rules (RC-split design — keep every reader in sync with these):
 *  - Each line's printed total (rawLineTotal) is attributed to that line's effective
 *    RC: `line.revenueCenterId ?? the invoice's active (session) RC`.
 *  - SKIP / PENDING lines: price isn't written, but the money was still paid, so the
 *    line total is attributed to the DEFAULT RC.
 *  - The invoice "extra" (grand total − Σ line totals = tax, fees, deposits, rounding)
 *    is attributed to the invoice's active (session) RC.
 *
 * Only parent invoices (`parentSessionId = null`) are read. Per-RC clone sessions are
 * intentionally ignored: the parent retains every original line (split lines included,
 * each carrying its own `revenueCenterId`), so each line is counted exactly once by its
 * own effective RC and there is no double-count with the clones.
 */
export async function invoiceSpendByRc(start: Date, end: Date): Promise<RcSpendResult> {
  const [defaultRc, sessions] = await Promise.all([
    prisma.revenueCenter.findFirst({ where: { isDefault: true }, select: { id: true } }),
    prisma.invoiceSession.findMany({
      where: { status: 'APPROVED', parentSessionId: null, purchaseDate: { gte: start, lt: end } },
      select: {
        revenueCenterId: true,
        total: true,
        scanItems: { select: { action: true, rawLineTotal: true, revenueCenterId: true } },
      },
    }),
  ])
  const defaultRcId = defaultRc?.id ?? null

  const byRc = new Map<string, number>()
  const invoiceCountByRc = new Map<string, number>()
  const add = (rcId: string | null, amt: number) => {
    if (!rcId || !Number.isFinite(amt) || amt === 0) return
    byRc.set(rcId, (byRc.get(rcId) ?? 0) + amt)
  }

  for (const s of sessions) {
    const activeRc = s.revenueCenterId ?? defaultRcId
    const touched = new Set<string>()
    let subtotal = 0
    for (const line of s.scanItems) {
      const amt = Number(line.rawLineTotal ?? 0)
      subtotal += amt
      const unresolved = line.action === 'SKIP' || line.action === 'PENDING'
      const rc = unresolved ? defaultRcId : (line.revenueCenterId ?? activeRc)
      add(rc, amt)
      if (rc && amt !== 0) touched.add(rc)
    }
    // Extra (tax / fees / deposits / rounding) → the invoice's active RC.
    const extra = s.total != null ? Number(s.total) - subtotal : 0
    if (extra !== 0) {
      add(activeRc, extra)
      if (activeRc) touched.add(activeRc)
    }
    for (const rc of touched) {
      invoiceCountByRc.set(rc, (invoiceCountByRc.get(rc) ?? 0) + 1)
    }
  }

  return { byRc, invoiceCountByRc, totalInvoices: sessions.length, defaultRcId }
}
