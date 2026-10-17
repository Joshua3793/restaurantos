// Recipe Scan: which uploaded files are read together, which file URLs we
// accept, and the scan status words the Reading list shows.
import { blobRefFromUrl } from '@/lib/invoice-files'

export const READ_ERROR = "Couldn't read this — try again with the whole page in the frame."
export const STUCK_ERROR = 'Reading took too long — try again.'
/** A scan still READING after this long was killed mid-read (as invoices: 5 min). */
export const STUCK_AFTER_MS = 5 * 60 * 1000
export const MAX_SCAN_FILES = 10

export type ScanFileKind = 'image' | 'pdf' | 'docx' | 'sheet'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function fileKind(fileType: string, fileName: string): ScanFileKind | null {
  const t = (fileType || '').toLowerCase()
  const ext = (fileName || '').toLowerCase().split('.').pop() ?? ''
  if (t.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif'].includes(ext)) return 'image'
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (t === DOCX || ext === 'docx') return 'docx'
  if (t === XLSX || t === 'text/csv' || ['xlsx', 'csv'].includes(ext)) return 'sheet'
  return null
}

/** Photos are pages of one read; every PDF, Word or sheet file is read on its own. Order kept. */
export function groupScanFiles<T extends { fileType: string; fileName: string }>(
  files: T[],
): { kind: ScanFileKind; files: T[] }[] {
  const images = files.filter(f => fileKind(f.fileType, f.fileName) === 'image')
  const groups: { kind: ScanFileKind; files: T[] }[] = images.length ? [{ kind: 'image', files: images }] : []
  for (const f of files) {
    const k = fileKind(f.fileType, f.fileName)
    if (k && k !== 'image') groups.push({ kind: k, files: [f] })
  }
  return groups
}

/** Only our own upload storage (or an inline data: file) — never an arbitrary URL the server would fetch. */
export function isAllowedScanUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false
  if (url.startsWith('data:')) return true
  return blobRefFromUrl(url)?.kind === 'uploadthing'
}
