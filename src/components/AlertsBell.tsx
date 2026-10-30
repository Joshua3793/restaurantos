'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, X, Check, FileText, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { useNotifications } from '@/contexts/NotificationContext'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { atLeast } from '@/lib/roles'
import { subscribeInboxCount, refreshInboxCount } from '@/lib/inbox-count-feed'
import {
  topBellItems, badgeText, bellAriaLabel, reportPill, reportMeta, reportDetail, openReport,
  type BellItem, type BellReport, type BellKind, type ReportDetailResponse,
} from '@/lib/bell'
import { whenLabel } from '@/components/inbox/format'

interface AlertsBellProps {
  dropdownAlign?: 'left' | 'right'
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type DetailState = ReportDetailResponse | 'loading' | 'error'

// The bell is the Inbox's doorway. Leads and up see the open NOW + TODAY items;
// a cook sees their own reports and which ones got fixed. The soft invoice
// notifications (toasts) are still listed here, under the Inbox list.
export function AlertsBell({ dropdownAlign = 'left' }: AlertsBellProps) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(0)
  const [items, setItems] = useState<BellItem[]>([])
  const [reports, setReports] = useState<BellReport[]>([])
  const [load, setLoad] = useState<LoadState>('idle')
  const [openId, setOpenId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { notifications, dismiss, dismissAll } = useNotifications()
  const { activeRcId, ready } = useRc()
  const { role } = useUser()

  const isLead = role != null && atLeast(role, 'LEAD')
  const known = role != null
  const kind: BellKind = !known ? 'unknown' : isLead ? 'lead' : 'staff'

  // The badge: one shared poll per kitchen. No single kitchen, no badge.
  useEffect(() => {
    if (!known || !ready || !activeRcId) { setCount(0); return }
    return subscribeInboxCount(activeRcId, setCount)
  }, [known, ready, activeRcId])

  // Re-read the cook's own reports without flicker (the rows stay on screen).
  const fetchReports = useCallback(async () => {
    const r = await fetch('/api/inbox/mine', { cache: 'no-store' })
    if (!r.ok) throw new Error(String(r.status))
    const d = await r.json()
    setReports(d.items ?? [])
  }, [])

  // The list is fetched only when the dropdown opens.
  const loadList = useCallback(async () => {
    if (!known) return
    setLoad('loading')
    try {
      if (isLead) {
        if (!activeRcId) { setItems([]); setLoad('ready'); return }
        const r = await fetch(`/api/inbox?rcId=${encodeURIComponent(activeRcId)}&status=open`, { cache: 'no-store' })
        if (!r.ok) throw new Error(String(r.status))
        const d = await r.json()
        setItems(topBellItems<BellItem>(d.items ?? []))
      } else {
        await fetchReports()
      }
      setLoad('ready')
    } catch {
      setLoad('error')
    }
  }, [known, isLead, activeRcId, fetchReports])

  // Opening the bell also refreshes the badge, so it never sits on a stale number.
  useEffect(() => {
    if (!open) return
    void loadList()
    if (activeRcId) void refreshInboxCount(activeRcId)
  }, [open, loadList, activeRcId])

  // Tapping a report opens it in place. Reading it is what marks it seen, which
  // is the only thing that clears it from the cook's badge.
  const tapReport = useCallback(async (id: string) => {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    setDetails(d => ({ ...d, [id]: 'loading' }))
    try {
      const detail = await openReport<ReportDetailResponse>({
        id,
        rcId: activeRcId,
        read: async rid => {
          const r = await fetch(`/api/inbox/${encodeURIComponent(rid)}`, { cache: 'no-store' })
          if (!r.ok) throw new Error(String(r.status))
          return r.json()
        },
        refreshCount: refreshInboxCount,
        reloadReports: () => fetchReports().catch(() => {}),
      })
      setDetails(d => ({ ...d, [id]: detail }))
    } catch {
      setDetails(d => ({ ...d, [id]: 'error' }))
    }
  }, [openId, activeRcId, fetchReports])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus() }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  const badgeCount = count + notifications.length
  const dropdownPos = dropdownAlign === 'right' ? 'right-0' : 'left-0'
  const now = new Date()

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        aria-label={bellAriaLabel(kind, count)}
        aria-haspopup="true"
        aria-expanded={open}
        className="relative min-h-[44px] min-w-[44px] flex items-center justify-center p-2 rounded-lg text-ink-4 hover:text-ink-3 hover:bg-bg-2 transition-colors"
      >
        <Bell size={18} />
        {badgeCount > 0 && (
          <span className="absolute top-2 right-2 min-w-4 h-4 px-0.5 bg-red text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {badgeText(badgeCount)}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute ${dropdownPos} top-full mt-2 w-[min(320px,calc(100vw-16px))] bg-white rounded-2xl shadow-xl border border-line z-50 overflow-hidden`}>
          {/* Header */}
          <div className="flex items-center justify-between pl-4 pr-1 border-b border-line">
            <span className="font-semibold text-ink text-sm py-3">{kind === 'staff' ? 'Your reports' : 'Inbox'}</span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              <X size={14} className="text-ink-4" />
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {/* Role not known yet: don't guess which list this is */}
            {!known && <div className="text-center py-6 text-ink-4 text-sm">Loading…</div>}

            {/* ── Inbox (LEAD+) ─────────────────────────────────────────── */}
            {isLead && (
              load === 'error' ? (
                <div className="text-center py-6 text-ink-4 text-sm">Couldn’t load the Inbox</div>
              ) : load !== 'ready' ? (
                <div className="text-center py-6 text-ink-4 text-sm">Loading…</div>
              ) : !activeRcId ? (
                <div className="text-center py-6 text-ink-4 text-sm">Pick one kitchen to see its Inbox</div>
              ) : items.length === 0 ? (
                <div className="text-center py-6 text-ink-4 text-sm">Nothing needs you</div>
              ) : (
                items.map(it => (
                  <Link
                    key={it.id}
                    href="/inbox"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 px-4 min-h-[44px] py-2 border-b border-line hover:bg-bg"
                  >
                    <span
                      className="flex-none w-2 h-2 rounded-full"
                      style={{ background: it.tag.color }}
                      title={it.tag.name}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0 text-sm font-medium text-ink-2 truncate">{it.title}</span>
                    <span className="flex-none font-mono text-[10.5px] text-ink-4">{whenLabel(it.createdAt, now)}</span>
                  </Link>
                ))
              )
            )}

            {/* ── Your reports (STAFF) ──────────────────────────────────── */}
            {!isLead && known && (
              load === 'error' ? (
                <div className="text-center py-6 text-ink-4 text-sm">Couldn’t load your reports</div>
              ) : load !== 'ready' ? (
                <div className="text-center py-6 text-ink-4 text-sm">Loading…</div>
              ) : reports.length === 0 ? (
                <div className="text-center py-6 text-ink-4 text-sm">Nothing reported yet</div>
              ) : (
                reports.map(r => {
                  const pill = reportPill(r.status)
                  const expanded = openId === r.id
                  const det = details[r.id]
                  const info = det && typeof det === 'object' ? reportDetail(det, now) : null
                  return (
                    <div key={r.id} className="border-b border-line">
                      <button
                        type="button"
                        onClick={() => void tapReport(r.id)}
                        aria-expanded={expanded}
                        className="w-full text-left px-4 py-2.5 min-h-[44px] hover:bg-bg"
                      >
                        <div className="flex items-center gap-2">
                          {r.fixedSinceSeen && (
                            <span className="flex-none w-2 h-2 rounded-full bg-gold" title="New" aria-label="New" role="img" />
                          )}
                          <span className="flex-1 min-w-0 text-sm font-medium text-ink-2 truncate">{r.title}</span>
                          <span
                            className={`flex-none font-mono text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full leading-none ${
                              pill.fixed ? 'bg-green-soft text-green-text' : 'bg-gold-soft text-gold-2'
                            }`}
                          >
                            {pill.label}
                          </span>
                        </div>
                        <p className="font-mono text-[10.5px] text-ink-4 mt-0.5">{reportMeta(r, now)}</p>
                      </button>
                      {expanded && (
                        <div className="px-4 pb-3 text-xs text-ink-3 space-y-1">
                          {det === 'loading' || det === undefined ? (
                            <p className="text-ink-4">Loading…</p>
                          ) : det === 'error' ? (
                            <p className="text-ink-4">Couldn’t open this report</p>
                          ) : info && (
                            <>
                              {info.body && <p className="whitespace-pre-wrap text-ink-2">{info.body}</p>}
                              {info.resolution && <p className="font-mono text-[10.5px] text-ink-4">{info.resolution}</p>}
                              {info.note && <p className="whitespace-pre-wrap">{info.note}</p>}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )
            )}

            {/* ── Soft notifications (invoice ready / applied) ──────────── */}
            {notifications.length > 0 && (
              <>
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <span className="font-mono text-[10px] text-ink-4 tracking-[0.04em]">INVOICES</span>
                  <button
                    onClick={dismissAll}
                    className="text-xs flex items-center gap-1 text-gold hover:underline min-h-[44px]"
                  >
                    <Check size={10} /> Clear all
                  </button>
                </div>
                {notifications.map(n => (
                  <div key={n.id} className="px-4 py-3 border-b border-line hover:bg-bg">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${n.type === 'invoice_applied' ? 'bg-green-soft' : 'bg-blue-soft'}`}>
                        {n.type === 'invoice_applied'
                          ? <CheckCircle2 size={12} className="text-green" />
                          : <FileText size={12} className="text-blue" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ink-2">
                          {n.type === 'invoice_applied' ? 'Invoice applied' : 'Invoice ready to review'}
                        </p>
                        <p className="text-xs text-ink-3 truncate">
                          {n.supplierName ?? 'Unknown supplier'}
                          {n.invoiceNumber ? ` · #${n.invoiceNumber}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { n.onAction(); setOpen(false) }}
                          className="text-[10px] text-gold hover:underline font-medium min-h-[44px] px-1"
                        >
                          {n.actionLabel}
                        </button>
                        <button
                          onClick={() => dismiss(n.id)}
                          aria-label="Dismiss"
                          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-ink-4 hover:text-ink-3"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer */}
          {isLead && (
            <Link
              href="/inbox"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center min-h-[44px] px-4 text-xs font-medium text-gold hover:bg-gold/10 transition-colors border-t border-line"
            >
              Open Inbox →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
