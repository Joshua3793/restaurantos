'use client'
import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Upload, ScanLine, CheckCircle2, AlertTriangle, ArrowRight,
  X, ChevronDown, Loader2, FileText, Image, FileSpreadsheet,
  TrendingUp, TrendingDown, Plus, Bell, Package,
  ClipboardList, ChevronRight, Pencil, Trash2, AlertCircle,
  Hash, CalendarDays
} from 'lucide-react'
import { formatCurrency, PACK_UOMS, COUNT_UOMS, calcPricePerBaseUnit, deriveBaseUnit, calcConversionFactor } from '@/lib/utils'
import { useUploadThing } from '@/lib/uploadthing-client'
import { comparePricesNormalized, calcNewPurchasePrice } from '@/lib/invoice-format'

// ── Keyword helper ────────────────────────────────────────────────────────────

function descriptionToKeywords(desc: string): string {
  return desc
    .replace(/\d+\s*[\/x]\s*\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/\d+(?:\.\d+)?\s*(?:l|ml|kg|g|lb|oz)\b/gi, '')
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ')
}

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
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
  baseUnit: string
}

interface InventoryFullItem extends InventoryMatch {
  itemName: string
  category: string
  abbreviation: string | null
  location: string | null
  purchaseUnit: string
  countUOM: string
  conversionFactor: number
  stockOnHand: number
  isActive: boolean
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
  invoicePackQty: number | null
  invoicePackSize: number | null
  invoicePackUOM: string | null
  needsFormatConfirm: boolean
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
  const [approvedBy, setApprovedBy] = useState(() =>
    typeof window !== 'undefined' ? (localStorage.getItem('approvedBy') ?? '') : ''
  )
  const [sessions, setSessions] = useState<Session[]>([])
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<ScanItem | null>(null)
  const [editingInventory, setEditingInventory] = useState<{ inventoryItemId: string; scanItem: ScanItem } | null>(null)
  const [isAddingItem, setIsAddingItem] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; status: SessionStatus } | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [duplicateDismissed, setDuplicateDismissed] = useState(false)
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
      if (err.error?.includes('ANTHROPIC_API_KEY')) {
        setNoApiKey(true)
      } else {
        setScanError(err.error || 'Processing failed. Please try again.')
      }
      // Move session out of PROCESSING so polling stops
      await fetch(`/api/invoices/sessions/${sess.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'UPLOADING' }),
      })
    } else {
      // Surface partial OCR failures — when the API succeeded but some files errored
      const result = await processRes.json().catch(() => ({}))
      if (result.ocrErrors > 0 && result.ocrItemCount === 0) {
        setScanError('Claude couldn\'t read the invoice. Make sure the image is clear and well-lit, then try again.')
      }
    }

    // 5. Final refresh
    await refreshSession(sess.id)
  }

  // ── Review state actions ────────────────────────────────────────────────────

  const updateScanItem = async (itemId: string, updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>) => {
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

  // ── History: reopen a session for editing ──────────────────────────────────
  const handleEditSession = async (sessionId: string) => {
    await fetch(`/api/invoices/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'REVIEW' }),
    })
    const data = await refreshSession(sessionId)
    setSession(data)
    setApproveResult(null)
    setView('scanner')
  }

  // ── History: delete a session (with price reversal if APPROVED) ────────────
  const handleDeleteSession = async (sessionId: string) => {
    setIsDeleting(true)
    await fetch(`/api/invoices/sessions/${sessionId}`, { method: 'DELETE' })
    setIsDeleting(false)
    setDeleteConfirm(null)
    fetchSessions()
    if (session?.id === sessionId) handleNewScan()
  }

  // ── Review: add a manual line item ─────────────────────────────────────────
  const handleAddItem = async (desc: string, qty: number | null, unitPrice: number | null) => {
    if (!session || !desc.trim()) return
    await fetch(`/api/invoices/sessions/${session.id}/scanitems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc, qty, unitPrice }),
    })
    await refreshSession(session.id)
    setIsAddingItem(false)
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

  const [isCancelling, setIsCancelling] = useState(false)

  const handleCancelProcessing = async () => {
    if (!session) return
    setIsCancelling(true)
    await fetch(`/api/invoices/sessions/${session.id}/process`, { method: 'DELETE' })
    await refreshSession(session.id)
    setIsCancelling(false)
  }

  const renderProcessing = () => (
    <div className="max-w-xl mx-auto space-y-6 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-100 animate-pulse mb-2">
        <ScanLine size={32} className="text-blue-600" />
      </div>
      <h2 className="text-xl font-bold text-gray-900">Scanning Invoice…</h2>
      <p className="text-sm text-gray-500">
        {session?.files && session.files.length > 1
          ? `Sending all ${session.files.length} pages to Claude at once — usually 15–30 seconds.`
          : 'Claude is reading and extracting line items. Usually 10–20 seconds.'}
      </p>

      <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50 text-left">
        {session?.files.map(f => (
          <div key={f.id} className="flex items-center gap-3 px-4 py-3">
            {fileIcon(f.fileType)}
            <span className="flex-1 text-sm text-gray-700 truncate">{f.fileName}</span>
            {ocrStatusBadge(f.ocrStatus)}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 size={14} className="animate-spin" />
          Processing…
        </div>
        <button
          onClick={handleCancelProcessing}
          disabled={isCancelling}
          className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
          {isCancelling ? 'Cancelling…' : 'Cancel'}
        </button>
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

    // Duplicate detection: look for an APPROVED session with the same invoice number
    const duplicateSession = session.invoiceNumber
      ? sessions.find(s => s.id !== session.id && s.status === 'APPROVED' && s.invoiceNumber === session.invoiceNumber)
      : null

    // Invoice total validation
    const scannedTotal = session.scanItems
      .filter(i => i.action !== 'SKIP')
      .reduce((sum, i) => {
        const lt = i.rawLineTotal !== null
          ? Number(i.rawLineTotal)
          : (i.rawQty !== null && i.rawUnitPrice !== null ? Number(i.rawQty) * Number(i.rawUnitPrice) : 0)
        return sum + lt
      }, 0)
    const invoiceTotal = session.total ? Number(session.total) : null
    const totalDiff = invoiceTotal !== null ? invoiceTotal - scannedTotal : null
    const totalIsOver = totalDiff !== null && totalDiff < -0.50
    const totalIsOk   = totalDiff !== null && totalDiff >= 0 && totalDiff < (invoiceTotal ?? 0) * 0.25

    return (
      <div className="space-y-4">

        {/* ── Invoice document ── */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">

          {/* Invoice header band */}
          <div className="bg-gradient-to-r from-slate-700 to-slate-800 px-5 py-4 text-white">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Invoice Review</p>
                <h2 className="text-lg font-bold leading-tight truncate">{session.supplierName || 'Unknown Supplier'}</h2>
              </div>
              <div className="text-right shrink-0">
                {session.invoiceNumber && (
                  <div className="flex items-center gap-1 justify-end text-slate-300 text-xs mb-0.5">
                    <Hash size={10} /><span className="font-mono font-semibold text-white">{session.invoiceNumber}</span>
                  </div>
                )}
                {session.total && (
                  <div className="text-xl font-bold text-white">{formatCurrency(Number(session.total))}</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-5 mt-3 text-xs">
              {session.invoiceDate && (
                <div className="flex items-center gap-1 text-slate-300">
                  <CalendarDays size={11} />
                  <span>{session.invoiceDate}</span>
                </div>
              )}
              <div className="flex items-center gap-1 text-slate-300">
                <Package size={11} />
                <span>{totalItems} line item{totalItems !== 1 ? 's' : ''}</span>
              </div>
              {actionCounts['UPDATE_PRICE'] > 0 && (
                <span className="text-blue-300 font-medium">{actionCounts['UPDATE_PRICE']} price update{actionCounts['UPDATE_PRICE'] !== 1 ? 's' : ''}</span>
              )}
              {actionCounts['CREATE_NEW'] > 0 && (
                <span className="text-purple-300 font-medium">{actionCounts['CREATE_NEW']} new item{actionCounts['CREATE_NEW'] !== 1 ? 's' : ''}</span>
              )}
              <button onClick={handleNewScan} className="ml-auto flex items-center gap-1 text-slate-400 hover:text-white transition-colors">
                <X size={12} /> Cancel
              </button>
            </div>
          </div>

          {/* Duplicate invoice warning */}
          {duplicateSession && !duplicateDismissed && (
            <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 text-sm">
              <div className="flex items-start gap-3">
                <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-amber-800">Duplicate invoice detected.</span>
                  <span className="text-amber-700 ml-1">
                    Invoice #{session.invoiceNumber} from {duplicateSession.supplierName || 'this supplier'} was already approved
                    {duplicateSession.invoiceDate ? ` on ${duplicateSession.invoiceDate}` : ''}.
                    Applying this again may create duplicate price entries.
                  </span>
                </div>
              </div>
              <div className="flex gap-2 mt-2.5 pl-6">
                <button
                  onClick={() => setDuplicateDismissed(true)}
                  className="px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-amber-800 text-xs font-medium hover:bg-amber-100 transition-colors"
                >
                  Proceed anyway
                </button>
                <button
                  onClick={() => setSession(null)}
                  className="px-3 py-1.5 rounded-lg bg-amber-700 text-white text-xs font-medium hover:bg-amber-800 transition-colors"
                >
                  Cancel — this is a duplicate
                </button>
              </div>
            </div>
          )}

          {/* Total validation bar */}
          {(invoiceTotal !== null || scannedTotal > 0) && (
            <div className={`flex items-center gap-2 px-4 py-2 border-b text-xs ${
              totalIsOver ? 'bg-red-50 border-red-200' :
              totalIsOk   ? 'bg-green-50 border-green-200' :
                            'bg-gray-50 border-gray-200'
            }`}>
              <div className="flex items-center gap-2 flex-1 flex-wrap">
                <span className="text-gray-500">Scanned:</span>
                <span className={`font-bold ${totalIsOver ? 'text-red-700' : 'text-gray-800'}`}>{formatCurrency(scannedTotal)}</span>
                {invoiceTotal !== null && (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-500">Invoice total:</span>
                    <span className="font-bold text-gray-800">{formatCurrency(invoiceTotal)}</span>
                    {totalDiff !== null && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className={`font-medium ${totalIsOver ? 'text-red-600' : 'text-gray-400'}`}>
                          {totalIsOver
                            ? `⚠ Items exceed total by ${formatCurrency(Math.abs(totalDiff))}`
                            : `${formatCurrency(totalDiff)} in taxes/fees`}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              {totalIsOk && <span className="text-green-600 font-semibold">✓ Match</span>}
            </div>
          )}

          {/* Line items */}
          <div className="divide-y divide-gray-50">
            {session.scanItems.map(item => (
              <div key={item.id} className="px-3 py-0.5">
                <ScanItemCard
                  item={item}
                  onUpdate={(updates) => updateScanItem(item.id, updates)}
                  onOpenDetail={() => setEditingItem(item)}
                  onEditInventory={(invId, scanItem) => setEditingInventory({ inventoryItemId: invId, scanItem })}
                />
              </div>
            ))}
            {session.scanItems.length === 0 && (
              <div className="py-8 text-center text-sm text-gray-400">
                {session.files?.some(f => f.ocrStatus === 'ERROR')
                  ? <span className="text-red-500">OCR failed — the invoice couldn&apos;t be read. Check the image quality and try scanning again.</span>
                  : 'No items scanned yet — add line items manually or start a new scan.'}
              </div>
            )}
          </div>

          {/* Add line item row */}
          <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
            <button
              onClick={() => setIsAddingItem(true)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
            >
              <Plus size={15} className="border border-blue-300 rounded" /> Add line item manually
            </button>
          </div>

          {/* Invoice totals footer */}
          {(scannedTotal > 0 || invoiceTotal !== null) && (
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-200">
              <div className="flex flex-col items-end gap-1 text-sm">
                <div className="flex items-center gap-6">
                  <span className="text-gray-500">Subtotal (scanned items)</span>
                  <span className="font-semibold text-gray-800 w-24 text-right">{formatCurrency(scannedTotal)}</span>
                </div>
                {invoiceTotal !== null && totalDiff !== null && totalDiff > 0 && (
                  <div className="flex items-center gap-6 text-gray-400">
                    <span>Taxes &amp; fees</span>
                    <span className="w-24 text-right">{formatCurrency(totalDiff)}</span>
                  </div>
                )}
                {invoiceTotal !== null && (
                  <div className="flex items-center gap-6 border-t border-gray-200 pt-1 mt-1">
                    <span className="font-bold text-gray-700">Invoice Total</span>
                    <span className="font-bold text-gray-900 w-24 text-right">{formatCurrency(invoiceTotal)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Item detail / new-item panel */}
        {editingItem && (
          <ItemDetailPanel
            item={editingItem}
            onSave={async (updates) => {
              await updateScanItem(editingItem.id, updates)
              setEditingItem(null)
            }}
            onClose={() => setEditingItem(null)}
          />
        )}

        {editingInventory && (
          <InventoryEditModal
            inventoryItemId={editingInventory.inventoryItemId}
            scanItem={editingInventory.scanItem}
            onSaved={async (updates) => {
              await updateScanItem(editingInventory.scanItem.id, updates)
              setEditingInventory(null)
            }}
            onClose={() => setEditingInventory(null)}
          />
        )}

        {/* Add item modal */}
        {isAddingItem && (
          <AddItemModal
            onAdd={handleAddItem}
            onClose={() => setIsAddingItem(false)}
          />
        )}

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
              placeholder="Your name"
              value={approvedBy}
              onChange={e => { setApprovedBy(e.target.value); localStorage.setItem('approvedBy', e.target.value) }}
              className={`border rounded-lg px-3 py-1.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500 ${!approvedBy ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}
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
                    <div className="flex items-center justify-end gap-1">
                      {s.status === 'REVIEW' || s.status === 'PROCESSING' ? (
                        <button
                          onClick={async () => { const data = await refreshSession(s.id); setSession(data); setApproveResult(null); setView('scanner') }}
                          className="text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 px-2 py-1 rounded transition-colors flex items-center gap-1"
                        >
                          <ArrowRight size={10} /> Resume
                        </button>
                      ) : s.status === 'APPROVED' ? (
                        <button
                          onClick={() => handleEditSession(s.id)}
                          className="text-xs bg-gray-100 text-gray-600 hover:bg-gray-200 px-2 py-1 rounded transition-colors flex items-center gap-1"
                          title="Re-open for editing"
                        >
                          <Pencil size={10} /> Edit
                        </button>
                      ) : null}
                      <button
                        onClick={() => setDeleteConfirm({ id: s.id, status: s.status })}
                        className="p-1 text-gray-300 hover:text-red-500 transition-colors rounded"
                        title="Delete invoice"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
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

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <DeleteConfirmModal
          isApproved={deleteConfirm.status === 'APPROVED'}
          onConfirm={() => handleDeleteSession(deleteConfirm.id)}
          onCancel={() => setDeleteConfirm(null)}
          isDeleting={isDeleting}
        />
      )}
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

