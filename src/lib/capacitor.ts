// src/lib/capacitor.ts
'use client'

export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as any).Capacitor?.isNativePlatform()
}

// Returns base64-encoded JPEG strings, one per scanned page.
// Only call this when isNative() is true.
export async function scanDocument(): Promise<string[]> {
  const { DocumentScanner, ResponseType } = await import('capacitor-document-scanner')
  const result = await DocumentScanner.scanDocument({
    responseType: ResponseType.Base64,
    maxNumDocuments: 10,
  })
  return result.scannedImages ?? []
}
