'use client'
// Phone quick check — what a cook sees first when they open an invoice on a
// phone: who it's from, the total, and each line with a plain ✓ or "needs a
// look". The full review drawer is one tap away ("Open full review"); lines
// whose fix needs the big screen (linking, a new product, a case size) say
// "Finish on a computer". Read-only: nothing here writes.
//
// The line verdict reads the SAME `lineReasons` the review drawer's attention
// list and Approve gate read, with no acknowledgements — so a line the drawer
// would put under "Needs attention" is never shown here as clean.

import { useEffect, useMemo, useState } from 'react'
import { X, Check, AlertTriangle, Loader2, Monitor } from 'lucide-react'
import type { Session, ScanItem } from '@/components/invoices/types'
import { lineReasons, isCharge, type SupplierRef } from '@/lib/invoice/resolution'
import { derivePricingMode } from '@/lib/invoice/predicates'
import { formatCurrency } from '@/lib/invoice/formatters'
import type { IssueKind } from '@/components/invoices/v2/atoms'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'

/** Fixes that need the full review on a big screen: linking a line to an item,
 *  setting up a new product, a case size / unit bridge, a dimension conflict,
 *  a revenue-center split. */
const COMPUTER_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>(['sku', 'conflict', 'bridge', 'blocked', 'rcsplit'])

type Verdict = 'ok' | 'look' | 'computer' | 'skipped'