// ── AddItemModal ──────────────────────────────────────────────────────────────

function AddItemModal({
  onAdd,
  onClose,
}: {
  onAdd: (desc: string, qty: number | null, unitPrice: number | null) => Promise<void>
  onClose: () => void
}) {
  const [desc, setDesc]           = useState('')
  const [qty, setQty]             = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [saving, setSaving]       = useState(false)

  const total = parseFloat(qty) > 0 && parseFloat(unitPrice) > 0
    ? parseFloat(qty) * parseFloat(unitPrice)
    : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!desc.trim()) return
    setSaving(true)
    await onAdd(
      desc.trim(),
      parseFloat(qty) || null,
      parseFloat(unitPrice) || null,
    )
    setSaving(false)
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div>
              <h3 className="font-semibold text-gray-900">Add Line Item</h3>
              <p className="text-xs text-gray-400 mt-0.5">Manually add a missing item to this invoice</p>
            </div>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Description <span className="text-red-400">*</span></label>
              <input
                autoFocus
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="e.g. Cream 4/4L, Chicken Breast, Olive Oil 3L…"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Qty ordered</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  placeholder="1"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Unit price ($)</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={unitPrice}
                  onChange={e => setUnitPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {total !== null && (
              <div className="flex items-center justify-between text-sm bg-blue-50 rounded-lg px-3 py-2">
                <span className="text-blue-600">Line total</span>
                <span className="font-bold text-blue-800">{new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(total)}</span>
              </div>
            )}

            <p className="text-xs text-gray-400">
              You can fill in the pack format and match it to inventory after adding.
            </p>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={!desc.trim() || saving}
                className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {saving ? 'Adding…' : 'Add to Invoice'}
              </button>
              <button type="button" onClick={onClose}
                className="border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}

// ── DeleteConfirmModal ────────────────────────────────────────────────────────

function DeleteConfirmModal({
  isApproved,
  onConfirm,
  onCancel,
  isDeleting,
}: {
  isApproved: boolean
  onConfirm: () => void
  onCancel: () => void
  isDeleting: boolean
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onCancel} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 size={18} className="text-red-600" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Delete Invoice?</h3>
                <p className="text-sm text-gray-500 mt-1">This action cannot be undone.</p>
              </div>
            </div>

            {isApproved && (
              <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
                <AlertCircle size={15} className="text-amber-500 shrink-0 mt-0.5" />
                <p>
                  This invoice was <strong>approved</strong> and prices were applied to inventory.
                  Deleting it will <strong>revert those prices</strong> back to their previous values.
                </p>
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={onConfirm}
                disabled={isDeleting}
                className="flex-1 bg-red-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {isDeleting ? 'Deleting…' : isApproved ? 'Delete & Revert Prices' : 'Delete Invoice'}
              </button>
              <button onClick={onCancel} disabled={isDeleting}
                className="border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50 disabled:opacity-50">
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
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

// ── InventorySearchResult ─────────────────────────────────────────────────────

interface InventorySearchResult {
  id: string
  itemName: string
  abbreviation: string | null
  purchaseUnit: string
  purchasePrice: number
  pricePerBaseUnit: number
  baseUnit: string
  category: string
  qtyPerPurchaseUnit: number
  packSize: number
  packUOM: string
}

// ── ScanItemCard ──────────────────────────────────────────────────────────────

function ScanItemCard({
  item,
  onUpdate,
  onOpenDetail,
  onEditInventory,
}: {
  item: ScanItem
  onUpdate: (updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> | string | null }>) => void
  onOpenDetail: () => void
  onEditInventory: (inventoryItemId: string, scanItem: ScanItem) => void
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<InventorySearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  // Unified purchase details (cases + pack format + pricing — all linked)
  const [editingPurchase, setEditingPurchase] = useState(
    item.needsFormatConfirm || item.rawUnitPrice === null
  )
  const [localCases, setLocalCases]       = useState(String(item.rawQty ?? ''))
  const [localUnit, setLocalUnit]         = useState(item.rawUnit ?? 'cs')
  const [localPackQty, setLocalPackQty]   = useState(String(item.invoicePackQty ?? ''))
  const [localPackSize, setLocalPackSize] = useState(String(item.invoicePackSize ?? ''))
  const [localPackUOM, setLocalPackUOM]   = useState(item.invoicePackUOM ?? '')
  const [localUnitPrice, setLocalUnitPrice] = useState(String(item.rawUnitPrice ?? ''))
  const [localLineTotal, setLocalLineTotal] = useState(
    String(item.rawLineTotal
      ?? (item.rawQty !== null && item.rawUnitPrice !== null
          ? Number(item.rawQty) * Number(item.rawUnitPrice)
          : '')
    )
  )
  const searchRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const search = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setIsSearching(true)
      const res = await fetch(`/api/inventory/search?q=${encodeURIComponent(q)}&limit=8`)
      const data = await res.json()
      setSearchResults(data)
      setIsSearching(false)
    }, 200)
  }

  const handleSearchFocus = () => {
    // Pre-populate with current match name or item description
    const defaultQ = item.matchedItem?.itemName ?? descriptionToKeywords(item.rawDescription)
    setSearchQuery(defaultQ)
    search(defaultQ)
    setShowDropdown(true)
  }

  const handleSearchInput = (q: string) => {
    setSearchQuery(q)
    search(q)
    setShowDropdown(true)
  }

  const handleSelectItem = (inv: InventorySearchResult) => {
    const pq = parseFloat(localPackQty) || null
    const ps = parseFloat(localPackSize) || null
    const pUOM = localPackUOM || null
    const rawPrice = parseFloat(localUnitPrice) || (item.rawUnitPrice !== null ? Number(item.rawUnitPrice) : null)

    let newPrice: number | null = rawPrice
    let priceDiffPct: number | null = null

    if (pq && ps && ps > 0 && pUOM && rawPrice !== null) {
      // Normalize using unit-aware comparison (handles L vs mL, kg vs g, etc.)
      const invoicePricePerPackUOM = rawPrice / (Number(pq) * Number(ps))
      const invPackTotal = Number(inv.qtyPerPurchaseUnit) * Number(inv.packSize)
      const invPricePerPackUOM = invPackTotal > 0 ? Number(inv.purchasePrice) / invPackTotal : 0
      const normalized = comparePricesNormalized(
        invoicePricePerPackUOM, pUOM,
        invPricePerPackUOM, inv.packUOM
      )
      if (normalized) {
        priceDiffPct = normalized.pctDiff
        const calcPrice = calcNewPurchasePrice(
          invoicePricePerPackUOM, pUOM,
          Number(inv.qtyPerPurchaseUnit), Number(inv.packSize), inv.packUOM
        )
        if (calcPrice !== null) newPrice = calcPrice
      } else {
        // Incompatible units — fall back to direct comparison
        const prevPrice = Number(inv.purchasePrice)
        priceDiffPct = prevPrice > 0 ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    } else {
      // No format info — direct comparison
      const prevPrice = Number(inv.purchasePrice)
      priceDiffPct = prevPrice > 0 && rawPrice !== null
        ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100
        : null
    }

    const action: LineItemAction = newPrice !== null && Math.abs(Number(priceDiffPct ?? 0)) > 0.1
      ? 'UPDATE_PRICE' : 'ADD_SUPPLIER'

    onUpdate({ matchedItemId: inv.id, action, previousPrice: Number(inv.purchasePrice), newPrice, priceDiffPct, matchConfidence: 'HIGH', matchScore: 100 })
    setShowDropdown(false)
  }

  const handleSelectCreateNew = () => {
    onUpdate({ matchedItemId: null, action: 'CREATE_NEW', previousPrice: null, priceDiffPct: null })
    setShowDropdown(false)
  }

  // ── Linked calculators ────────────────────────────────────────────────────
  const handleCasesChange = (v: string) => {
    setLocalCases(v)
    const cases = parseFloat(v), price = parseFloat(localUnitPrice)
    if (cases > 0 && price > 0) setLocalLineTotal((cases * price).toFixed(2))
  }
  const handleUnitPriceChange = (v: string) => {
    setLocalUnitPrice(v)
    const cases = parseFloat(localCases), price = parseFloat(v)
    if (cases > 0 && price > 0) setLocalLineTotal((cases * price).toFixed(2))
  }
  const handleLineTotalChange = (v: string) => {
    setLocalLineTotal(v)
    const cases = parseFloat(localCases), total = parseFloat(v)
    if (cases > 0 && total > 0) setLocalUnitPrice((total / cases).toFixed(2))
  }

  // ── Unified save (purchases + format + price diff all at once) ────────────
  const handlePurchaseSave = () => {
    const cases     = parseFloat(localCases)     || null
    const unitPrice = parseFloat(localUnitPrice) || null
    const manualTotal = parseFloat(localLineTotal) || null
    const lineTotal = manualTotal ?? (cases !== null && unitPrice !== null ? cases * unitPrice : null)
    const pq  = parseFloat(localPackQty)  || null
    const ps  = parseFloat(localPackSize) || null
    const pUOM = localPackUOM || null

    let newPrice: number | null = unitPrice
    let priceDiffPct: number | null = null

    if (unitPrice !== null && item.matchedItem) {
      if (pq && ps && Number(ps) > 0 && pUOM) {
        const invoicePPU = unitPrice / (pq * ps)
        const invPackTotal2 = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
        const invPPU2 = invPackTotal2 > 0 ? Number(item.matchedItem.purchasePrice) / invPackTotal2 : 0
        const normalized = comparePricesNormalized(
          invoicePPU, pUOM,
          invPPU2, item.matchedItem.packUOM
        )
        if (normalized) {
          priceDiffPct = normalized.pctDiff
          const calcPrice = calcNewPurchasePrice(
            invoicePPU, pUOM,
            Number(item.matchedItem.qtyPerPurchaseUnit), Number(item.matchedItem.packSize), item.matchedItem.packUOM
          )
          if (calcPrice !== null) newPrice = calcPrice
        } else {
          const prevPrice = Number(item.matchedItem.purchasePrice)
          priceDiffPct = prevPrice > 0 ? Math.round(((unitPrice - prevPrice) / prevPrice) * 10000) / 100 : null
        }
      } else {
        const prevPrice = Number(item.matchedItem.purchasePrice)
        priceDiffPct = prevPrice > 0 ? Math.round(((unitPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    }

    onUpdate({
      rawQty:       cases,
      rawUnit:      localUnit || null,
      rawUnitPrice: unitPrice,
      rawLineTotal: lineTotal,
      invoicePackQty:  pq,
      invoicePackSize: ps,
      invoicePackUOM:  pUOM,
      needsFormatConfirm: false,
      newPrice,
      priceDiffPct,
      action: Math.abs(Number(priceDiffPct ?? 0)) > 0.1 ? 'UPDATE_PRICE'
            : (item.matchedItemId ? 'ADD_SUPPLIER' : item.action),
    })
    setEditingPurchase(false)
  }

  const accentClass =
    item.action === 'SKIP'           ? 'border-l-gray-200 opacity-50' :
    item.action === 'CREATE_NEW'     ? 'border-l-purple-400' :
    editingPurchase                  ? 'border-l-amber-400' :
    item.action === 'UPDATE_PRICE'   ? 'border-l-blue-400' :
    item.action === 'ADD_SUPPLIER'   ? 'border-l-green-400' :
    item.matchConfidence === 'HIGH'  ? 'border-l-green-300' :
    item.matchConfidence === 'MEDIUM'? 'border-l-yellow-300' :
    item.matchConfidence === 'LOW'   ? 'border-l-orange-300' :
                                       'border-l-gray-200'

  const priceDiff     = item.priceDiffPct ? Number(item.priceDiffPct) : null
  const newItemFilled = item.action === 'CREATE_NEW' && item.newItemData
  const displayName   = item.matchedItem?.itemName ?? null

  // Derived display values (from saved item props — shown in view mode)
  const savedLineTotal =
    item.rawLineTotal !== null ? Number(item.rawLineTotal)
    : (item.rawQty !== null && item.rawUnitPrice !== null ? Number(item.rawQty) * Number(item.rawUnitPrice) : null)

  // Live base cost from current local state (used in edit mode preview)
  const liveBaseCost = (() => {
    const price = parseFloat(localUnitPrice)
    const pq    = parseFloat(localPackQty)
    const ps    = parseFloat(localPackSize)
    if (price > 0 && pq > 0 && ps > 0 && localPackUOM) return price / (pq * ps)
    return null
  })()

  // Saved base cost from item props (used in view mode)
  const savedBaseCost = (() => {
    if (!item.rawUnitPrice || !item.invoicePackQty || !item.invoicePackSize) return null
    const pq = Number(item.invoicePackQty), ps = Number(item.invoicePackSize)
    if (pq <= 0 || ps <= 0) return null
    return Number(item.rawUnitPrice) / (pq * ps)
  })()

  return (
    <div className={`bg-white rounded-xl border border-gray-100 border-l-4 ${accentClass} px-3 py-2.5 transition-all`}>

      {/* ── Row 1: Description + skip ── */}
      <div className="flex items-start justify-between gap-2">
        <span className={`font-medium text-sm leading-snug flex-1 min-w-0 ${item.action === 'SKIP' ? 'line-through text-gray-400' : 'text-gray-900'}`}>
          {item.rawDescription}
        </span>
        <button
          onClick={() => onUpdate({ action: item.action === 'SKIP' ? (item.matchedItemId ? 'UPDATE_PRICE' : 'CREATE_NEW') : 'SKIP' })}
          className={`shrink-0 p-0.5 rounded transition-colors ${item.action === 'SKIP' ? 'text-gray-500 bg-gray-100' : 'text-gray-200 hover:text-red-400'}`}
          title={item.action === 'SKIP' ? 'Restore' : 'Skip'}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Row 2: Purchase details (view or edit) ── */}
      {item.action !== 'SKIP' && (
        <div className="mt-1">
          {/* VIEW MODE — compact summary */}
          {!editingPurchase && (
            <div className="flex items-center gap-1.5 text-xs flex-wrap">
              {/* cases */}
              {item.rawQty !== null && (
                <span className="font-semibold text-gray-700">{item.rawQty} {item.rawUnit || 'cs'}</span>
              )}
              {/* pack format */}
              {item.invoicePackQty && item.invoicePackSize && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-600">
                    {Number(item.invoicePackQty)} × {Number(item.invoicePackSize)}{item.invoicePackUOM}
                  </span>
                </>
              )}
              {/* unit price */}
              {item.rawUnitPrice !== null && (
                <>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-600">{formatCurrency(Number(item.rawUnitPrice))}/case</span>
                </>
              )}
              {/* total */}
              {savedLineTotal !== null && (
                <>
                  <span className="text-gray-400">=</span>
                  <span className="font-bold text-gray-800">{formatCurrency(savedLineTotal)}</span>
                </>
              )}
              {/* base cost */}
              {savedBaseCost !== null && item.invoicePackUOM && (() => {
                const pUOM = item.invoicePackUOM!
                if (item.matchedItem) {
                  const _invPkgTotal = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
                  const _invPPU = _invPkgTotal > 0 ? Number(item.matchedItem.purchasePrice) / _invPkgTotal : 0
                  const norm = comparePricesNormalized(savedBaseCost, pUOM, _invPPU, item.matchedItem.packUOM)
                  if (norm) return (
                    <>
                      <span className="text-gray-300">·</span>
                      <span className={`font-semibold ${priceDiff !== null && priceDiff > 0 ? 'text-red-500' : priceDiff !== null ? 'text-green-500' : 'text-gray-600'}`}>
                        {formatCurrency(norm.invoicePPB)}/{norm.baseUnit}
                      </span>
                    </>
                  )
                }
                return (
                  <>
                    <span className="text-gray-300">·</span>
                    <span className="text-gray-500">{formatCurrency(savedBaseCost)}/{pUOM}</span>
                  </>
                )
              })()}
              <button onClick={() => setEditingPurchase(true)} className="text-gray-200 hover:text-blue-400 ml-0.5" title="Edit"><Pencil size={10} /></button>
            </div>
          )}

          {/* EDIT MODE — labeled linked calculator */}
          {editingPurchase && (
            <div className="mt-1 space-y-1.5">
              <div className="flex items-end gap-1.5 flex-wrap text-xs">
                {/* Qty Ordered */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Qty ordered</span>
                  <div className="flex items-center gap-0.5">
                    <input type="number" step="any" min="0" value={localCases}
                      onChange={e => handleCasesChange(e.target.value)}
                      className="w-12 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    <input value={localUnit} onChange={e => setLocalUnit(e.target.value)}
                      placeholder="cs"
                      className="w-9 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                  </div>
                </div>
                <span className="text-gray-400 pb-1">×</span>
                {/* Qty per case */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Qty/case</span>
                  <input type="number" step="any" min="0" value={localPackQty}
                    onChange={e => setLocalPackQty(e.target.value)}
                    className="w-14 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <span className="text-gray-400 pb-1">×</span>
                {/* Pack size + UOM */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Pack size</span>
                  <div className="flex items-center gap-0.5">
                    <input type="number" step="any" min="0" value={localPackSize}
                      onChange={e => setLocalPackSize(e.target.value)}
                      className="w-14 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                    <select value={localPackUOM} onChange={e => setLocalPackUOM(e.target.value)}
                      className="border border-blue-300 rounded px-1 py-1 bg-blue-50 focus:outline-none text-xs">
                      <option value="">—</option>
                      <option value="L">L</option>
                      <option value="ml">mL</option>
                      <option value="kg">kg</option>
                      <option value="g">g</option>
                      <option value="lb">lb</option>
                      <option value="oz">oz</option>
                      <option value="each">each</option>
                    </select>
                  </div>
                </div>
                <span className="text-gray-400 pb-1">@</span>
                {/* Unit price */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Unit price</span>
                  <input type="number" step="any" min="0" value={localUnitPrice}
                    onChange={e => handleUnitPriceChange(e.target.value)}
                    className="w-18 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400" />
                </div>
                <span className="text-gray-400 pb-1">=</span>
                {/* Total */}
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[9px] text-gray-400 uppercase tracking-wide">Total</span>
                  <input type="number" step="any" min="0" value={localLineTotal}
                    onChange={e => handleLineTotalChange(e.target.value)}
                    className="w-20 border border-blue-300 rounded px-1 py-1 text-center bg-blue-50 focus:outline-none focus:ring-1 focus:ring-blue-400 font-semibold" />
                </div>
                {/* Save / cancel */}
                <div className="flex items-center gap-1 pb-0.5">
                  <button onClick={handlePurchaseSave}
                    className="bg-blue-600 text-white px-2 py-1 rounded text-xs hover:bg-blue-700 transition-colors font-medium">✓</button>
                  <button onClick={() => setEditingPurchase(false)}
                    className="text-gray-400 hover:text-gray-600 px-1 text-xs">✕</button>
                </div>
              </div>
              {/* Live base cost preview */}
              {liveBaseCost !== null && localPackUOM && (
                <div className="text-[10px] text-gray-500 ml-0.5">
                  {(() => {
                    if (item.matchedItem) {
                      const _livePkgTotal = Number(item.matchedItem.qtyPerPurchaseUnit) * Number(item.matchedItem.packSize)
                      const _livePPU = _livePkgTotal > 0 ? Number(item.matchedItem.purchasePrice) / _livePkgTotal : 0
                      const norm = comparePricesNormalized(liveBaseCost, localPackUOM, _livePPU, item.matchedItem.packUOM)
                      if (norm) return (
                        <span>
                          base cost: <span className="font-semibold text-gray-700">{formatCurrency(norm.invoicePPB)}/{norm.baseUnit}</span>
                          {' · '}inv: {formatCurrency(norm.inventoryPPB)}/{norm.baseUnit}
                          {' '}
                          <span className={`font-semibold ${norm.pctDiff > 0 ? 'text-red-500' : 'text-green-500'}`}>
                            {norm.pctDiff > 0 ? '+' : ''}{norm.pctDiff.toFixed(1)}%
                          </span>
                        </span>
                      )
                    }
                    return <span>base cost: <span className="font-semibold text-gray-700">{formatCurrency(liveBaseCost)}/{localPackUOM}</span></span>
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Row 3: Inventory match + price diff ── */}
      {item.action !== 'SKIP' && (
        <div className="flex items-center gap-2 mt-1.5">
          {item.action === 'CREATE_NEW'
            ? <Plus size={11} className="text-purple-400 shrink-0" />
            : <ArrowRight size={11} className="text-gray-300 shrink-0" />
          }

          {/* Search combobox */}
          <div ref={searchRef} className="relative flex-1 min-w-0">
            <div
              className="flex items-center gap-1.5 cursor-pointer group"
              onClick={() => { if (!showDropdown) handleSearchFocus() }}
            >
              <input
                className={`flex-1 text-xs font-medium outline-none bg-transparent min-w-0 truncate ${
                  item.action === 'CREATE_NEW' ? 'text-purple-700 placeholder-purple-300' :
                  item.matchedItemId ? 'text-gray-800' : 'text-gray-400'
                } ${showDropdown ? 'cursor-text' : 'cursor-pointer'}`}
                placeholder={item.action === 'CREATE_NEW' ? 'Create new item…' : 'Search inventory…'}
                value={showDropdown ? searchQuery : (displayName ?? (item.action === 'CREATE_NEW' ? 'Create new inventory item' : 'No match — tap to search'))}
                onChange={e => handleSearchInput(e.target.value)}
                onFocus={handleSearchFocus}
                readOnly={!showDropdown}
              />
              {isSearching
                ? <Loader2 size={10} className="animate-spin text-gray-300 shrink-0" />
                : <ChevronDown size={10} className={`text-gray-200 group-hover:text-gray-400 shrink-0 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
              }
            </div>

            {/* Dropdown */}
            {showDropdown && (
              <div className="absolute z-30 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
                {searchResults.length === 0 && !isSearching && (
                  <p className="text-xs text-gray-400 px-3 py-2">No items found</p>
                )}
                {searchResults.map(inv => (
                  <button
                    key={inv.id}
                    onMouseDown={e => { e.preventDefault(); handleSelectItem(inv) }}
                    className="w-full text-left px-3 py-2 hover:bg-blue-50 transition-colors border-b border-gray-50 last:border-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">{inv.itemName}</p>
                        <p className="text-[10px] text-gray-400">{inv.purchaseUnit} · {inv.category}</p>
                      </div>
                      <span className="text-xs text-gray-500 shrink-0">{formatCurrency(Number(inv.purchasePrice))}</span>
                    </div>
                  </button>
                ))}
                <button
                  onMouseDown={e => { e.preventDefault(); handleSelectCreateNew() }}
                  className="w-full text-left px-3 py-2 hover:bg-purple-50 transition-colors flex items-center gap-2"
                >
                  <Plus size={12} className="text-purple-500" />
                  <span className="text-xs font-medium text-purple-700">Create new inventory item</span>
                </button>
              </div>
            )}
          </div>

          {/* Price diff: old → new + % */}
          {item.action === 'UPDATE_PRICE' && priceDiff !== null && item.previousPrice !== null && item.newPrice !== null && (
            <div className="flex items-center gap-1 shrink-0 text-xs">
              <span className="text-gray-400">{formatCurrency(Number(item.previousPrice))}</span>
              <ArrowRight size={9} className="text-gray-300" />
              <span className={`font-semibold ${priceDiff > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatCurrency(Number(item.newPrice))}
              </span>
              <span className={`flex items-center font-bold text-[10px] ${priceDiff > 0 ? 'text-red-500' : 'text-green-500'}`}>
                {priceDiff > 0 ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                {Math.abs(priceDiff).toFixed(1)}%
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            {item.action === 'CREATE_NEW' && (
              <button
                onClick={onOpenDetail}
                className={`text-[10px] px-2 py-0.5 rounded-lg font-medium transition-colors ${
                  newItemFilled ? 'bg-purple-100 text-purple-700 hover:bg-purple-200' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                }`}
              >
                {newItemFilled ? 'Edit' : 'Fill in'}
              </button>
            )}
            {(item.action === 'UPDATE_PRICE' || item.action === 'ADD_SUPPLIER') && item.matchedItemId && (
              <button
                onClick={() => onEditInventory(item.matchedItemId!, item)}
                className="text-gray-200 hover:text-blue-500 transition-colors"
                title="Edit inventory item"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
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

// ── ItemDetailPanel ───────────────────────────────────────────────────────────
// Slide-over panel: full inventory form for CREATE_NEW, read-only detail for matched items.

function parseDescriptionHints(description: string): { qty: number; packSize: number; packUOM: string } {
  // Parse patterns like "4/4L", "1KG", "2.5kg", "4x500ml" from description
  const lower = description.toLowerCase()

  // Pattern: 4/4L or 4/4l (qty per case / pack size + UOM)
  const slashMatch = lower.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (slashMatch) {
    return { qty: Number(slashMatch[1]), packSize: Number(slashMatch[2]), packUOM: slashMatch[3] }
  }

  // Pattern: 4x500ml or 4x500g
  const xMatch = lower.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (xMatch) {
    return { qty: Number(xMatch[1]), packSize: Number(xMatch[2]), packUOM: xMatch[3] }
  }

  // Pattern: standalone "1KG", "500ML" etc.
  const singleMatch = lower.match(/(\d+(?:\.\d+)?)\s*(l|ml|kg|g|lb|oz)\b/)
  if (singleMatch) {
    return { qty: 1, packSize: Number(singleMatch[1]), packUOM: singleMatch[2] }
  }

  return { qty: 1, packSize: 1, packUOM: 'each' }
}

const CATEGORIES = ['BREAD', 'DAIRY', 'DRY', 'FISH', 'MEAT', 'PREPD', 'PROD', 'CHM', 'OTHER'] as const

function ItemDetailPanel({
  item,
  onSave,
  onClose,
}: {
  item: ScanItem
  onSave: (updates: Partial<Omit<ScanItem, 'newItemData'> & { newItemData?: Record<string, unknown> }>) => void
  onClose: () => void
}) {
  const hints = parseDescriptionHints(item.rawDescription)

  // Pre-populate from saved newItemData or from scan hints
  const existing = item.newItemData ? (typeof item.newItemData === 'string' ? JSON.parse(item.newItemData) : item.newItemData) as Record<string, unknown> : null

  const [form, setForm] = useState({
    itemName:           String(existing?.itemName ?? item.rawDescription),
    category:           String(existing?.category ?? 'DRY'),
    purchaseUnit:       String(existing?.purchaseUnit ?? (item.rawUnit || 'case')),
    qtyPerPurchaseUnit: String(existing?.qtyPerPurchaseUnit ?? hints.qty),
    packSize:           String(existing?.packSize ?? hints.packSize),
    packUOM:            String(existing?.packUOM ?? hints.packUOM),
    purchasePrice:      String(existing?.purchasePrice ?? (item.newPrice !== null ? Number(item.newPrice) : '')),
    countUOM:           String(existing?.countUOM ?? hints.packUOM),
  })

  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)
  const cf   = calcConversionFactor(form.countUOM, qty, ps, form.packUOM)
  const bu   = deriveBaseUnit(form.packUOM)

  const isNew = item.action === 'CREATE_NEW'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">
              {isNew ? 'New Inventory Item' : 'Matched Item'}
            </p>
            <h3 className="font-semibold text-gray-900 text-sm truncate mt-0.5">{item.rawDescription}</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Invoice line summary */}
        <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-4 text-xs text-gray-500">
          {item.rawQty !== null && <span><span className="font-medium text-gray-700">{item.rawQty}</span> {item.rawUnit || ''}</span>}
          {item.rawUnitPrice !== null && <span>Unit price: <span className="font-medium text-gray-700">{formatCurrency(Number(item.rawUnitPrice))}</span></span>}
          {item.rawLineTotal !== null && <span>Line total: <span className="font-medium text-gray-700">{formatCurrency(Number(item.rawLineTotal))}</span></span>}
        </div>

        {isNew ? (
          /* ── CREATE_NEW form ──────────────────────────────────────────────── */
          <div className="flex-1 p-4 space-y-4">
            {/* Item name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
              <input
                value={form.itemName}
                onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Purchase structure */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Purchase Structure</label>
              <p className="text-[11px] text-gray-400 mb-2">
                Example: Meadow Milk 4/4L → Purchase Unit = <em>case</em>, Qty per case = <em>4</em>, Pack size = <em>4</em>, Pack UOM = <em>L</em>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Unit</label>
                  <input
                    value={form.purchaseUnit}
                    onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                    placeholder="case, bag, box…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Qty per case</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.qtyPerPurchaseUnit}
                    onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack Size</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.packSize}
                    onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                    placeholder="4, 500, 1…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack UOM</label>
                  <select
                    value={form.packUOM}
                    onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    value={form.purchasePrice}
                    onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
                  <select
                    value={form.countUOM}
                    onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-blue-50 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Base unit:</span>
                <span className="font-medium text-blue-800">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Price per {bu}:</span>
                <span className="font-medium text-blue-800">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-blue-600">Total base units per case:</span>
                <span className="font-medium text-blue-800">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
              {cf !== 1 && (
                <div className="flex justify-between text-xs">
                  <span className="text-blue-600">Conversion factor:</span>
                  <span className="font-medium text-blue-800">{cf.toFixed(4)}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── Matched item read-only view ──────────────────────────────────── */
          <div className="flex-1 p-4 space-y-4">
            {item.matchedItem && (
              <>
                <div className="flex items-center gap-2">
                  <Package size={14} className="text-blue-500" />
                  <span className="font-semibold text-gray-900 text-sm">{item.matchedItem.itemName}</span>
                  {confidenceBadge(item.matchConfidence)}
                </div>

                <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-xs text-gray-400">Purchase Unit</p>
                      <p className="font-medium text-gray-900">{item.matchedItem.purchaseUnit}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Current Price</p>
                      <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.purchasePrice))}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Price / Base Unit</p>
                      <p className="font-medium text-gray-900">{formatCurrency(Number(item.matchedItem.pricePerBaseUnit))}</p>
                    </div>
                  </div>
                </div>

                {item.action === 'UPDATE_PRICE' && item.newPrice !== null && (
                  <div className="bg-blue-50 rounded-xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Proposed Price Change</p>
                    <div className="flex items-center gap-3">
                      <div className="text-center">
                        <p className="text-xs text-gray-400">Current</p>
                        <p className="text-lg font-bold text-gray-600">{formatCurrency(Number(item.previousPrice))}</p>
                      </div>
                      <ArrowRight size={16} className="text-gray-300" />
                      <div className="text-center">
                        <p className="text-xs text-gray-400">New</p>
                        <p className="text-lg font-bold text-blue-700">{formatCurrency(Number(item.newPrice))}</p>
                      </div>
                      {item.priceDiffPct !== null && (
                        <div className={`ml-auto flex items-center gap-1 font-bold text-sm ${Number(item.priceDiffPct) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {Number(item.priceDiffPct) > 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                          {Math.abs(Number(item.priceDiffPct)).toFixed(1)}%
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
          {isNew && (
            <button
              onClick={() => {
                onSave({
                  newItemData: {
                    itemName:           form.itemName,
                    category:           form.category,
                    purchaseUnit:       form.purchaseUnit,
                    qtyPerPurchaseUnit: parseFloat(form.qtyPerPurchaseUnit) || 1,
                    packSize:           parseFloat(form.packSize) || 1,
                    packUOM:            form.packUOM,
                    purchasePrice:      parseFloat(form.purchasePrice) || 0,
                    countUOM:           form.countUOM,
                    baseUnit:           bu,
                    pricePerBaseUnit:   ppbu,
                    conversionFactor:   cf,
                  },
                })
              }}
              className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Save Item Details
            </button>
          )}
          <button
            onClick={onClose}
            className={`${isNew ? '' : 'flex-1'} border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50 transition-colors`}
          >
            {isNew ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </>
  )
}

// ── InventoryEditModal ────────────────────────────────────────────────────────
// Opens inline from the invoice review screen to edit an inventory item.
// Saves to DB immediately and recalculates the scan item's price comparison.

function InventoryEditModal({
  inventoryItemId,
  scanItem,
  onSaved,
  onClose,
}: {
  inventoryItemId: string
  scanItem: ScanItem
  onSaved: (updates: Partial<Omit<ScanItem, 'newItemData'>>) => void
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    itemName: '',
    category: 'DRY',
    purchaseUnit: 'each',
    qtyPerPurchaseUnit: '1',
    packSize: '1',
    packUOM: 'each',
    countUOM: 'each',
    purchasePrice: '',
    abbreviation: '',
    location: '',
  })

  // Load the current inventory item
  useEffect(() => {
    fetch(`/api/inventory/${inventoryItemId}`)
      .then(r => r.json())
      .then((data: InventoryFullItem) => {
        setForm({
          itemName:           data.itemName ?? '',
          category:           data.category ?? 'DRY',
          purchaseUnit:       data.purchaseUnit ?? 'each',
          qtyPerPurchaseUnit: String(data.qtyPerPurchaseUnit ?? 1),
          packSize:           String(data.packSize ?? 1),
          packUOM:            data.packUOM ?? 'each',
          countUOM:           data.countUOM ?? 'each',
          purchasePrice:      String(data.purchasePrice ?? ''),
          abbreviation:       data.abbreviation ?? '',
          location:           data.location ?? '',
        })
        setLoading(false)
      })
  }, [inventoryItemId])

  const pp   = parseFloat(form.purchasePrice) || 0
  const qty  = parseFloat(form.qtyPerPurchaseUnit) || 1
  const ps   = parseFloat(form.packSize) || 1
  const bu   = deriveBaseUnit(form.packUOM)
  const ppbu = calcPricePerBaseUnit(pp, qty, ps, form.packUOM)

  const handleSave = async () => {
    setSaving(true)
    const res = await fetch(`/api/inventory/${inventoryItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemName:           form.itemName,
        category:           form.category,
        purchaseUnit:       form.purchaseUnit,
        qtyPerPurchaseUnit: qty,
        packSize:           ps,
        packUOM:            form.packUOM,
        countUOM:           form.countUOM,
        purchasePrice:      pp,
        abbreviation:       form.abbreviation || null,
        location:           form.location || null,
        pricePerBaseUnit:   ppbu,
        baseUnit:           bu,
        conversionFactor:   calcConversionFactor(form.countUOM, qty, ps, form.packUOM),
      }),
    })
    const updatedInv = await res.json()
    setSaving(false)

    // Recalculate scan item price comparison with updated inventory data
    const rawPrice = scanItem.rawUnitPrice !== null ? Number(scanItem.rawUnitPrice) : null
    let newScanPrice: number | null = rawPrice
    let newPriceDiff: number | null = null

    const pq   = scanItem.invoicePackQty  ?? null
    const invPs = scanItem.invoicePackSize ?? null
    const pUOM  = scanItem.invoicePackUOM  ?? null

    if (rawPrice !== null) {
      if (pq && invPs && Number(invPs) > 0 && pUOM) {
        const invoicePPU = rawPrice / (Number(pq) * Number(invPs))
        const updatedInvPkgTotal = Number(updatedInv.qtyPerPurchaseUnit) * Number(updatedInv.packSize)
        const updatedInvPPU = updatedInvPkgTotal > 0 ? Number(updatedInv.purchasePrice) / updatedInvPkgTotal : 0
        const normalized = comparePricesNormalized(
          invoicePPU, pUOM,
          updatedInvPPU, updatedInv.packUOM
        )
        if (normalized) {
          newPriceDiff = normalized.pctDiff
          const calcPrice = calcNewPurchasePrice(
            invoicePPU, pUOM,
            Number(updatedInv.qtyPerPurchaseUnit), Number(updatedInv.packSize), updatedInv.packUOM
          )
          if (calcPrice !== null) newScanPrice = calcPrice
        }
      } else {
        const prevPrice = Number(updatedInv.purchasePrice)
        newPriceDiff = prevPrice > 0 ? Math.round(((rawPrice - prevPrice) / prevPrice) * 10000) / 100 : null
      }
    }

    onSaved({
      previousPrice: Number(updatedInv.purchasePrice),
      newPrice: newScanPrice,
      priceDiffPct: newPriceDiff,
      action: Math.abs(Number(newPriceDiff ?? 0)) > 0.1 ? 'UPDATE_PRICE' : 'ADD_SUPPLIER',
    })
    onClose()
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between gap-2">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium">Edit Inventory Item</p>
            <h3 className="font-semibold text-gray-900 text-sm mt-0.5 truncate">{form.itemName || '…'}</h3>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={24} className="animate-spin text-blue-500" />
          </div>
        ) : (
          <div className="flex-1 p-4 space-y-4">
            {/* Item Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Item Name</label>
              <input value={form.itemName} onChange={e => setForm(f => ({ ...f, itemName: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>

            {/* Category + Abbreviation */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Abbreviation</label>
                <input value={form.abbreviation} onChange={e => setForm(f => ({ ...f, abbreviation: e.target.value }))}
                  placeholder="optional"
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>

            {/* Purchase Structure */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">Purchase Structure</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Unit</label>
                  <input value={form.purchaseUnit} onChange={e => setForm(f => ({ ...f, purchaseUnit: e.target.value }))}
                    placeholder="case, bag…"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Qty per case</label>
                  <input type="number" step="any" min="0" value={form.qtyPerPurchaseUnit}
                    onChange={e => setForm(f => ({ ...f, qtyPerPurchaseUnit: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack Size</label>
                  <input type="number" step="any" min="0" value={form.packSize}
                    onChange={e => setForm(f => ({ ...f, packSize: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Pack UOM</label>
                  <select value={form.packUOM} onChange={e => setForm(f => ({ ...f, packUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {PACK_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Purchase Price ($)</label>
                  <input type="number" step="any" min="0" value={form.purchasePrice}
                    onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Count UOM</label>
                  <select value={form.countUOM} onChange={e => setForm(f => ({ ...f, countUOM: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {COUNT_UOMS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
            </div>

            {/* Auto-calculated preview */}
            <div className="bg-green-50 rounded-lg p-3 space-y-1">
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wide">Auto-calculated</p>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Base unit:</span>
                <span className="font-medium text-green-800">{bu}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Price per {bu}:</span>
                <span className="font-medium text-green-800">{formatCurrency(ppbu)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green-600">Total base units:</span>
                <span className="font-medium text-green-800">{(qty * ps).toFixed(2)} {bu}</span>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-4 py-3 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving || loading}
            className="flex-1 bg-green-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            {saving ? 'Saving…' : 'Save & Update Prices'}
          </button>
          <button onClick={onClose}
            className="border border-gray-200 text-gray-600 rounded-lg py-2 px-4 text-sm hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
