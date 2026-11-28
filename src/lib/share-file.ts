// Exports on a phone: hand the file to the share sheet (save to Files, AirDrop,
// email it to the bookkeeper) instead of a download the phone app can't do.
//   phone app      → write to the app cache, then the native share sheet
//   phone browser  → navigator.share({ files }) where the browser supports it
//   everything else → the normal download
import { isNative } from './capacitor'
import { nativeShareFile } from './native'

export interface ShareFileInput {
  filename: string
  mime: string
  data: string | Blob
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

const isPhone = () =>
  typeof window !== 'undefined' &&
  (window.innerWidth < 768 || !!window.matchMedia?.('(pointer: coarse)').matches)

export async function shareOrDownload({ filename, mime, data }: ShareFileInput): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data

  if (isNative()) {
    try {
      const ok = typeof data === 'string'
        ? await nativeShareFile(filename, data, true)
        : await nativeShareFile(filename, await blobToBase64(blob), false)
      if (ok) return
    } catch { /* fall through to the browser paths */ }
  }

  if (isPhone() && typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof File !== 'undefined') {
    try {
      const file = new File([blob], filename, { type: mime })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename })
        return
      }
    } catch (e) {
      // The cook closed the share sheet — that is an answer, not a failure.
      if ((e as Error)?.name === 'AbortError') return
      // NotAllowedError (the tap went stale) etc. → plain download below.
    }
  }

  download(filename, blob)
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? ''
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd)
  if (star) { try { return decodeURIComponent(star[1]) } catch { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain?.[1] ?? fallback
}

/**
 * A server export (an /api/... link that answers with a file). In the phone
 * app a link like that goes nowhere, so the file is fetched and shared; in a
 * browser the link keeps working exactly as before. Returns true when it took
 * over (the caller should then `preventDefault()` the click).
 */
export function shareServerExport(url: string, fallbackName: string, onError?: () => void): boolean {
  if (!isNative()) return false
  void (async () => {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      await shareOrDownload({ filename: filenameFrom(res, fallbackName), mime: blob.type || 'application/octet-stream', data: blob })
    } catch { onError?.() }
  })()
  return true
}
