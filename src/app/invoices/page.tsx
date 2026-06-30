'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { Mail, Clock } from 'lucide-react'
import { InvoiceKpiStripV2 } from '@/components/invoices/InvoiceKpiStripV2'
import { InvoiceListV2 } from '@/components/invoices/InvoiceListV2'
import { InboxViewV2 } from '@/components/invoices/InboxViewV2'
import { InboxSubNav } from '@/components/invoices/InboxSubNav'
import { MobileInbox } from '@/components/invoices/mobile/MobileInbox'
import { Signal } from '@/lib/invoices/inbox-items'
import { PageHead } from '@/components/layout/PageHead'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { useNotifications } from '@/contexts/NotificationContext'
import { isNative } from '@/lib/capacitor'
import { useNativeScan } from '@/hooks/useNativeScan'

const InvoiceDrawer = dynamic<{
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: (optimistic?: { id: string; status: SessionStatus }) => void
  onNavigate?: (id: string) => void
  allSessions?: SessionSummary[]
}>(
  () => import('@/components/invoices/v2/InvoiceReviewDrawer').then(m => ({ default: m.InvoiceReviewDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

export default function InvoicesPage() {
  const { activeRcId, activeRc, isReadOnly } = useRc()
  const { setDrawerOpen } = useDrawer()
  const { push } = useNotifications()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [signals, setSignals] = useState<Signal[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [view, setView] = useState<'inbox' | 'history'>('inbox')

  // Upload writes into the active RC; block it when a Location/"All" is selected.
  const handleUploadClick = () => {
    if (isReadOnly) return
    setShowUpload(true)
  }

  // Track previous statuses to detect PROCESSING → REVIEW / APPROVING → APPROVED transitions
  const prevStatusesRef = useRef<Map<string, SessionStatus>>(new Map())

  useEffect(() => {
    setDrawerOpen(selectedSessionId !== null)
    return () => setDrawerOpen(false)
  }, [selectedSessionId, setDrawerOpen])

  const fetchSessions = useCallback(async () => {
    try {
      const p = new URLSearchParams()
      if (activeRcId) {
        p.set('rcId', activeRcId)
        if (activeRc?.isDefault) p.set('isDefault', 'true')
      }
      const qs = p.toString()
      const data: SessionSummary[] = await fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json())

      // Detect PROCESSING → REVIEW and APPROVING → APPROVED transitions
      const prev = prevStatusesRef.current
      for (const s of data) {
        if (prev.get(s.id) === 'PROCESSING' && s.status === 'REVIEW') {
          const sid = s.id
          push({
            type: 'invoice_ready',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'Review',
            onAction: () => setSelectedSessionId(sid),
          })
        }
        if (prev.get(s.id) === 'APPROVING' && s.status === 'APPROVED') {
          const sid = s.id
          push({
            type: 'invoice_applied',
            sessionId: sid,
            supplierName: s.supplierName,
            invoiceNumber: s.invoiceNumber,
            actionLabel: 'View',
            onAction: () => setSelectedSessionId(sid),
          })
        }
      }

      // Update previous statuses map
      const next = new Map<string, SessionStatus>()
      for (const s of data) next.set(s.id, s.status)
      prevStatusesRef.current = next

      setSessions(data)
      // Mobile inbox also surfaces signals (prices / variance / exceptions).
      fetch('/api/signals', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j?.signals) setSignals(j.signals) })
        .catch(() => {})
      return data
    } catch {
      // silent — keeps existing sessions on screen, polling continues
    }
  }, [activeRcId, activeRc, push])

  const handleScanComplete = useCallback(() => {
    fetchSessions()
  }, [fetchSessions])

  const { triggerScan, isScanning, scanError, clearError } = useNativeScan({
    activeRcId,
    onComplete: handleScanComplete,
  })

  useEffect(() => { fetchSessions() }, [fetchSessions])

  // Sequential poll via refs so the timer never resets mid-wait.
  // Using refs instead of state deps prevents the interval from being
  // cancelled and restarted on every sessions update (which caused the
  // timer to keep resetting before it could fire on Capacitor WebView).
  const fetchRef    = useRef(fetchSessions)
  const sessionsRef = useRef(sessions)
  fetchRef.current    = fetchSessions
  sessionsRef.current = sessions

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      const hasTransient = sessionsRef.current.some(s =>
        s.status === 'UPLOADING' || s.status === 'PROCESSING' || s.status === 'APPROVING'
      )
      timer = setTimeout(async () => {
        await fetchRef.current()
        schedule()
      }, hasTransient ? 3000 : 15000)
    }
    schedule()
    return () => clearTimeout(timer)
  }, []) // runs once; uses refs for always-fresh values

  // Refresh whenever the tab regains focus (covers status changes made elsewhere)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchSessions() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchSessions])

  const handleApproveOrReject = useCallback((optimistic?: { id: string; status: SessionStatus }) => {
    if (optimistic) {
      setSessions(prev =>
        prev.map(s => (s.id === optimistic.id ? { ...s, status: optimistic.status } : s)),
      )
    }
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

  const handleSignalAct = useCallback(async (id: string, action: 'apply' | 'snooze' | 'dismiss') => {
    setSignals(prev => prev.filter(s => s.id !== id)) // optimistic
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], action }),
      })
    } catch { /* poll will resync */ }
  }, [])

  const handleDelete = useCallback(async (id: string, _status: SessionStatus): Promise<void> => {
    await fetch(`/api/invoices/sessions/${id}`, { method: 'DELETE' })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId === id) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleBulkDelete = useCallback(async (ids: string[]): Promise<void> => {
    await fetch('/api/invoices/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
    if (selectedSessionId && ids.includes(selectedSessionId)) setSelectedSessionId(null)
  }, [selectedSessionId, fetchSessions])

  const handleRetry = useCallback(async (id: string) => {
    fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
    await fetchSessions()
  }, [fetchSessions])

  const queueCount = sessions.filter(s =>
    s.status === 'REVIEW' || s.status === 'PROCESSING' || s.status === 'UPLOADING' ||
    s.status === 'APPROVING' || s.status === 'ERROR'
  ).length

  return (
    <>
    <div className="hidden sm:block"><InboxSubNav /></div>
    <div className="p-4 md:p-6 md:px-8 max-w-7xl mx-auto w-full">

      {isReadOnly && (
        <div className="mb-3 rounded-lg border border-line bg-bg px-3 py-2 text-[12.5px] text-ink-3">
          Select a revenue center to upload or approve invoices.
        </div>
      )}

      {/* ── Mobile: unified inbox feed ── */}
      <div className="block sm:hidden">
        <MobileInbox
          sessions={sessions}
          signals={signals}
          onSelectSession={setSelectedSessionId}
          onUploadClick={handleUploadClick}
          onScanClick={isNative() ? triggerScan : undefined}
          onSignalAct={handleSignalAct}
        />
      </div>

      {/* ── Desktop: existing V2 (unchanged) ── */}
      <div className="hidden sm:block">
      <PageHead
        crumbs={<><Mail size={12} /> INBOX / INVOICES</>}
        title="Invoices"
        sub={
          view === 'inbox'
            ? <>OCR → review → approve. <b>{queueCount}</b> {queueCount === 1 ? 'session' : 'sessions'} in queue.</>
            : <>All invoice sessions — sortable, searchable, filterable by status.</>
        }
        actions={
          <div className="inline-flex bg-paper border border-line rounded-[9px] p-[3px]">
            <button
              onClick={() => setView('inbox')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'inbox' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Mail size={11} className={view === 'inbox' ? 'text-gold' : ''} /> Inbox
              {queueCount > 0 && (
                <span className={`font-mono text-[10px] px-1.5 rounded-full leading-tight ${view === 'inbox' ? 'bg-gold text-ink' : 'bg-gold-soft text-gold-2'}`}>{queueCount}</span>
              )}
            </button>
            <button
              onClick={() => setView('history')}
              className={`font-mono text-[11px] px-3 py-1.5 rounded-[6px] tracking-[0.02em] uppercase transition-colors inline-flex items-center gap-1.5 ${
                view === 'history' ? 'bg-ink text-paper' : 'text-ink-3 hover:text-ink-2'
              }`}
            >
              <Clock size={11} className={view === 'history' ? 'text-gold' : ''} /> History
            </button>
          </div>
        }
      />

      <InvoiceKpiStripV2
        refreshKey={kpiRefreshKey}
        activeRcId={activeRcId}
        isDefault={activeRc?.isDefault ?? false}
      />

      {view === 'inbox' ? (
        <InboxViewV2
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          onUploadClick={handleUploadClick}
          onScanClick={isNative() ? triggerScan : undefined}
        />
      ) : (
        <InvoiceListV2
          sessions={sessions}
          onSelect={setSelectedSessionId}
          onUploadClick={handleUploadClick}
          onScanClick={isNative() ? triggerScan : undefined}
          onDelete={handleDelete}
          onBulkDelete={handleBulkDelete}
          onRetry={handleRetry}
        />
      )}
      </div>{/* /desktop */}
      {scanError && (
        <button
          onClick={clearError}
          className="fixed bottom-20 left-4 right-4 z-50 bg-red text-white text-sm font-medium rounded-xl px-4 py-3 shadow-lg sm:hidden text-left w-auto"
        >
          {scanError} — tap to dismiss
        </button>
      )}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:hidden">
          <div className="bg-white rounded-2xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-ink-2">Processing scan…</p>
          </div>
        </div>
      )}
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
        onNavigate={(id) => setSelectedSessionId(id)}
        allSessions={sessions}
      />
      {showUpload && (
        <InvoiceUploadModal
          activeRcId={activeRcId}
          onClose={() => setShowUpload(false)}
          onComplete={() => {
            fetchSessions()
            setShowUpload(false)
          }}
        />
      )}
    </div>
    </>
  )
}
