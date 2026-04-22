'use client'
import { useState, useCallback, useEffect } from 'react'
import { InvoiceKpiStrip } from '@/components/invoices/InvoiceKpiStrip'
import { InvoiceList } from '@/components/invoices/InvoiceList'
import { InvoiceDrawer } from '@/components/invoices/InvoiceDrawer'
import { InvoiceUploadModal } from '@/components/invoices/InvoiceUploadModal'
import { SessionSummary, SessionStatus } from '@/components/invoices/types'

export default function InvoicesPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0)

  const fetchSessions = useCallback(() => {
    fetch('/api/invoices/sessions').then(r => r.json()).then(setSessions)
  }, [])

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

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="px-4 pt-4 pb-2 shrink-0">
        <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
      </div>
      <InvoiceKpiStrip refreshKey={kpiRefreshKey} />
      <InvoiceList
        sessions={sessions}
        onSelect={setSelectedSessionId}
        onUploadClick={() => setShowUpload(true)}
        onDelete={handleDelete}
      />
      <InvoiceDrawer
        sessionId={selectedSessionId}
        onClose={() => setSelectedSessionId(null)}
        onApproveOrReject={handleApproveOrReject}
      />
      {showUpload && (
        <InvoiceUploadModal
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
