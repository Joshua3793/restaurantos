'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Upload, ScanLine, CheckCircle2, AlertTriangle, ArrowRight,
  X, ChevronDown, Loader2, FileText, Image, FileSpreadsheet,
  TrendingUp, TrendingDown, Plus, Bell, Package,
  ClipboardList
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useUploadThing } from '@/lib/uploadthing-client'

// ── Types ─────────────────────────────────────────────────────────────────────

type SessionStatus = 'UPLOADING' | 'PROCESSING' | 'REVIEW' | 'APPROVED' | 'REJECTED'
type MatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
type LineItemAction = 'PENDING' | 'UPDATE_PRICE' | 'ADD_SUPPLIER' | 'CREATE_NEW' | 'SKIP'

interface ScanFile {
  id: string
  fileName: string
  fileType: string
  ocrStatus: string
}

interface InventoryMatch {
  id: string
  itemName: string
  purchaseUnit: string
  pricePerBaseUnit: number
  purchasePrice: number
}

interface ScanItem {
  id: string
  rawDescription: string
  rawQty: number | null
  rawUnit: string | null
  rawUnitPrice: number | null
  rawLineTotal: number | null
  matchedItemId: string | null
  matchedItem: InventoryMatch | null
  matchConfidence: MatchConfidence
  matchScore: number
  action: LineItemAction
  approved: boolean
  isNewItem: boolean
  newItemData: string | null
  previousPrice: number | null
  newPrice: number | null
  priceDiffPct: number | null
  formatMismatch: boolean
}

interface Session {
  id: string
  status: SessionStatus
  supplierName: string | null
  invoiceDate: string | null
  invoiceNumber: string | null
  total: number | null
  files: ScanFile[]
  scanItems: ScanItem[]
  priceAlerts: unknown[]
  recipeAlerts: unknown[]
  createdAt: string
}

