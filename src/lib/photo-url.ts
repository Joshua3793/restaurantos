// Pure: which photo links the app keeps on a waste entry or a flagged checklist job.
//
// A photo is uploaded first (UploadThing, `photoUploader`), then the entry is
// saved with the file's link. Our uploaders return `file.ufsUrl`, which is
// https://<our appId>.ufs.sh/f/<key>, so on the server only links on OUR
// UploadThing app's host are kept — a saved entry can never carry a link to
// somewhere else, not even another UploadThing customer's file. Anything else
// is dropped (the entry still saves, without the photo): a photo is optional
// and must never block the save.
//
// The appId is read from UPLOADTHING_TOKEN (base64 JSON `{ apiKey, appId,
// regions }`, uploadthing v7). That variable only exists on the server; in the
// browser, or when it is missing/unreadable (dev without uploads set up), the
// check falls back to any *.ufs.sh app host. The browser only runs this for
// its optimistic copy of a checklist line — the server's answer is the one
// that is stored.

export const PHOTO_URL_MAX = 2048

const APP_ID_RE = /^[a-z0-9]{1,64}$/

let cached: { token: string; appId: string | null } | null = null

/** Our UploadThing appId, from UPLOADTHING_TOKEN on the server; null otherwise. */
export function uploadThingAppId(): string | null {
  if (typeof window !== 'undefined') return null
  const token = process.env.UPLOADTHING_TOKEN?.trim() ?? ''
  if (!token) return null
  if (cached?.token === token) return cached.appId
  let appId: string | null = null
  try {
    const json = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as { appId?: unknown }
    const id = typeof json?.appId === 'string' ? json.appId.trim().toLowerCase() : ''
    appId = APP_ID_RE.test(id) ? id : null
  } catch { appId = null }
  cached = { token, appId }
  return appId
}

/**
 * True when `host` is our UploadThing app's file host (`<appId>.ufs.sh`).
 * Without a known appId, any `<app>.ufs.sh` host is accepted.
 */
export function isUploadThingHost(host: string, appId: string | null = uploadThingAppId()): boolean {
  const h = host.toLowerCase()
  if (appId) return h === `${appId}.ufs.sh`
  if (!h.endsWith('.ufs.sh')) return false
  const sub = h.slice(0, -'.ufs.sh'.length)
  return APP_ID_RE.test(sub)
}

/** The photo link to store, or null (none sent, or not one we accept). */
export function cleanPhotoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > PHOTO_URL_MAX) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  if (!isUploadThingHost(u.hostname)) return null
  if (!u.pathname.startsWith('/f/') || u.pathname.length <= 3) return null
  return u.toString()
}
