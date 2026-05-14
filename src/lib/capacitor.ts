// src/lib/capacitor.ts
// SSR safety: isNative() guards typeof window; scanDocument() uses dynamic import
// so the native plugin is never loaded during server-side rendering.
export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
}

// Returns base64-encoded JPEG strings, one per scanned page.
// Only call this when isNative() is true.
export async function scanDocument(): Promise<string[]> {
  const { DocumentScanner, ResponseType, ScanDocumentResponseStatus } = await import(/* webpackIgnore: true */ 'capacitor-document-scanner')
  const result = await DocumentScanner.scanDocument({
    responseType: ResponseType.Base64,
    maxNumDocuments: 10,
  })
  if (result.status === ScanDocumentResponseStatus.Cancel) return []
  return result.scannedImages ?? []
}
