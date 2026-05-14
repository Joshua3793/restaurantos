// SSR safety: isNative() guards typeof window; scanDocument() uses dynamic
// import so @capacitor/core is never loaded during server-side rendering.

export function isNative(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.()
}

// Returns base64-encoded JPEG strings, one per scanned page.
// Only call this when isNative() is true.
export async function scanDocument(): Promise<string[]> {
  const { registerPlugin } = await import('@capacitor/core')

  const DocumentScanner = registerPlugin<{
    scanDocument(opts: {
      responseType: string
      maxNumDocuments: number
    }): Promise<{ scannedImages?: string[]; status?: string }>
  }>('DocumentScanner')

  const result = await DocumentScanner.scanDocument({
    responseType: 'base64',
    maxNumDocuments: 10,
  })

  if (result.status === 'cancel') return []
  return result.scannedImages ?? []
}
