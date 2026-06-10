// src/hooks/useNativeScan.ts
'use client'

import { useState, useCallback } from 'react'
import { scanDocument } from '@/lib/capacitor'
import { useUploadThing } from '@/lib/uploadthing-client'
import { compressImageFile } from '@/lib/image-compress'

interface Options {
  activeRcId: string | null
  onComplete: () => void
}

// Converts a base64 JPEG string (no data-URI prefix) to Uint8Array.
function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function useNativeScan({ activeRcId, onComplete }: Options) {
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {})

  const triggerScan = useCallback(async () => {
    setIsScanning(true)
    setScanError(null)

    try {
      // 1. Open native scanner
      const pages = await scanDocument()
      if (!pages.length) { setIsScanning(false); return }

      // 2. Convert pages to compressed JPEG files. Individual images (not a
      // merged PDF) so the server runs them through the sharp enhancement
      // pipeline and one combined multi-image OCR call — and bbox page
      // indexes line up with file order. Done sequentially, one canvas at a
      // time: rasterizing every page concurrently can transiently hold
      // hundreds of MB of bitmaps and OOM low-end mobile WebViews.
      const pageFiles: File[] = []
      for (const [i, raw] of pages.entries()) {
        const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
        const bytes = base64ToUint8Array(b64)
        const file = new File([new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' })],
          `scan_p${i + 1}.jpg`, { type: 'image/jpeg' })
        pageFiles.push(await compressImageFile(file))
      }

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

      // 4a. Try UploadThing CDN (8 s timeout, same as InvoiceUploadModal)
      let uploadOk = false
      try {
        const uploaded = await Promise.race([
          startUpload(pageFiles),
          new Promise<null>((_, rej) =>
            setTimeout(() => rej(new Error('Cloud upload timed out')), 8_000)
          ),
        ])
        if (uploaded?.length) {
          const regRes = await fetch(`/api/invoices/sessions/${sess.id}/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              files: uploaded.map(f => ({
                url: f.url,
                fileName: f.name,
                fileType: f.type ?? 'image/jpeg',
              })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch {
        // fall through to local fallback
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

      // 5. Kick off OCR (fire-and-forget; drawer polls for status)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 6. Notify parent
      onComplete()
    } catch (err) {
      setScanError(`Scan error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsScanning(false)
    }
  }, [activeRcId, onComplete, startUpload])

  const clearError = () => setScanError(null)

  return { triggerScan, isScanning, scanError, clearError }
}