interface ApproveResult {
  ok: boolean
  itemsUpdated: number
  newItemsCreated: number
  priceAlerts: number
  recipeAlerts: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const confidenceBadge = (c: MatchConfidence) => {
  if (c === 'HIGH')   return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-100 text-green-700">HIGH</span>
  if (c === 'MEDIUM') return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-100 text-yellow-700">MEDIUM</span>
  if (c === 'LOW')    return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700">LOW</span>
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-500">NO MATCH</span>
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

const ocrStatusBadge = (status: string) => {
  if (status === 'COMPLETE') return <span className="text-[10px] font-semibold text-green-600 flex items-center gap-1"><CheckCircle2 size={10} />Done</span>
  if (status === 'PROCESSING') return <span className="text-[10px] font-semibold text-blue-600 flex items-center gap-1"><Loader2 size={10} className="animate-spin" />Processing</span>
  if (status === 'ERROR') return <span className="text-[10px] font-semibold text-red-600 flex items-center gap-1"><AlertTriangle size={10} />Error</span>
  return <span className="text-[10px] font-semibold text-gray-400">Pending</span>
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function InvoicesPage() {
  const [view, setView] = useState<'scanner' | 'history'>('scanner')
  const [session, setSession] = useState<Session | null>(null)
  const [approveResult, setApproveResult] = useState<ApproveResult | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [approvedBy, setApprovedBy] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchSessions = useCallback(() => {
    fetch('/api/invoices/sessions').then(r => r.json()).then(setSessions)
  }, [])

  useEffect(() => {
    fetchSessions()
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [fetchSessions])

  const refreshSession = useCallback(async (id: string) => {
    const data: Session = await fetch(`/api/invoices/sessions/${id}`).then(r => r.json())
    setSession(data)
    return data
  }, [])

  // Poll while processing
  useEffect(() => {
    if (session?.status === 'PROCESSING') {
      pollRef.current = setInterval(async () => {
        const s = await refreshSession(session.id)
        if (s.status !== 'PROCESSING') {
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, 2000)
    } else {
      if (pollRef.current) clearInterval(pollRef.current)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [session?.status, session?.id, refreshSession])

  // ── Upload state ────────────────────────────────────────────────────────────

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/') || f.type === 'application/pdf' ||
      f.type === 'text/csv' || f.name.endsWith('.csv')
    )
    setFiles(prev => [...prev, ...dropped])
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return
    setFiles(prev => [...prev, ...Array.from(e.target.files!)])
  }

  const { startUpload, isUploading } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => {
      console.error('UploadThing error:', err)
      setNoApiKey(false) // reset any prior error
    },
  })

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setNoApiKey(false)

    // 1. Create the session record
    const sess: Session = await fetch('/api/invoices/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then(r => r.json())

    // 2a. Try UploadThing CDN first (production path)
    let uploadOk = false
    try {
      const uploaded = await startUpload(files)
      if (uploaded?.length) {
        await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: uploaded.map(f => ({
              url:      f.ufsUrl,
              fileName: f.name,
              fileType: f.type,
            })),
          }),
        })
        uploadOk = true
      }
    } catch {
      // UploadThing not configured — fall through to local upload
    }

    // 2b. Local fallback: store files as base64 in DB (works without UPLOADTHING_TOKEN)
    if (!uploadOk) {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
        method: 'POST',
        body: fd,
      })
      if (localRes.ok) {
        uploadOk = true
      } else {
        setScanError('File upload failed. Please try again.')
        setIsCreating(false)
        return
      }
    }

    setIsCreating(false)
    setFiles([])

    // 3. Refresh so UI transitions to PROCESSING state and polling starts
    await refreshSession(sess.id)

    // 4. Trigger OCR — long-running; polling detects REVIEW when done
    const processRes = await fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' })
    if (!processRes.ok) {
      const err = await processRes.json().catch(() => ({}))
      if (err.error?.includes('ANTHROPIC_API_KEY')) setNoApiKey(true)
    }

    // 5. Final refresh
    await refreshSession(sess.id)
  }

  // ── Review state actions ────────────────────────────────────────────────────

  const updateScanItem = async (itemId: string, updates: Partial<ScanItem & { newItemData: Record<string, unknown> }>) => {
    await fetch(`/api/invoices/sessions/${session!.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanItemId: itemId, ...updates }),
    })
    await refreshSession(session!.id)
  }

  const handleApproveAll = async () => {
    if (!session) return
    setIsApproving(true)
    const res = await fetch(`/api/invoices/sessions/${session.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: approvedBy || 'Manager' }),
    })
    const result = await res.json()
    setApproveResult(result)
    setIsApproving(false)
    fetchSessions()
  }

  const handleNewScan = () => {
    setSession(null)
    setApproveResult(null)
    setFiles([])
    setNoApiKey(false)
    setScanError(null)
  }

  // ── State 1: Upload ─────────────────────────────────────────────────────────

  const renderUpload = () => (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-100 mb-3">
          <ScanLine size={28} className="text-blue-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900">Scan Invoice</h2>
        <p className="text-sm text-gray-500 mt-1">Upload photos, PDFs, or CSVs — Claude will extract and match every line item</p>
      </div>

      {scanError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-800">
          <strong>Upload error:</strong> {scanError}
        </div>
      )}

      {noApiKey && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <strong>ANTHROPIC_API_KEY not set.</strong> Add your key to <code className="bg-amber-100 px-1 rounded">.env</code> and restart the server to enable OCR scanning.
        </div>
      )}

      {/* Dropzone */}
      <div
        onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
          isDragging ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
        }`}
      >
        <Upload size={32} className="text-gray-300" />
        <div className="text-center">
          <p className="font-medium text-gray-700">Drop files here or click to browse</p>
          <p className="text-xs text-gray-400 mt-1">JPEG, PNG, PDF, CSV supported</p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.csv,text/csv"
          className="hidden"
          onChange={handleFileInput}
        />
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              {fileIcon(f.type)}
              <span className="flex-1 text-sm text-gray-700 truncate">{f.name}</span>
              <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} KB</span>
              <button onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}>
                <X size={14} className="text-gray-300 hover:text-red-400" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={handleStartScan}
        disabled={files.length === 0 || isCreating || isUploading}
        className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {(isCreating || isUploading) ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
        {isUploading ? 'Uploading to CDN…' : isCreating ? 'Starting…' : `Scan ${files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Invoices'}`}
      </button>
    </div>
  )

  // ── State 2: Processing ─────────────────────────────────────────────────────

  const renderProcessing = () => (
    <div className="max-w-xl mx-auto space-y-6 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-100 animate-pulse mb-2">
        <ScanLine size={32} className="text-blue-600" />
      </div>
      <h2 className="text-xl font-bold text-gray-900">Scanning Invoice…</h2>
      <p className="text-sm text-gray-500">Claude is reading and extracting line items. This usually takes 10–30 seconds.</p>

      <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 text-left">
        {session?.files.map(f => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            {fileIcon(f.fileType)}
            <span className="flex-1 text-sm text-gray-700 truncate">{f.fileName}</span>
            {ocrStatusBadge(f.ocrStatus)}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
        <Loader2 size={14} className="animate-spin" />
        Polling for results…
      </div>
    </div>
  )

  // ── State 3: Review ─────────────────────────────────────────────────────────

  const renderReview = () => {
    if (!session) return null

    const actionCounts = session.scanItems.reduce(
      (acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc },
      {} as Record<string, number>
    )
    const totalItems = session.scanItems.length
    const skipCount = actionCounts['SKIP'] || 0
    const activeItems = totalItems - skipCount

    return (
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Review Scan Results</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {session.supplierName || 'Unknown supplier'} · {session.invoiceDate || 'No date'} · {totalItems} items found
            </p>
          </div>
          <button onClick={handleNewScan} className="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X size={14} /> Cancel
          </button>
        </div>

        {/* Session metadata */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Supplier', value: session.supplierName || '—' },
            { label: 'Invoice #', value: session.invoiceNumber || '—' },
            { label: 'Date', value: session.invoiceDate || '—' },
            { label: 'Total', value: session.total ? formatCurrency(Number(session.total)) : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 p-3">
              <div className="text-xs text-gray-400">{label}</div>
              <div className="text-sm font-semibold text-gray-900 mt-0.5 truncate">{value}</div>
            </div>
          ))}
        </div>

        {/* Line items */}
        <div className="space-y-2">
          {session.scanItems.map(item => (
            <ScanItemCard
              key={item.id}
              item={item}
              onUpdate={(updates) => updateScanItem(item.id, updates)}
            />
          ))}
        </div>

        {/* Sticky approve bar */}
        <div className="sticky bottom-16 md:bottom-4 bg-white border border-gray-200 rounded-2xl shadow-lg px-4 py-3 flex flex-col sm:flex-row items-center gap-3">
          <div className="flex-1 flex items-center gap-4 text-sm">
            <span className="text-gray-500">{activeItems} items to apply</span>
            {actionCounts['UPDATE_PRICE'] > 0 && (
              <span className="text-blue-600 font-medium">{actionCounts['UPDATE_PRICE']} price updates</span>
            )}
            {actionCounts['CREATE_NEW'] > 0 && (
              <span className="text-purple-600 font-medium">{actionCounts['CREATE_NEW']} new items</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Approved by"
              value={approvedBy}
              onChange={e => setApprovedBy(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleApproveAll}
              disabled={isApproving}
              className="bg-green-600 text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {isApproving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {isApproving ? 'Approving…' : 'Approve & Apply'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── State 4: Results ────────────────────────────────────────────────────────

  const renderResults = () => {
    if (!approveResult) return null
    return (
      <div className="max-w-xl mx-auto space-y-6 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-100 mb-2">
          <CheckCircle2 size={32} className="text-green-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900">Invoice Applied!</h2>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Prices Updated', value: approveResult.itemsUpdated, icon: <Package size={20} className="text-blue-500" />, color: 'blue' },
            { label: 'Items Created', value: approveResult.newItemsCreated, icon: <Plus size={20} className="text-purple-500" />, color: 'purple' },
            { label: 'Price Alerts', value: approveResult.priceAlerts, icon: <TrendingUp size={20} className="text-amber-500" />, color: 'amber' },
            { label: 'Recipe Alerts', value: approveResult.recipeAlerts, icon: <ClipboardList size={20} className="text-red-500" />, color: 'red' },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-white rounded-xl border border-gray-100 p-4 flex flex-col items-center gap-2">
              {icon}
              <div className="text-2xl font-bold text-gray-900">{value}</div>
              <div className="text-xs text-gray-500">{label}</div>
            </div>
          ))}
        </div>
        {(approveResult.priceAlerts > 0 || approveResult.recipeAlerts > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-sm text-amber-800">
            <Bell size={16} className="shrink-0" />
            {approveResult.priceAlerts + approveResult.recipeAlerts} alert(s) generated — check the bell icon in the header
          </div>
        )}
        <button
          onClick={handleNewScan}
          className="w-full bg-blue-600 text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-blue-700 transition-colors"
        >
          <ScanLine size={18} /> Scan Another Invoice
        </button>
      </div>
    )
  }

  // ── History tab ─────────────────────────────────────────────────────────────

  const renderHistory = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-900">Scan History</h2>
        <button
          onClick={() => { setView('scanner'); handleNewScan() }}
          className="bg-blue-600 text-white rounded-lg px-3 py-2 text-sm flex items-center gap-1.5 hover:bg-blue-700"
        >
          <ScanLine size={14} /> New Scan
        </button>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Supplier</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden sm:table-cell">Date</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Invoice #</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600 hidden md:table-cell">Total</th>
                <th className="text-center px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sessions.map(s => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{s.supplierName || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{s.invoiceDate || '—'}</td>
                  <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{s.invoiceNumber || '—'}</td>
                  <td className="px-4 py-3 text-right hidden md:table-cell">{s.total ? formatCurrency(Number(s.total)) : '—'}</td>
                  <td className="px-4 py-3 text-center">
                    <StatusChip status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(s.status === 'REVIEW' || s.status === 'PROCESSING') && (
                      <button
                        onClick={async () => { const data = await refreshSession(s.id); setSession(data); setView('scanner') }}
                        className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-2 py-1 rounded transition-colors flex items-center gap-1"
                      >
                        <ArrowRight size={10} /> Resume
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr><td colSpan={6} className="text-center py-12 text-gray-400">No scans yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  const currentState = approveResult ? 'results'
    : !session ? 'upload'
    : session.status === 'PROCESSING' ? 'processing'
    : session.status === 'REVIEW' ? 'review'
    : 'upload'

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Invoices</h1>
        <div className="flex bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setView('scanner')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === 'scanner' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Scanner
          </button>
          <button
            onClick={() => setView('history')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              view === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            History
          </button>
        </div>
      </div>

      {/* Progress steps (only when scanning) */}
      {view === 'scanner' && currentState !== 'results' && (
        <div className="flex items-center gap-1 text-xs text-gray-400 mb-2">
          {(['upload', 'processing', 'review'] as const).map((step, i) => (
            <div key={step} className="flex items-center gap-1">
              {i > 0 && <ArrowRight size={10} />}
              <span className={`capitalize ${currentState === step ? 'text-blue-600 font-semibold' : currentState === 'review' && step !== 'review' ? 'text-gray-300' : ''}`}>
                {step}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {view === 'history' ? renderHistory() : (
        currentState === 'upload' ? renderUpload() :
        currentState === 'processing' ? renderProcessing() :
        currentState === 'review' ? renderReview() :
        renderResults()
      )}
    </div>
  )
}

// ── StatusChip ────────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: SessionStatus }) {
  const map: Record<SessionStatus, { label: string; cls: string }> = {
    UPLOADING:  { label: 'Uploading',  cls: 'bg-gray-100 text-gray-500' },
    PROCESSING: { label: 'Processing', cls: 'bg-blue-100 text-blue-600' },
    REVIEW:     { label: 'Review',     cls: 'bg-amber-100 text-amber-700' },
    APPROVED:   { label: 'Approved',   cls: 'bg-green-100 text-green-700' },
    REJECTED:   { label: 'Rejected',   cls: 'bg-red-100 text-red-600' },
  }
  const { label, cls } = map[status] || map.UPLOADING
  return <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{label}</span>
}

// ── ScanItemCard ──────────────────────────────────────────────────────────────

function ScanItemCard({
  item,
  onUpdate,
}: {
  item: ScanItem
  onUpdate: (updates: Partial<ScanItem & { newItemData: Record<string, unknown> }>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [newItemForm, setNewItemForm] = useState({ itemName: item.rawDescription, purchaseUnit: item.rawUnit || 'each', category: 'UNCATEGORIZED' })

  const actionColor: Record<LineItemAction, string> = {
    PENDING:       'border-gray-200',
    UPDATE_PRICE:  'border-blue-200 bg-blue-50/30',
    ADD_SUPPLIER:  'border-gray-200',
    CREATE_NEW:    'border-purple-200 bg-purple-50/30',
    SKIP:          'border-gray-100 opacity-50',
  }

  const priceDiff = item.priceDiffPct ? Number(item.priceDiffPct) : null

  return (
    <div className={`bg-white rounded-xl border ${actionColor[item.action]} p-3 transition-all`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 text-sm">{item.rawDescription}</span>
            {confidenceBadge(item.matchConfidence)}
            {item.formatMismatch && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700">UNIT MISMATCH</span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            {item.rawQty !== null && <span>Qty: {item.rawQty} {item.rawUnit || ''}</span>}
            {item.rawUnitPrice !== null && <span>Unit: {formatCurrency(Number(item.rawUnitPrice))}</span>}
            {item.rawLineTotal !== null && <span>Total: {formatCurrency(Number(item.rawLineTotal))}</span>}
          </div>
          {item.matchedItem && (
            <div className="mt-1 text-xs text-gray-500 flex items-center gap-2">
              <Package size={10} />
              <span>{item.matchedItem.itemName}</span>
              {priceDiff !== null && (
                <span className={`flex items-center gap-0.5 font-semibold ${priceDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {priceDiff > 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                  {Math.abs(priceDiff).toFixed(1)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action selector */}
        <div className="flex items-center gap-1.5 shrink-0">
          <ActionSelect
            value={item.action}
            hasMatch={!!item.matchedItemId}
            onChange={action => onUpdate({ action })}
          />
          <button
            onClick={() => setExpanded(e => !e)}
            className="p-1 text-gray-300 hover:text-gray-500"
          >
            <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
          {item.action === 'UPDATE_PRICE' && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">Previous: {item.previousPrice !== null ? formatCurrency(Number(item.previousPrice)) : '—'}</span>
              <ArrowRight size={10} className="text-gray-300" />
              <span className="font-semibold text-blue-700">New: {item.newPrice !== null ? formatCurrency(Number(item.newPrice)) : '—'}</span>
            </div>
          )}
          {item.action === 'CREATE_NEW' && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500 font-medium">New item details</p>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  placeholder="Item name"
                  value={newItemForm.itemName}
                  onChange={e => setNewItemForm(f => ({ ...f, itemName: e.target.value }))}
                  onBlur={() => onUpdate({ newItemData: newItemForm })}
                  className="col-span-2 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                />
                <input
                  type="text"
                  placeholder="Unit (e.g. case)"
                  value={newItemForm.purchaseUnit}
                  onChange={e => setNewItemForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                  onBlur={() => onUpdate({ newItemData: newItemForm })}
                  className="border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                />
              </div>
            </div>
          )}
          {item.matchScore > 0 && (
            <p className="text-[10px] text-gray-400">Match score: {item.matchScore}/100</p>
          )}
        </div>
      )}
    </div>
  )
}

// ── ActionSelect ──────────────────────────────────────────────────────────────

function ActionSelect({
  value,
  hasMatch,
  onChange,
}: {
  value: LineItemAction
  hasMatch: boolean
  onChange: (v: LineItemAction) => void
}) {
  const options: { value: LineItemAction; label: string }[] = [
    { value: 'UPDATE_PRICE', label: 'Update Price' },
    { value: 'ADD_SUPPLIER', label: 'Add Supplier' },
    { value: 'CREATE_NEW',   label: 'Create New' },
    { value: 'SKIP',         label: 'Skip' },
  ]

  const colorMap: Record<LineItemAction, string> = {
    PENDING:       'bg-gray-100 text-gray-600',
    UPDATE_PRICE:  'bg-blue-100 text-blue-700',
    ADD_SUPPLIER:  'bg-teal-100 text-teal-700',
    CREATE_NEW:    'bg-purple-100 text-purple-700',
    SKIP:          'bg-gray-100 text-gray-400',
  }

  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as LineItemAction)}
      className={`text-xs font-semibold rounded-lg px-2 py-1 border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400 ${colorMap[value]}`}
    >
      {options.filter(o => hasMatch || o.value === 'CREATE_NEW' || o.value === 'SKIP').map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
