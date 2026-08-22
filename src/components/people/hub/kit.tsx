'use client'
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="block text-[10px] font-mono uppercase tracking-[0.1em] text-ink-4 mb-1.5">
      {children}
    </span>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <SectionLabel>{label}</SectionLabel>
      {children}
      {hint && <span className="block mt-1 text-[11px] text-ink-4 leading-relaxed">{hint}</span>}
    </label>
  )
}

export const inputClass =
  'w-full border border-line rounded-lg px-3 py-2 text-[13px] bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-gold'

export function WarningNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 px-3 py-2.5 bg-gold-soft rounded-[10px]">
      <AlertTriangle size={14} className="shrink-0 text-gold-2 mt-0.5" />
      <p className="text-[12px] text-ink-2 leading-relaxed">{children}</p>
    </div>
  )
}

export function EmptyTab({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-8 py-12 text-center">
      <h3 className="text-[14px] font-semibold text-ink mb-1.5">{title}</h3>
      <p className="text-[12.5px] text-ink-3 leading-relaxed max-w-[300px] mx-auto mb-4">{body}</p>
      {action}
    </div>
  )
}

export interface SaveOptions {
  /**
   * Runs on success, BEFORE the list reload. Receives the route's non-fatal
   * `warning` so a caller that unmounts this component (the delete path calls
   * `onCleared`) can hand the warning to a survivor — see Important 3: a
   * warning written to local state here never paints, because the pane is
   * gone by the time React commits.
   */
  after?: (warning?: string) => void
  /**
   * The Person key to select after the reload. A link/unlink moves a person
   * between `cook:<id>` and `<userId>`; without this the old key resolves to
   * nothing and the detail pane collapses mid-action (Important 4). Passed
   * through to `onChanged` so the reload and the re-selection land in the
   * SAME pass — re-selecting separately would blank the pane for a frame.
   */
  nextKey?: string
}

/**
 * Shared save wrapper. Surfaces the non-fatal `warning` some routes return when
 * the audit write fails AFTER the mutation already committed — dropping it
 * (as PersonDetailPanel.call() does today) hides an incomplete audit trail
 * behind an apparent clean success.
 */
export function useSave(onChanged: (nextKey?: string) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')

  const save = async (fn: () => Promise<Response>, opts?: SaveOptions): Promise<boolean> => {
    setError(''); setWarning(''); setBusy(true)
    try {
      const res = await fn()
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error ?? 'Something went wrong'); return false }
      const routeWarning = typeof body.warning === 'string' ? body.warning : undefined
      if (routeWarning) setWarning(routeWarning)
      opts?.after?.(routeWarning); onChanged(opts?.nextKey)
      return true
    } catch (e) {
      // A network rejection throws before any response exists — without this,
      // `busy` stays true forever with no escape.
      setError(e instanceof Error ? e.message : 'Network error — could not reach the server')
      return false
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, warning, setError, save, Spinner: busy ? <Loader2 size={14} className="animate-spin" /> : null }
}
