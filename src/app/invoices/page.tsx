'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { InboxView } from '@/components/invoices/InboxView'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { useNotifications } from '@/contexts/NotificationContext'
import { isNative } from '@/lib/capacitor'
import { useNativeScan } from '@/hooks/useNativeScan'

const InvoiceDrawer = dynamic<{
  sessionId: string | null
  onClose: () => void
  onApproveOrReject: () => void
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
  const { activeRcId, activeRc } = useRc()
  const { setDrawerOpen } = useDrawer()
  const { push } = useNotifications()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [view, setView] = useState<'inbox' | 'history'>('inbox')

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

  const handleApproveOrReject = useCallback(() => {
    fetchSessions()
    setKpiRefreshKey(k => k + 1)
  }, [fetchSessions])

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

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {view === 'inbox' ? (
        <InboxView
          sessions={sessions}
          onSelectSession={setSelectedSessionId}
          onUploadClick={() => setShowUpload(true)}
          onScanClick={isNative() ? triggerScan : undefined}
          onSwitchToHistory={() => setView('history')}
        />
      ) : (
        <>
          <div className="px-4 pt-3 pb-1 sm:pt-4 sm:pb-2 shrink-0 flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Invoice History</h1>
            <button
              onClick={() => setView('inbox')}
              className="ml-auto text-xs text-gold hover:underline font-medium"
            >
              ← Back to Inbox
            </button>
          </div>
          <InvoiceKpiStrip
            refreshKey={kpiRefreshKey}
            activeRcId={activeRcId}
            isDefault={activeRc?.isDefault ?? false}
          />
          <InvoiceList
            sessions={sessions}
            onSelect={setSelectedSessionId}
            onUploadClick={() => setShowUpload(true)}
            onScanClick={isNative() ? triggerScan : undefined}
            onDelete={handleDelete}
            onBulkDelete={handleBulkDelete}
            onRetry={handleRetry}
          />
        </>
      )}
      {scanError && (
        <button
          onClick={clearError}
          className="fixed bottom-20 left-4 right-4 z-50 bg-red-600 text-white text-sm font-medium rounded-xl px-4 py-3 shadow-lg sm:hidden text-left w-auto"
        >
          {scanError} — tap to dismiss
        </button>
      )}
      {isScanning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 sm:hidden">
          <div className="bg-white rounded-2xl px-8 py-6 flex flex-col items-center gap-3 shadow-xl">
            <div className="w-10 h-10 border-4 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-semibold text-gray-700">Processing scan…</p>
          </div>
        </div>
      )}
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
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
  )
}
