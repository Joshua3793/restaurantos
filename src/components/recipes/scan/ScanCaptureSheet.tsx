'use client'
// Recipe Scan — capture. Phone app: the native page scanner (several pages =
// one scan). Phone browser: the camera, page by page. Desktop: drop a photo,
// PDF, Word or Excel file, or choose one. One upload = one scan; reading
// starts in the background and the scan waits in the Reading list.
import { useState } from 'react'
import { ScanLine, Camera, Upload, X, Loader2, FileText, FileSpreadsheet, Image as ImageIcon } from 'lucide-react'
import { CameraCapture } from '@/components/CameraCapture'
import { compressImageFile } from '@/lib/image-compress'
import { isNative, scanDocument } from '@/lib/capacitor'
import { uploadScanPages, uploadToCloud, type UploadedScanFile } from '@/hooks/useNativeScan'

/** Server cap per scan (MAX_SCAN_FILES in src/lib/recipe-scan/scan-files.ts, which is server-only). */
const MAX_FILES = 10
/** Inline (data:) fallback when the cloud upload fails — base64 of this stays under the 4.5 MB request limit. */
const INLINE_LIMIT_BYTES = 3 * 1024 * 1024

const ACCEPT = [
  'image/*', '.pdf', 'application/pdf',
  '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv', 'text/csv',
].join(',')

/** Client copy of the server's fileKind() — photos, PDF, Word, Excel/CSV. */
function isScannable(f: File): boolean {
  const t = f.type.toLowerCase()
  const ext = f.name.toLowerCase().split('.').pop() ?? ''
  return t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif'].includes(ext)
    || t === 'application/pdf' || ext === 'pdf'
    || t.includes('wordprocessingml') || ext === 'docx'
    || t.includes('spreadsheetml') || t === 'text/csv' || ext === 'xlsx' || ext === 'csv'
}

function fileIcon(f: File) {
  const t = f.type.toLowerCase()
  if (t.startsWith('image/')) return <ImageIcon size={14} className="text-ink-3" />
  if (t.includes('sheet') || t === 'text/csv' || f.name.toLowerCase().endsWith('.csv')) return <FileSpreadsheet size={14} className="text-ink-3" />
  return <FileText size={14} className="text-ink-3" />
}

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'))
    r.readAsDataURL(f)
  })
}

/** When the cloud upload fails, small files ride inline in the request (the server accepts data: files). */
async function inlineFallback(files: File[]): Promise<UploadedScanFile[] | string> {
  const total = files.reduce((s, f) => s + f.size, 0)
  if (total > INLINE_LIMIT_BYTES) {
    return `The upload didn't go through and the files are too big to send another way (${(total / 1024 / 1024).toFixed(1)} MB). Try again, or use fewer pages.`
  }
  return Promise.all(files.map(async f => ({
    url: await readAsDataUrl(f),
    fileName: f.name,
    fileType: f.type || 'application/octet-stream',
  })))
}

interface Props {
  activeRcId: string | null
  onClose: () => void
  /** The scan was created as READING — the caller starts the read and refreshes the list. */
  onCreated: (scanId: string) => void
}

