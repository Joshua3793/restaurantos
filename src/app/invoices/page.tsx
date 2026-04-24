'use client'
import { useState, useCallback, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'
import { useRc } from '@/contexts/RevenueCenterContext'

// Lazy-load heavy components — InvoiceDrawer pulls in the full review engine,
// InvoiceUploadModal pulls in uploadthing + CameraCapture.
const InvoiceDrawer = dynamic(
  () => import('@/components/invoices/InvoiceDrawer').then(m => ({ default: m.InvoiceDrawer })),
  { ssr: false, loading: () => null }
)

const InvoiceUploadModal = dynamic(
  () => import('@/components/invoices/InvoiceUploadModal').then(m => ({ default: m.InvoiceUploadModal })),
  { ssr: false, loading: () => null }
)

export default function InvoicesPage() {
  const { activeRcId, activeRc } = useRc()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)

  const fetchSessions = useCallback(() => {
    const p = new URLSearchParams()
    if (activeRcId) {
      p.set('rcId', activeRcId)
      if (activeRc?.isDefault) p.set('isDefault', 'true')
    }
    const qs = p.toString()
    fetch(`/api/invoices/sessions${qs ? `?${qs}` : ''}`).then(r => r.json()).then(setSessions)
  }, [activeRcId, activeRc])

  useEffect(() => { fetchSessions() }, [fetchSessions])

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
          onComplete={(newSessionId) => {
            fetchSessions()
            setShowUpload(false)
            setSelectedSessionId(newSessionId)
          }}
        />
      )}
    </div>
  )
}
