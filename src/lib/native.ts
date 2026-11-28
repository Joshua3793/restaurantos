// Native plugin wrappers for the Capacitor shell.
//
// The phone app loads the live website, so its plugins are reached at runtime
// through the bridge Capacitor injects — no plugin npm packages in the web app.
// Every wrapper here is safe to call anywhere: in a plain browser, during SSR,
// or in an older installed app that lacks a plugin, it does nothing and never
// throws. Plugins (Capacitor 5): App, LocalNotifications, Share, Filesystem,
// KeepAwake (@capacitor-community/keep-awake), StatusBar.
import { isNative } from './capacitor'

type Remove = () => void
interface ListenerHandle { remove: () => Promise<void> | void }

interface AppPlugin {
  addListener(event: 'backButton', cb: (e: { canGoBack: boolean }) => void): Promise<ListenerHandle> & ListenerHandle
  addListener(event: 'resume' | 'pause', cb: () => void): Promise<ListenerHandle> & ListenerHandle
  minimizeApp(): Promise<void>
}

export interface LocalNotificationSpec {
  id: number
  title: string
  body: string
  at: Date
  extra?: Record<string, unknown>
}
interface PermissionStatus { display: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' }
interface LocalNotificationsPlugin {
  checkPermissions(): Promise<PermissionStatus>
  requestPermissions(): Promise<PermissionStatus>
  schedule(o: { notifications: { id: number; title: string; body: string; schedule: { at: Date; allowWhileIdle?: boolean }; extra?: unknown }[] }): Promise<unknown>
  cancel(o: { notifications: { id: number }[] }): Promise<void>
  getPending(): Promise<{ notifications: { id: number; extra?: Record<string, unknown> | null }[] }>
}

interface FilesystemPlugin {
  writeFile(o: { path: string; data: string; directory: string; encoding?: string; recursive?: boolean }): Promise<{ uri: string }>
}
interface SharePlugin {
  share(o: { title?: string; text?: string; url?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>
}
interface KeepAwakePlugin {
  keepAwake(): Promise<void>
  allowSleep(): Promise<void>
}

// Plugins are boxed ({ p }) before they cross a promise: a Capacitor plugin
// proxy answers ANY property, `then` included, so resolving a promise with the
// bare proxy would call a native "then" method and hang forever.
const cache = new Map<string, Promise<{ p: unknown } | null>>()

/** The named plugin, or null in a browser / when the installed app lacks it. */
async function plugin<T>(name: string): Promise<{ p: T } | null> {
  if (!isNative()) return null
  let box = cache.get(name)
  if (!box) {
    box = import('@capacitor/core')
      .then(({ Capacitor, registerPlugin }) => {
        try {
          if (typeof Capacitor.isPluginAvailable === 'function' && !Capacitor.isPluginAvailable(name)) return null
          return { p: registerPlugin<T>(name) as unknown }
        } catch { return null }
      })
      .catch(() => null)
    cache.set(name, box)
  }
  return (await box) as { p: T } | null
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

// ── App ─────────────────────────────────────────────────────────────────────

/** Subscribe to an App event; returns an unsubscribe that is always safe. */
function appListen(event: 'backButton' | 'resume', cb: (e: { canGoBack: boolean }) => void): Remove {
  let handle: ListenerHandle | null = null
  let gone = false
  void plugin<AppPlugin>('App').then(async box => {
    const app = box?.p
    if (!app || gone) return
    const h = await safe(() => Promise.resolve(app.addListener(event as 'backButton', cb)))
    if (!h) return
    if (gone) { void safe(() => Promise.resolve(h.remove())) } else handle = h
  })
  return () => {
    gone = true
    if (handle) void safe(() => Promise.resolve(handle!.remove()))
  }
}

export const onNativeBack = (cb: (canGoBack: boolean) => void): Remove => appListen('backButton', e => cb(!!e?.canGoBack))
export const onNativeResume = (cb: () => void): Remove => appListen('resume', () => cb())

export async function minimizeApp(): Promise<void> {
  const app = (await plugin<AppPlugin>('App'))?.p
  if (app) await safe(() => app.minimizeApp())
}

// ── Keep awake ──────────────────────────────────────────────────────────────

export async function nativeKeepAwake(on: boolean): Promise<boolean> {
  const k = (await plugin<KeepAwakePlugin>('KeepAwake'))?.p
  if (!k) return false
  return (await safe(() => (on ? k.keepAwake() : k.allowSleep()))) !== null
}

// ── Local notifications ─────────────────────────────────────────────────────

/** 'granted' | 'denied' | 'prompt' — or null when not native / no plugin. */
export async function notifyPermission(ask: boolean): Promise<'granted' | 'denied' | 'prompt' | null> {
  const ln = (await plugin<LocalNotificationsPlugin>('LocalNotifications'))?.p
  if (!ln) return null
  let st = await safe(() => ln.checkPermissions())
  if (!st) return null
  if (ask && (st.display === 'prompt' || st.display === 'prompt-with-rationale')) {
    st = (await safe(() => ln.requestPermissions())) ?? st
  }
  return st.display === 'granted' ? 'granted' : st.display === 'denied' ? 'denied' : 'prompt'
}

export async function scheduleNotifications(list: LocalNotificationSpec[]): Promise<boolean> {
  if (list.length === 0) return true
  const ln = (await plugin<LocalNotificationsPlugin>('LocalNotifications'))?.p
  if (!ln) return false
  const ok = await safe(() => ln.schedule({
    notifications: list.map(n => ({
      id: n.id, title: n.title, body: n.body, extra: n.extra,
      schedule: { at: n.at, allowWhileIdle: true },
    })),
  }))
  return ok !== null
}

export async function cancelNotifications(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const ln = (await plugin<LocalNotificationsPlugin>('LocalNotifications'))?.p
  if (ln) await safe(() => ln.cancel({ notifications: ids.map(id => ({ id })) }))
}

/** Ids of pending notifications whose `extra.kind` matches. */
export async function pendingNotificationIds(kind: string): Promise<number[]> {
  const ln = (await plugin<LocalNotificationsPlugin>('LocalNotifications'))?.p
  if (!ln) return []
  const res = await safe(() => ln.getPending())
  return (res?.notifications ?? []).filter(n => n?.extra?.kind === kind).map(n => n.id)
}

// ── Share a file ────────────────────────────────────────────────────────────

/** Writes the file to the app cache and opens the share sheet. False when not
 *  native, a plugin is missing, or the write/share failed before the sheet. */
export async function nativeShareFile(filename: string, base64OrText: string, isText: boolean): Promise<boolean> {
  const fs = (await plugin<FilesystemPlugin>('Filesystem'))?.p
  const share = (await plugin<SharePlugin>('Share'))?.p
  if (!fs || !share) return false
  const written = await safe(() => fs.writeFile({
    path: filename, data: base64OrText, directory: 'CACHE', recursive: true,
    ...(isText ? { encoding: 'utf8' } : {}),
  }))
  if (!written?.uri) return false
  try {
    await share.share({ title: filename, dialogTitle: filename, files: [written.uri] })
    return true
  } catch (e) {
    // A cook closing the sheet is not a failure.
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return true
    // Older Share plugins have no `files` — pass the file as a url instead.
    return (await safe(() => share.share({ title: filename, url: written.uri }))) !== null
  }
}

// ── Status bar ──────────────────────────────────────────────────────────────

interface StatusBarPlugin { setStyle(o: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }): Promise<void> }

/** 'light-text' for dark screens (sign-in), 'dark-text' everywhere else. */
export async function setStatusBarText(tone: 'light-text' | 'dark-text'): Promise<void> {
  const sb = (await plugin<StatusBarPlugin>('StatusBar'))?.p
  // Capacitor naming: style DARK = light text for dark backgrounds.
  if (sb) await safe(() => sb.setStyle({ style: tone === 'light-text' ? 'DARK' : 'LIGHT' }))
}
