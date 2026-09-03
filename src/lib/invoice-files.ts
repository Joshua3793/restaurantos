// Where an InvoiceFile's bytes live, and how to read or delete them.
//
// fileUrl takes one of three shapes:
//   https://utfs.io/f/<key> | https://<app>.ufs.sh/f/<key>   UploadThing CDN (production)
//   /uploads/invoices/<name>                                  local-disk provider (dev)
//   data:<mime>;base64,…                                      DB-inline fallback
// Row deletes (session DELETE, sorter discards) must also free the bytes, or
// every retake and thrown-away batch lives on the CDN forever.

export type BlobRef =
  | { kind: 'uploadthing'; key: string }
  | { kind: 'local'; relPath: string }

const LOCAL_DIR = 'uploads/invoices'
// One path segment: no slashes, no dot-dot, nothing an unlink could walk with.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/
const UT_KEY = /^[A-Za-z0-9_-]+$/

/** Classify a fileUrl. Returns null for data: URIs and anything not ours. */
export function blobRefFromUrl(fileUrl: string): BlobRef | null {
  if (!fileUrl) return null
  if (fileUrl.startsWith('/')) {
    const path = fileUrl.split('?')[0]
    const prefix = `/${LOCAL_DIR}/`
    if (!path.startsWith(prefix)) return null
    const name = path.slice(prefix.length)
    if (!SAFE_NAME.test(name) || name === '.' || name === '..') return null
    return { kind: 'local', relPath: `${LOCAL_DIR}/${name}` }
  }
  let u: URL
  try { u = new URL(fileUrl) } catch { return null }
  if (u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase()
  if (host !== 'utfs.io' && !host.endsWith('.ufs.sh')) return null
  const m = /^\/f\/([^/]+)$/.exec(u.pathname)
  if (!m || !UT_KEY.test(m[1])) return null
  return { kind: 'uploadthing', key: m[1] }
}

/**
 * Best-effort blob deletion. Never throws: the DB rows are already gone (or
 * about to be) and a CDN hiccup must not leave a session the user cannot
 * delete. Failures are logged and counted for the caller's response.
 */
export async function deleteFileBlobs(files: ReadonlyArray<{ fileUrl: string }>): Promise<{ deleted: number; failed: number }> {
  const keys: string[] = []
  const locals: string[] = []
  for (const f of files) {
    const ref = blobRefFromUrl(f.fileUrl)
    if (!ref) continue
    if (ref.kind === 'uploadthing') keys.push(ref.key)
    else locals.push(ref.relPath)
  }
  let deleted = 0
  let failed = 0

  if (keys.length > 0) {
    try {
      // Dynamic import: keeps this module importable in unit tests / clients
      // that never delete, and defers the token read to the one call that needs it.
      const { UTApi } = await import('uploadthing/server')
      const res = await new UTApi().deleteFiles(keys)
      // v7 returns { success, deletedCount }; treat a false success as all-failed.
      if (res.success) deleted += res.deletedCount ?? keys.length
      else failed += keys.length
    } catch (e) {
      failed += keys.length
      console.warn(`[invoice-files] UploadThing delete failed for ${keys.length} key(s):`, e instanceof Error ? e.message : e)
    }
  }

  if (locals.length > 0) {
    const [{ unlink }, path] = await Promise.all([import('fs/promises'), import('path')])
    const root = path.resolve(process.cwd(), 'public', LOCAL_DIR)
    for (const rel of locals) {
      const abs = path.resolve(process.cwd(), 'public', rel)
      if (!abs.startsWith(root + path.sep)) { failed++; continue }
      try { await unlink(abs); deleted++ }
      catch (e) {
        // ENOENT is fine — already gone.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') deleted++
        else { failed++; console.warn(`[invoice-files] unlink failed for ${rel}:`, e instanceof Error ? e.message : e) }
      }
    }
  }

  return { deleted, failed }
}

// Loads an InvoiceFile's bytes whether it lives on the CDN (https URL) or in
// the DB via the local-upload fallback (data: URI).
export async function loadBuffer(file: { fileUrl: string; fileName: string }): Promise<Buffer> {
  if (file.fileUrl.startsWith('data:')) {
    const comma = file.fileUrl.indexOf(',')
    return Buffer.from(file.fileUrl.slice(comma + 1), 'base64')
  }
  const res = await fetch(file.fileUrl)
  if (!res.ok) throw new Error(`Failed to fetch ${file.fileName}: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
