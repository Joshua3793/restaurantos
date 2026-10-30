// The Inbox screens' one fetch helper: never throws, always says why it failed.
import type { InboxAction } from '@/components/inbox/format'

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

export async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not save — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
  }
}

/**
 * One Inbox action from the item view, as the page sends it. Wait / Mark fixed
 * carry the typed note; Snooze / Reopen take none, so the note is saved first.
 * Once anything was written, the shared bell / sidebar count is refreshed
 * (it would otherwise sit on the old number until its next poll).
 */
export async function sendInboxAction<I>(deps: {
  action: InboxAction
  note: string
  send: (a: InboxAction) => Promise<Result<{ item: I }>>
  rcId: string | null
  refreshCount: (rcId: string) => Promise<unknown>
}): Promise<{ r: Result<{ item: I }>; noteSaved: boolean }> {
  const { action, note: text, send } = deps
  let r: Result<{ item: I }>
  let noteSaved = false
  let wrote = false
  if (text && (action.kind === 'wait' || action.kind === 'done')) {
    r = await send({ ...action, note: text })
    noteSaved = wrote = r.ok
  } else if (text && (action.kind === 'snooze' || action.kind === 'reopen')) {
    r = await send({ kind: 'note', note: text })
    if (r.ok) { noteSaved = wrote = true; r = await send(action) }
  } else {
    r = await send(action)
    wrote = r.ok
    noteSaved = r.ok && action.kind === 'note'
  }
  if (r.ok) wrote = true
  if (wrote && deps.rcId) await deps.refreshCount(deps.rcId).catch(() => {})
  return { r, noteSaved }
}
