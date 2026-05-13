// src/hooks/useNativeScan.ts
'use client'

import { useState, useRef } from 'react'
import { scanDocument } from '@/lib/capacitor'
import { useUploadThing } from '@/lib/uploadthing-client'

interface Options {
  activeRcId: string | null
  onComplete: (sessionId: string) => void
}

// Converts a base64 JPEG string (no data-URI prefix) to Uint8Array.
async function base64ToUint8Array(b64: string): Promise<Uint8Array> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Merges an array of base64 JPEG strings into a single PDF Blob.
async function mergePagesToPdf(base64Images: string[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (const raw of base64Images) {
    // Strip data URI prefix if the plugin includes it
    const b64 = raw.replace(/^data:image\/[^;]+;base64,/, '')
    const bytes = await base64ToUint8Array(b64)
    const image = await doc.embedJpg(bytes)
    const page = doc.addPage([image.width, image.height])
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  }
  const pdfBytes = await doc.save()
  return new Blob([Buffer.from(pdfBytes)], { type: 'application/pdf' })
}

export function useNativeScan({ activeRcId, onComplete }: Options) {
  const [isScanning, setIsScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const utErrorRef = useRef<string | null>(null)

  const { startUpload } = useUploadThing('invoiceUploader', {
    onUploadError: (err) => { utErrorRef.current = err.message ?? 'Upload error' },
  })

  const triggerScan = async () => {
    setIsScanning(true)
    setScanError(null)
    utErrorRef.current = null

    try {
      // 1. Open native scanner
      const pages = await scanDocument()
      if (!pages.length) { setIsScanning(false); return }

      // 2. Merge pages into a single PDF
      const pdfBlob = await mergePagesToPdf(pages)
      const pdfFile = new File([pdfBlob], `scan_${Date.now()}.pdf`, {
        type: 'application/pdf',
      })

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
          startUpload([pdfFile]),
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
                url: (f as any).ufsUrl ?? f.url,
                fileName: f.name,
                fileType: 'application/pdf',
              })),
            }),
          })
          if (regRes.ok) uploadOk = true
        }
      } catch {
        // fall through to local fallback
      }

      // 4b. Local fallback (same as InvoiceUploadModal)
      if (!uploadOk) {
        const fd = new FormData()
        fd.append('files', pdfFile)
        const localRes = await fetch(`/api/invoices/sessions/${sess.id}/upload-local`, {
          method: 'POST',
          body: fd,
        })
        if (localRes.ok) {
          uploadOk = true
        } else {
          const body = await localRes.json().catch(() => ({}))
          setScanError(body.error ?? `Upload failed (${localRes.status}).`)
          return
        }
      }

      // 5. Kick off OCR (fire-and-forget; drawer polls for status)
      fetch(`/api/invoices/sessions/${sess.id}/process`, { method: 'POST' }).catch(() => {})

      // 6. Notify parent
      onComplete(sess.id)
    } catch (err) {
      setScanError(`Scan error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsScanning(false)
    }
  }

  const clearError = () => setScanError(null)

  return { triggerScan, isScanning, scanError, clearError }
}
