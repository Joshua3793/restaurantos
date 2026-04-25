'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { ProcessingToast } from '@/components/invoices/ProcessingToast'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'

const InvoiceDrawer = dynamic(
  () => import('@/components/invoices/InvoiceDrawer').then(m => ({ default: m.InvoiceDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

interface ReadyNotification {
  sessionId: string
  supplierName: string | null
  invoiceNumber: string | null
}

export default function InvoicesPage() {
  const { activeRcId, activeRc } = useRc()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)
  const [readyNotification, setReadyNotification] = useState<ReadyNotification | null>(null)

  // Track previous statuses to detect PROCESSING → REVIEW transitions
  const prevStatusesRef = useRef<Map<string, SessionStatus>>(new Map())

  const fetchSessions = useCallback(async () => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    const data: SessionSummary[] = await fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json())

    // Detect PROCESSING → REVIEW transitions and fire notification
    const prev = prevStatusesRef.current
    for (const s of data) {
      if (prev.get(s.id) === 'PROCESSING' && s.status === 'REVIEW') {
        setReadyNotification({
          sessionId: s.id,
          supplierName: s.supplierName,
          invoiceNumber: s.invoiceNumber,
        })
      }
    }

    // Update previous statuses map
    const next = new Map<string, SessionStatus>()
    for (const s of data) next.set(s.id, s.status)
    prevStatusesRef.current = next

    setSessions(data)
    return data
  }, [activeRcId, activeRc])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  // Poll every 4s while any session is PROCESSING
  useEffect(() => {
    const hasProcessing = sessions.some(s => s.status === 'PROCESSING')
    if (!hasProcessing) return
    const interval = setInterval(fetchSessions, 4000)
    return () => clearInterval(interval)
  }, [sessions, fetchSessions])

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
      <div className="px-4 pt-3 pb-1 sm:pt-4 sm:pb-2 shrink-0">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Invoices</h1>
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
        onDelete={handleDelete}
        onBulkDelete={handleBulkDelete}
        onRetry={handleRetry}
      />
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
      {readyNotification && (
        <ProcessingToast
          supplierName={readyNotification.supplierName}
          invoiceNumber={readyNotification.invoiceNumber}
          onReview={() => {
            setSelectedSessionId(readyNotification.sessionId)
            setReadyNotification(null)
          }}
          onDismiss={() => setReadyNotification(null)}
        />
      )}
    </div>
  )
}
