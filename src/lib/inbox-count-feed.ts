// ONE Inbox-count feed for every consumer on screen (the desktop bell, the phone
// bell and the sidebar badge are all mounted at once). Each used to be a
// candidate for its own poll; this shares one request per kitchen. Polling only
// runs while the page is visible, and catches up the moment it becomes visible.
// Client only — it uses fetch and document.

const POLL_MS = 30_000

type Listener = (count: number) => void

const feeds = new Map<string, {
  listeners: Set<Listener>
  count: number | null
  timer: ReturnType<typeof setInterval> | null
  inflight: Promise<void> | null
}>()

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

async function refresh(rcId: string, force = false): Promise<void> {
  const feed = feeds.get(rcId)
  if (!feed || !visible()) return
  if (feed.inflight) {
    if (!force) return feed.inflight
    // A forced refresh follows something we just changed (a report opened):
    // the request already in the air may have read the old state, so wait for
    // it and ask again.
    await feed.inflight
    return refresh(rcId, false)
  }
  feed.inflight = fetch(`/api/inbox/count?rcId=${encodeURIComponent(rcId)}`, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (d && typeof d.count === 'number') {
        feed.count = d.count
        feed.listeners.forEach(l => l(d.count))
      }
    })
    .catch(() => {})
    .finally(() => { feed.inflight = null })
  return feed.inflight
}

/**
 * Re-fetch now, even if a poll is in flight (the dropdown opened, or the user
 * just did something that changes the number). Safe when nobody is subscribed.
 */
export function refreshInboxCount(rcId: string): Promise<void> {
  return refresh(rcId, true)
}

/** Listen to one kitchen's count. Returns the unsubscribe. */
export function subscribeInboxCount(rcId: string, listener: Listener): () => void {
  let feed = feeds.get(rcId)
  if (!feed) {
    feed = { listeners: new Set(), count: null, timer: null, inflight: null }
    feeds.set(rcId, feed)
  }
  feed.listeners.add(listener)
  if (feed.count != null) listener(feed.count)
  if (feed.listeners.size === 1) {
    void refresh(rcId)
    feed.timer = setInterval(() => { void refresh(rcId) }, POLL_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    const f = feeds.get(rcId)
    if (!f) return
    f.listeners.delete(listener)
    if (f.listeners.size === 0) {
      if (f.timer) clearInterval(f.timer)
      feeds.delete(rcId)
      if (feeds.size === 0 && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }
}

function onVisible() {
  if (!visible()) return
  feeds.forEach((_, rcId) => { void refresh(rcId) })
}