export function ScanCaptureSheet({ activeRcId, onClose, onCreated }: Props) {
  const native = isNative()
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [camera, setCamera] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busy = step !== null

  const addFiles = (incoming: File[]) => {
    const ok = incoming.filter(isScannable)
    const skipped = incoming.length - ok.length
    const room = MAX_FILES - files.length
    setFiles(prev => [...prev, ...ok].slice(0, MAX_FILES))
    if (ok.length > room) setError(`Up to ${MAX_FILES} files per scan.`)
    else if (skipped > 0) setError(`${skipped === 1 ? 'One file was' : `${skipped} files were`} skipped — use a photo, PDF, Word or Excel file.`)
    else setError(null)
  }

  const createScan = async (uploaded: UploadedScanFile[]) => {
    setStep('Starting…')
    const res = await fetch('/api/recipe-scans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: uploaded, revenueCenterId: activeRcId }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body?.id) {
      setError(body?.error ?? `Couldn't start the scan (${res.status}). Try again.`)
      return
    }
    onCreated(body.id)
    onClose()
  }

  // Desktop / phone browser: the files picked, dropped or photographed.
  const handleRead = async () => {
    if (files.length === 0 || busy) return
    setError(null)
    try {
      setStep('Preparing…')
      const prepared = await Promise.all(files.map(compressImageFile))
      setStep('Uploading…')
      const totalMb = prepared.reduce((s, f) => s + f.size, 0) / 1024 / 1024
      // Generous for a large PDF on kitchen wifi; scanned pages use the 8 s default.
      const timeout = Math.min(60_000, 8_000 + Math.ceil(totalMb) * 4_000)
      const uploaded = (await uploadToCloud(prepared, 'recipeScanUploader', timeout)) ?? await inlineFallback(prepared)
      if (typeof uploaded === 'string') { setError(uploaded); return }
      await createScan(uploaded)
    } catch (e) {
      setError(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStep(null)
    }
  }

  // Phone app: the native scanner, straight through like the invoice screen.
  const handleNativeScan = async () => {
    if (busy) return
    setError(null)
    try {
      setStep('Opening the scanner…')
      const pages = await scanDocument()
      if (!pages.length) return
      setStep('Uploading…')
      const { files: pageFiles, uploaded } = await uploadScanPages(pages, 'recipeScanUploader')
      const list = uploaded ?? await inlineFallback(pageFiles)
      if (typeof list === 'string') { setError(list); return }
      await createScan(list)
    } catch (e) {
      setError(`Scan error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setStep(null)
    }
  }

  if (camera) {
    return (
      <CameraCapture
        title="Scan recipe"
        fileStem="recipe"
        pageNumber={files.length + 1}
        maxPages={MAX_FILES}
        onCapture={f => addFiles([f])}
        onClose={() => setCamera(false)}
      />
    )
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={busy ? undefined : onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
        <div
          role="dialog"
          aria-label="Scan a recipe"
          className="pointer-events-auto relative bg-paper w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col"
          style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - 2rem)' }}
        >
          {/* Head */}
          <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line shrink-0">
            <div className="flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gold-soft grid place-items-center shrink-0">
                <ScanLine size={16} className="text-gold-2" />
              </div>
              <div>
                <h2 className="text-[15px] font-semibold text-ink tracking-[-0.02em]">Scan a recipe</h2>
                <p className="text-[12.5px] text-ink-3 mt-0.5">
                  A cookbook page, a PDF, Word or Excel. A file with several recipes is split into one per recipe.
                </p>
              </div>
            </div>
            <button onClick={onClose} disabled={busy} aria-label="Close" className="p-1.5 rounded-lg text-ink-4 hover:bg-bg-2 disabled:opacity-40">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {error && (
              <div className="bg-red-soft rounded-xl px-3.5 py-3 text-[13px] text-red-text">{error}</div>
            )}

            {native ? (
              <button
                onClick={handleNativeScan}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-[14px] font-semibold text-paper bg-ink hover:bg-ink-2 disabled:opacity-50"
              >
                <ScanLine size={17} className="text-gold" />
                Scan pages
              </button>
            ) : (
              <button
                onClick={() => setCamera(true)}
                disabled={busy || files.length >= MAX_FILES}
                className="sm:hidden w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-[14px] font-semibold text-ink-2 bg-paper border border-line hover:border-ink-3 disabled:opacity-50"
              >
                <Camera size={17} className="text-ink-3" />
                {files.length > 0 ? 'Take more photos' : 'Take photos'}
              </button>
            )}

            {/* A <label>, not a JS click chain — see InvoiceUploadModal (iOS drops the pick otherwise). */}
            <label
              htmlFor="recipe-scan-file-input"
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)) }}
              className={`rounded-xl border-2 border-dashed flex flex-col items-center gap-2 cursor-pointer transition-colors px-4 ${
                native ? 'py-4' : 'py-4 sm:py-10'
              } ${dragging ? 'border-gold bg-gold-soft' : 'border-line hover:border-ink-3 hover:bg-bg'}`}
            >
              <Upload size={22} className={`text-ink-4 ${native ? 'hidden' : 'hidden sm:block'}`} />
              <p className={`text-[13.5px] font-medium text-ink-2 ${native ? 'hidden' : 'hidden sm:block'}`}>Drop a photo or file here</p>
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line">
                Choose file
              </span>
              <p className="font-mono text-[10px] uppercase text-ink-3">Photo · PDF · Word · Excel / CSV</p>
              <input
                id="recipe-scan-file-input"
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                onChange={e => {
                  const picked = e.target.files
                  if (picked && picked.length) addFiles(Array.from(picked))
                  e.target.value = ''
                }}
                onClick={e => e.stopPropagation()}
              />
            </label>

            {files.length > 0 && (
              <div className="rounded-xl border border-line divide-y divide-dashed divide-line">
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2.5 px-3 py-2.5">
                    {fileIcon(f)}
                    <span className="flex-1 min-w-0 text-[13px] text-ink truncate">{f.name}</span>
                    <span className="ui-meta shrink-0">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                    <button
                      onClick={() => setFiles(prev => prev.filter((_, idx) => idx !== i))}
                      disabled={busy}
                      aria-label={`Remove ${f.name}`}
                      className="p-0.5 text-ink-4 hover:text-ink-2 disabled:opacity-40"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {files.length > 1 && files.every(f => f.type.startsWith('image/')) && (
              <p className="text-[12px] text-ink-3">Photos are read together, as pages of one recipe or chapter.</p>
            )}
          </div>

          {/* Foot */}
          <div className="px-5 py-3.5 border-t border-line shrink-0" style={{ paddingBottom: 'calc(0.875rem + env(safe-area-inset-bottom, 0px))' }}>
            <button
              onClick={handleRead}
              disabled={files.length === 0 || busy}
              className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-[14px] font-semibold text-paper bg-ink hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {step ?? (
                <>
                  Read {files.length > 1 ? `${files.length} files` : 'recipe'}
                  <span className="text-gold">→</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
