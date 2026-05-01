'use client'
import { useState, useRef } from 'react'
import {
  Upload, ScanLine, Camera, X, CheckCircle2, Loader2,
  Image, FileText, FileSpreadsheet,
} from 'lucide-react'
import { useUploadThing } from '@/lib/uploadthing-client'
import { CameraCapture } from '@/components/CameraCapture'

interface Props {
  onClose: () => void
  onComplete: (newSessionId: string) => void
  activeRcId: string | null
}

const MAX_PHOTOS = 5

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
  const [uploadMode, setUploadMode] = useState<'file' | 'camera'>('file')
  const [showCamera, setShowCamera] = useState(false)
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])

  const fileInputRef = useRef<HTMLInputElement>(null)

  const { startUpload, isUploading } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => {
      console.error('UploadThing error:', err)
      setNoApiKey(false)
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
    if (!e.target.files) return
    setFiles(prev => [...prev, ...Array.from(e.target.files!)])
    e.target.value = ''
  }

  const handleCameraCapture = (photo: File) => {
    setFiles(prev => {
      if (prev.length >= MAX_PHOTOS) return prev
      const next = [...prev, photo]
      if (next.length >= MAX_PHOTOS) setShowCamera(false)
      return next
    })
    setPhotoPreviews(prev => {
      if (prev.length >= MAX_PHOTOS) return prev
      return [...prev, URL.createObjectURL(photo)]
    })
  }

  const removePhoto = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx))
    setPhotoPreviews(prev => {
      URL.revokeObjectURL(prev[idx])
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handleStartScan = async () => {
    if (files.length === 0) return
    setIsCreating(true)
    setScanError(null)
    setNoApiKey(false)

    // 1. Create session — tag with the active RC so it's attributable from upload
    const sess = await fetch('/api/invoices/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revenueCenterId: activeRcId }),
    }).then(r => r.json())

    // 2a. Try UploadThing CDN first
    let uploadOk = false
    try {
      const uploaded = await startUpload(files)
      if (uploaded?.length) {
        await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: uploaded.map(f => ({ url: f.ufsUrl, fileName: f.name, fileType: f.type })),
          }),
        })
        uploadOk = true
      }
    } catch { /* fall through */ }

    // 2b. Local fallback
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
    photoPreviews.forEach(url => URL.revokeObjectURL(url))

    // 3. Fire process as fire-and-forget (drawer will poll)
    fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          // Can't set state here — modal may be unmounted. Just patch session back.
          if (!err.error?.includes('ANTHROPIC_API_KEY')) {
            await fetch(`/api/invoices/sessions/${sess.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'UPLOADING' }),
            })
          }
        }
      })
      .catch(() => {})

    // 4. Close modal and open drawer on new session
    onComplete(sess.id)
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
              <h2 className="text-base font-bold text-gray-900">Scan Invoice</h2>
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

            {/* Mode toggle: Upload / Camera */}
            <div className="flex gap-2 p-1 bg-gray-100 rounded-xl">
              <button
                type="button"
                onClick={() => setUploadMode('file')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  uploadMode === 'file'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Upload size={15} /> Upload File
              </button>
              <button
                type="button"
                onClick={() => setUploadMode('camera')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  uploadMode === 'camera'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Camera size={15} /> Use Camera
              </button>
            </div>

            {/* FILE UPLOAD MODE */}
            {uploadMode === 'file' && (
              <>
                <div
                  onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
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
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.csv,text/csv"
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </div>

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

            {/* CAMERA MODE */}
            {uploadMode === 'camera' && (
              <>
                {/* Photo grid */}
                {photoPreviews.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Pages captured
                      </p>
                      <p className="text-xs text-gray-400">{photoPreviews.length} / {MAX_PHOTOS}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {photoPreviews.map((url, i) => (
                        <div key={i} className="relative aspect-[3/4] rounded-xl overflow-hidden border border-gray-200 bg-gray-50">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={`Page ${i + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                            <span className="text-white text-[10px] font-bold">{i + 1}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => removePhoto(i)}
                            className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-red-500 flex items-center justify-center"
                          >
                            <X size={10} className="text-white" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Take photo button */}
                {photoPreviews.length < MAX_PHOTOS ? (
                  <button
                    type="button"
                    onClick={() => setShowCamera(true)}
                    className="w-full border-2 border-dashed border-gold/30 bg-gold/10 hover:bg-gold/15 rounded-2xl py-10 flex flex-col items-center gap-3 transition-colors"
                  >
                    <div className="w-16 h-16 rounded-full bg-gold flex items-center justify-center shadow-lg">
                      <Camera size={28} className="text-white" />
                    </div>
                    <div className="text-center">
                      <p className="font-semibold text-gold">
                        {photoPreviews.length === 0 ? 'Take Photo' : 'Add Another Page'}
                      </p>
                      <p className="text-xs text-blue-500 mt-0.5">
                        {photoPreviews.length === 0
                          ? 'Opens your camera — point at the invoice'
                          : `${MAX_PHOTOS - photoPreviews.length} page${MAX_PHOTOS - photoPreviews.length !== 1 ? 's' : ''} remaining`}
                      </p>
                    </div>
                  </button>
                ) : (
                  <div className="w-full border-2 border-gray-100 bg-gray-50 rounded-2xl py-6 flex flex-col items-center gap-2">
                    <CheckCircle2 size={24} className="text-green-500" />
                    <p className="text-sm font-medium text-gray-600">Maximum {MAX_PHOTOS} pages reached</p>
                    <p className="text-xs text-gray-400">Remove a page above to replace it</p>
                  </div>
                )}

                {photoPreviews.length === 0 && (
                  <p className="text-center text-xs text-gray-400">
                    Multi-page invoice? Take one photo per page, up to {MAX_PHOTOS} pages total.
                  </p>
                )}
              </>
            )}
          </div>

          {/* Footer with Scan button */}
          <div className="px-5 py-4 border-t border-gray-100 shrink-0">
            <button
              onClick={handleStartScan}
              disabled={files.length === 0 || isCreating || isUploading}
              className="w-full bg-gold text-white rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-[#a88930] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {(isCreating || isUploading) ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {isUploading ? 'Uploading…' : isCreating ? 'Starting…' : `Scan ${files.length > 0 ? `${files.length} ${files.length > 1 ? 'pages' : 'file'}` : 'Invoice'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Camera overlay */}
      {showCamera && (
        <CameraCapture
          pageNumber={files.length + 1}
          maxPages={MAX_PHOTOS}
          onCapture={handleCameraCapture}
          onClose={() => setShowCamera(false)}
        />
      )}
    </>
  )
}
