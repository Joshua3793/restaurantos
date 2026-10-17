// src/hooks/useNativeScan.ts
'use client'

import { useState, useCallback } from 'react'
import { scanDocument } from '@/lib/capacitor'
import { uploadFiles } from '@/lib/uploadthing-client'
import { compressImageFile } from '@/lib/image-compress'

interface Options {
  activeRcId: string | null
  onComplete: () => void
  /** Called with the session id when >1 page was captured — parent opens the grouping screen. */
  onGrouping?: (sessionId: string) => void
}

// Converts a base64 JPEG string (no data-URI prefix) to Uint8Array.
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export type ScanUploader = 'invoiceUploader' | 'recipeScanUploader'

export interface UploadedScanFile { url: string; fileName: string; fileType: string }

/** Cloud timeout for scanned pages — fail fast so the caller's fallback kicks in (same as InvoiceUploadModal). */
const PAGE_UPLOAD_TIMEOUT_MS = 8_000

/**
 * Upload files to UploadThing with a timeout. Resolves to the uploaded files,
 * or null when the cloud upload failed or timed out (the caller decides on a
 * fallback). Never throws.
 */
export async function uploadToCloud(
  files: File[],
  uploader: ScanUploader,
  timeoutMs: number = PAGE_UPLOAD_TIMEOUT_MS,
): Promise<UploadedScanFile[] | null> {
  try {
    const uploaded = await Promise.race([
      uploadFiles(uploader, { files }),
      new Promise<null>((_, rej) =>
        setTimeout(() => rej(new Error('Cloud upload timed out')), timeoutMs)
      ),
    ])
    if (!uploaded?.length) return null
    return uploaded.map(f => ({
      url: f.url,
      fileName: f.name,
      fileType: f.type ?? 'image/jpeg',
    }))
  } catch {
    return null
  }
}

/**
 * The page-upload half of a native scan, shared by invoices and recipe scans:
 * turn the scanner's base64 pages into compressed JPEG files and try the
 * UploadThing CDN. `uploaded` is null when the cloud upload failed — `files`
 * are still returned so the caller can fall back.
 */
export async function uploadScanPages(
  pages: string[],
  uploader: ScanUploader,
): Promise<{ files: File[]; uploaded: UploadedScanFile[] | null }> {
  // Individual images (not a merged PDF) so the server runs them through the
  // sharp enhancement pipeline and one combined multi-image OCR call — and bbox
  // page indexes line up with file order. Done sequentially, one canvas at a
  // time: rasterizing every page concurrently can transiently hold hundreds of
  // MB of bitmaps and OOM low-end mobile WebViews.
  const files: File[] = []
  for (const [i, raw] of pages.entries()) {
    const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
    const bytes = base64ToUint8Array(b64)
    const file = new File([new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })],
      `scan_p${i + 1}.jpg`, { type: 'image/jpeg' })
    files.push(await compressImageFile(file))
  }
  const uploaded = await uploadToCloud(files, uploader)
  return { files, uploaded }
}

export function useNativeScan({ activeRcId, onComplete, onGrouping }: Options) {
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const triggerScan = useCallback(async () => {
    setIsScanning(true)
    setScanError(null)

    try {
      // 1. Open native scanner
      const pages = await scanDocument()
      if (!pages.length) { setIsScanning(false); return }

      // 2. Convert pages to compressed JPEG files and try the UploadThing CDN
      //    (8 s timeout, same as InvoiceUploadModal).
      const { files: pageFiles, uploaded } = await uploadScanPages(pages, 'invoiceUploader')

      // 3. Create session
      const sessRes = await fetch('/api/invoices/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenueCenterId: activeRcId }),
      })
      if (!sessRes.ok) {
        setScanError(`Failed to create session (${sessRes.status}). Please try again.`)
        return
      }
      const sess = await sessRes.json()

      // 4a. Register the cloud upload on the session
      let uploadOk = false
      if (uploaded) {
        try {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: uploaded }),
          })
          if (regRes.ok) uploadOk = true
        } catch {
          // fall through to local fallback
        }
      }

      // 4b. Local fallback — one page per request to stay under the ~4.5 MB
      // serverless body limit (the route tolerates repeated calls; status
      // reset to PROCESSING is idempotent).
      if (!uploadOk) {
        const limitBytes = 4 * 1024 * 1024
        const oversize = pageFiles.find(f => f.size > limitBytes)
        if (oversize) {
          setScanError(
            `A scanned page is too large (${(oversize.size / 1024 / 1024).toFixed(1)} MB) even after compression. Please retake the photo.`
          )
          return
        }
        for (const f of pageFiles) {
          const fd = new FormData()
          fd.append('files', f)
          const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
            method: 'POST',
            body: fd,
          })
          if (!localRes.ok) {
            const body = await localRes.json().catch(() => ({}))
            setScanError(body.error ?? `Upload failed (${localRes.status}).`)
            return
          }
        }
        uploadOk = true
      }

      // 5. One page → OCR immediately. Multi-page capture → grouping screen
      //    (the batch may be several invoices photographed in one go).
      if (pageFiles.length > 1 && onGrouping) {
        onGrouping(sess.id)
      } else {
        fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})
      }

      // 6. Notify parent
      onComplete()
    } catch (err) {
      setScanError(`Scan error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsScanning(false)
    }
  }, [activeRcId, onComplete, onGrouping])

  const clearError = () => setScanError(null)

  return { triggerScan, isScanning, scanError, clearError }
}
