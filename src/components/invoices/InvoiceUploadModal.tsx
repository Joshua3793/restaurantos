'use client'
import { useState, useRef } from 'react'
import {
  Upload, ScanLine, X, Loader2,
  Image, FileText, FileSpreadsheet,
} from 'lucide-react'
import { useUploadThing } from '@/lib/uploadthing-client'

interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
  activeRcId: string | null
}

const fileIcon = (fileType: string) => {
  if (fileType.includes('pdf')) return <FileText size={16} className="text-red-500" />
  if (fileType.includes('csv') || fileType.includes('text')) return <FileSpreadsheet size={16} className="text-green-500" />
  return <Image size={16} className="text-blue-500" />
}

export function InvoiceUploadModal({ onClose, onComplete, activeRcId }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [noApiKey, setNoApiKey] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [uploadStep, setUploadStep] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const utErrorRef = useRef<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => {
      utErrorRef.current = err.message ?? 'Upload service error'
    },
  })

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
    const picked = e.target.files
    if (!picked || picked.length === 0) {
      console.warn('[upload] file input fired with no files')
      return
    }
    const arr = Array.from(picked)
    console.log('[upload] received', arr.length, 'file(s):', arr.map(f => `${f.name} (${f.type}, ${f.size}b)`).join(', '))
    setFiles(prev => [...prev, ...arr])
    e.target.value = ''
  }

  // Compress an image file to ≤1 MB at ≤2000 px using Canvas.
  // Non-image files (PDF, CSV) are returned as-is.
  const compressImageFile = (file: File): Promise<File> => {
    if (!file.type.startsWith('image/') || file.size <= 1 * 1024 * 1024) return Promise.resolve(file)
    return new Promise((resolve) => {
      const img = new window.Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(objectUrl)
        const MAX_DIM = 2000
        let { width, height } = img
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height)
          width  = Math.round(width  * scale)
          height = Math.round(height * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width  = width
        canvas.height = height
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return }
            const name = file.name.replace(/\.[^.]+$/, '.jpg')
            resolve(new File([blob], name, { type: 'image/jpeg' }))
          },
          'image/jpeg',
          0.82,
        )
      }
      img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
      img.src = objectUrl
    })
  }

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setUploadStep(null)
    setNoApiKey(false)

    try {
      // 0. Compress images client-side so large photos become ~0.5-1 MB.
      //    PDFs and CSVs are passed through unchanged.
      setUploadStep('Preparing files…')
      const compressedFiles = await Promise.all(files.map(compressImageFile))

      // 1. Create session
      setUploadStep('Creating session…')
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!sessRes.ok) {
        setScanError(`Session error (${sessRes.status}). Please try again.`)
        return
      }
      const sess = await sessRes.json()

      // 2a. Try UploadThing CDN (8s timeout — fail fast so local fallback kicks in)
      let uploadOk = false
      utErrorRef.current = null
      setUploadStep('Uploading to cloud…')
      try {
        const uploaded = await Promise.race([
          startUpload(compressedFiles),
          new Promise<null>((_, rej) => setTimeout(() => rej(new Error('Cloud upload timed out')), 8_000)),
        ])
        if (uploaded?.length) {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: uploaded.map(f => ({ url: f.ufsUrl ?? f.url, fileName: f.name, fileType: f.type })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch (utErr) {
        utErrorRef.current = utErr instanceof Error ? utErr.message : 'Upload service error'
        // fall through to local
      }

      // 2b. Local fallback — stores compressed files as base64 in DB.
      //    Compressed images are typically <1 MB, well inside Vercel's 4.5 MB body limit.
      if (!uploadOk) {
        const totalBytes = compressedFiles.reduce((s, f) => s + f.size, 0)
        const limitBytes = 4 * 1024 * 1024
        if (totalBytes > limitBytes) {
          setScanError(
            `Files are too large to upload (${(totalBytes / 1024 / 1024).toFixed(1)} MB total after compression). ` +
            `Try using fewer pages, or upload a smaller PDF. ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '')
          )
          return
        }
        setUploadStep('Uploading…')
        const fd = new FormData()
        compressedFiles.forEach(f => fd.append('files', f))
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const errBody = await localRes.json().catch(() => ({}))
          setScanError(
            errBody.error ??
            `Upload failed (${localRes.status}). ` +
            (utErrorRef.current ? `Cloud error: ${utErrorRef.current}. ` : '') +
            `Please try again.`
          )
          return
        }
      }

      // 3. Fire process as fire-and-forget (drawer will poll for status updates)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 4. Close modal and open drawer on new session
      onComplete(sess.id)
    } catch (err) {
      setScanError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreating(false)
      setUploadStep(null)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                <ScanLine size={16} className="text-gold" />
              </div>
              <h2 className="text-base font-bold text-gray-900">Upload Invoice</h2>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
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

            {/* File upload */}
            {(
              <>
                {/* Dropzone is a <label> so the OS file picker is opened by HTML
                    semantics, not a JS click chain. Wrapping the input in an
                    onClick div caused iOS Safari (and some Chromium builds) to
                    re-fire the wrapper's click after the picker closed, silently
                    discarding the selection. */}
                <label
                  htmlFor="invoice-file-input"
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors ${
                    isDragging ? 'border-blue-400 bg-gold/10' : 'border-gray-200 hover:border-blue-300 hover:bg-gray-50'
                  }`}
                >
                  <Upload size={32} className="text-gray-300" />
                  <div className="text-center">
                    <p className="font-medium text-gray-700">Drop files here or click to browse</p>
                    <p className="text-xs text-gray-400 mt-1">JPEG, PNG, PDF, CSV supported</p>
                  </div>
                  <input
                    id="invoice-file-input"
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.csv,text/csv"
                    className="sr-only"
                    onChange={handleFileInput}
                    onClick={e => e.stopPropagation()}
                  />
                </label>

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
              </>
            )}
          </div>

          {/* Footer with Scan button */}
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            <button
              onClick={handleStartScan}
              disabled={files.length === 0 || isCreating}
              className="w-full bg-gold text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isCreating ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {uploadStep ?? (isCreating ? 'Starting…' : `Upload${files.length > 0 ? ` ${files.length} ${files.length > 1 ? 'files' : 'file'}` : ' Invoice'}`)}
            </button>
          </div>
        </div>
      </div>

    </>
  )
}