interface QuickLine {
  id: string
  name: string
  qty: string
  total: number | null
  verdict: Verdict
  reason: string | null
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const fmtQty = (n: number) => String(Math.round(n * 1000) / 1000)

function quickLine(item: ScanItem, ref: SupplierRef): QuickLine {
  const name = item.matchedItem?.itemName ?? item.rawDescription ?? 'Line'
  const perWeight = derivePricingMode(item) === 'per_weight'
  const q = perWeight ? num(item.totalQty) : num(item.rawQty)
  const u = perWeight ? item.totalQtyUOM : item.rawUnit
  const qty = q != null ? [fmtQty(q), u].filter(Boolean).join(' ') : ''
  const total = num(item.rawLineTotal)
  if (isCharge(item)) return { id: item.id, name, qty, total, verdict: 'skipped', reason: null }
  const open = lineReasons(item, { priceAck: false, confAck: false }, ref).filter(r => !r.resolved)
  if (open.length === 0) return { id: item.id, name, qty, total, verdict: 'ok', reason: null }
  const computer = open.find(r => COMPUTER_KINDS.has(r.kind))
  return {
    id: item.id, name, qty, total,
    verdict: computer ? 'computer' : 'look',
    reason: (computer ?? open[0]).title,
  }
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null
  // invoiceDate is a calendar day stored at UTC midnight — read it in UTC.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function QuickCheckSheet({ sessionId, onClose, onOpenFull }: {
  sessionId: string | null
  onClose: () => void
  onOpenFull: (id: string) => void
}) {
  const { role } = useUser()
  // Default-deny while /api/me is in flight.
  const showMoney = role !== null && atLeast(role, 'LEAD')
  const mayApprove = role !== null && atLeast(role, 'MANAGER')

  const [session, setSession] = useState<Session | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!sessionId) { setSession(null); setFailed(false); return }
    let cancelled = false
    setSession(null); setFailed(false)
    fetch(`/api/invoices/sessions/${sessionId}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: Session) => { if (!cancelled) setSession(data) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [sessionId])

  // Lock the page behind the sheet (the scroll container is <html>).
  useEffect(() => {
    if (!sessionId) return
    const html = document.documentElement
    const prev = html.style.overflow
    html.style.overflow = 'hidden'
    return () => { html.style.overflow = prev }
  }, [sessionId])

  const lines = useMemo(() => {
    if (!session) return []
    const ref: SupplierRef = {
      supplierId: session.supplierId ?? null,
      supplierName: session.supplierName ?? null,
      canonicalName: session.supplier?.name ?? null,
    }
    return [...session.scanItems].sort((a, b) => a.sortOrder - b.sortOrder).map(i => quickLine(i, ref))
  }, [session])

  if (!sessionId) return null

  const active = lines.filter(l => l.verdict !== 'skipped')
  const needLook = active.filter(l => l.verdict !== 'ok').length
  const needComputer = active.filter(l => l.verdict === 'computer').length
  const supplierMissing = !!session && !session.supplierId
  const reviewing = !!session && session.status === 'REVIEW'
  const allClean = reviewing && needLook === 0 && !supplierMissing
  const total = num(session?.total)

  return (
    <div className="fixed inset-0 z-50 flex items-end md:hidden">
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="relative z-50 bg-paper w-full rounded-t-2xl max-h-[92dvh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 border-b border-line shrink-0">
          <div className="min-w-0">
            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.06em]">Quick check</div>
            <h2 className="text-[20px] font-semibold text-ink tracking-[-0.02em] leading-tight mt-1 truncate">
              {session ? (session.supplier?.name ?? session.supplierName ?? 'Supplier not read') : 'Loading…'}
            </h2>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-11 h-11 rounded-full bg-bg-2 grid place-items-center text-ink-3 shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {failed ? (
            <p className="text-[13.5px] text-red-text py-6 text-center">Couldn’t load this invoice. Close and try again.</p>
          ) : !session ? (
            <div className="flex items-center justify-center py-10 text-ink-3"><Loader2 size={20} className="animate-spin" /></div>
          ) : (
            <>
              {/* Summary */}
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 bg-bg rounded-xl border border-line px-3 py-3 text-[13px]">
                <dt className="text-ink-3">Invoice #</dt>
                <dd className="text-ink text-right font-mono">{session.invoiceNumber ?? '—'}</dd>
                <dt className="text-ink-3">Date</dt>
                <dd className="text-ink text-right">{fmtDate(session.invoiceDate) ?? '—'}</dd>
                {showMoney && (<>
                  <dt className="text-ink-3">Total</dt>
                  <dd className="text-ink text-right font-mono font-semibold">{total != null ? formatCurrency(total) : '—'}</dd>
                </>)}
                <dt className="text-ink-3">Lines</dt>
                <dd className="text-ink text-right">{active.length}</dd>
              </dl>

              {supplierMissing && (
                <div className="flex items-center gap-2 text-[13px] text-gold-2 bg-gold-soft rounded-xl px-3 py-2.5">
                  <AlertTriangle size={14} className="shrink-0" /> Supplier needs linking
                </div>
              )}

              {/* Lines */}
              <ul className="bg-paper border border-line rounded-xl divide-y divide-line">
                {lines.map(l => (
                  <li key={l.id} className={`flex items-start gap-3 px-3 py-2.5 ${l.verdict === 'skipped' ? 'opacity-50' : ''}`}>
                    <span className="mt-0.5 shrink-0">
                      {l.verdict === 'ok' ? (
                        <span className="w-5 h-5 rounded-full bg-green-soft text-green-text grid place-items-center"><Check size={12} /></span>
                      ) : l.verdict === 'skipped' ? (
                        <span className="w-5 h-5 rounded-full bg-bg-2 block" />
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-gold-soft text-gold-2 grid place-items-center"><AlertTriangle size={11} /></span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] text-ink leading-snug">{l.name}</div>
                      <div className="text-[12px] text-ink-3 mt-0.5">
                        {l.qty || '—'}
                        {l.verdict === 'skipped' && ' · skipped'}
                      </div>
                      {l.verdict === 'look' && (
                        <div className="text-[12px] text-gold-2 mt-0.5">Needs a look · {l.reason}</div>
                      )}
                      {l.verdict === 'computer' && (
                        <div className="text-[12px] text-gold-2 mt-0.5 inline-flex items-center gap-1">
                          <Monitor size={12} /> Finish on a computer · {l.reason}
                        </div>
                      )}
                    </div>
                    {showMoney && l.total != null && (
                      <span className="font-mono text-[12.5px] text-ink-2 shrink-0 mt-0.5">{formatCurrency(l.total)}</span>
                    )}
                  </li>
                ))}
                {lines.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">No lines on this invoice.</li>}
              </ul>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-line px-4 pt-3 space-y-2 shrink-0" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}>
          {session && reviewing && (
            <p className="text-[12.5px] text-ink-3 text-center">
              {allClean
                ? (mayApprove ? 'Every line checks out.' : 'Every line checks out — ready for a manager to approve.')
                : needComputer > 0
                  ? `${needLook} ${needLook === 1 ? 'line needs' : 'lines need'} a look — ${needComputer === 1 ? 'one has' : `${needComputer} have`} to be finished on a computer.`
                  : `${needLook + (supplierMissing ? 1 : 0)} ${needLook + (supplierMissing ? 1 : 0) === 1 ? 'thing needs' : 'things need'} a look.`}
              {!mayApprove && !allClean && ' A manager approves this.'}
            </p>
          )}
          <button
            type="button"
            disabled={!session}
            onClick={() => session && onOpenFull(session.id)}
            className="w-full min-h-[48px] rounded-xl bg-ink text-paper text-[14.5px] font-medium active:bg-ink-2 disabled:opacity-50"
          >
            Open full review
          </button>
        </div>
      </div>
    </div>
  )
}
