'use client'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@/components/Toast'
import { pacificHHMM } from '@/lib/checklists/rules'
import type { EodProgress } from '@/lib/eod-close'

// "Close the day" — the last card on the closing board (it replaced the
// End-of-day page). Shows what still holds the day open, the ONE kitchen
// handover note every opener sees tomorrow, and the button that closes the
// day. The gate itself is the server's (GET/POST /api/eod/close*): stations
// signed off, whole-kitchen must-dos handled, fridge temps logged and in range.

type CloseState = {
  date: string
  close: {
    status: 'DRAFT' | 'CLOSED' | string
    handoverNote: string | null
    signedOffByName: string | null
    signedOffAt: string | null
  }
  progress: EodProgress
}

const NOTE_MAX = 1000
const SAVE_MS = 800

/** Pacific clock without a leading zero: '07:31' → '7:31'. */
const hhmm = (iso: string) => pacificHHMM(new Date(iso)).replace(/^0/, '')

function Gate({ ok, label, value, href }: { ok: boolean; label: string; value: string; href?: string }) {
  return (
    <li className="flex items-center gap-2.5 min-h-[44px] border-t border-bg-2 first:border-t-0">
      <span className={`flex-none w-[64px] whitespace-nowrap text-center font-mono text-[10px] font-medium px-1.5 py-[3px] rounded-full ${ok ? 'bg-green-soft text-green-text' : 'bg-red-soft text-red-text'}`}>
        {ok ? 'READY' : 'NOT YET'}
      </span>
      <span className="flex-1 min-w-0 text-[13.5px] text-ink">{label}</span>
      {href && !ok
        ? <Link href={href} className="flex-none font-mono text-[12px] font-semibold text-gold-2">{value} →</Link>
        : <span className={`flex-none font-mono text-[12px] font-semibold ${ok ? 'text-ink-2' : 'text-red-text'}`}>{value}</span>}
    </li>
  )
}

export function CloseTheDay({ rcId, tick, canManage, flagsOpen }: {
  rcId: string
  /** Bumped by the board after each reload, so the gate follows the stations. */
  tick: number
  /** MANAGER+: may reopen a closed day and sees the link to the numbers. */
  canManage: boolean
  /** Open flags on the board — shown, but they do not hold the day open. */
  flagsOpen: number
}) {
  const toast = useToast()
  const [state, setState] = useState<CloseState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // The note box is the cook's while they type: a reload must not paint over it.
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rcRef = useRef(rcId)
  rcRef.current = rcId

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/eod/close?rcId=${encodeURIComponent(rcId)}`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (rcRef.current !== rcId) return
      if (!res.ok) { setError((data && data.error) || 'Could not load the close'); return }
      setError(null)
      setState(data as CloseState)
      if (!dirty.current) setNote((data as CloseState).close.handoverNote ?? '')
    } catch {
      setError('No connection — try again.')
    }
  }, [rcId])

  // A new kitchen starts clean; the board's reload tick (≥ 1 by the time this
  // card shows) does the loading, so a first paint fetches once, not twice.
  useEffect(() => { dirty.current = false; setState(null) }, [rcId])
  useEffect(() => { load() }, [tick, load])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const saveNote = (text: string) => {
    setNote(text)
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/eod/close', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rcId, handoverNote: text }),
        })
        if (!res.ok) throw new Error()
        dirty.current = false
      } catch {
        toast.show({ type: 'error', title: 'Handover note not saved — try again.' })
      }
    }, SAVE_MS)
  }

  const post = async (url: string) => {
    setBusy(true)
    try {
      // A note typed in the last moment goes in before the day closes.
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        await fetch('/api/eod/close', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rcId, handoverNote: note }),
        })
        dirty.current = false
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rcId }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) toast.show({ type: 'error', title: res.status === 409 ? 'Not ready to close yet' : (data && data.error) || 'Could not save — try again.' })
      await load()
    } catch {
      toast.show({ type: 'error', title: 'No connection — try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return (
      <section aria-label="Close the day" className="bg-paper border border-line rounded-[14px] px-4 py-4 text-[14px] text-ink-3">
        {error ?? 'Loading the close…'}
      </section>
    )
  }

  const p = state.progress
  const closed = state.close.status === 'CLOSED'
  const gates = [
    { ok: p.stationsSigned === p.stationsTotal, label: 'Stations signed off', value: p.stationsTotal === 0 ? 'none tonight' : `${p.stationsSigned}/${p.stationsTotal}` },
    { ok: p.sharedBlockersLeft === 0, label: 'Whole-kitchen must-dos', value: p.sharedBlockersLeft === 0 ? 'done' : `${p.sharedBlockersLeft} left`, href: '/checklist?phase=CLOSE' },
    ...(p.hasTempUnits ? [{ ok: p.tempsReady, label: 'Fridge temps logged, in range', value: p.tempsReady ? 'done' : 'check', href: '/temps' }] : []),
  ]
  const readyCount = gates.filter(g => g.ok).length

  return (
    <section aria-label="Close the day" className="flex flex-col gap-3">
      <div className="bg-ink text-paper rounded-[14px] px-[18px] py-4 flex flex-col gap-1">
        <span className="text-[19px] font-semibold tracking-[-0.02em]">Close the day</span>
        <span className="text-[13px] text-[#d4d4d8]">
          {closed
            ? <>Closed{state.close.signedOffByName ? ` by ${state.close.signedOffByName}` : ''}{state.close.signedOffAt ? ` at ${hhmm(state.close.signedOffAt)}` : ''}.</>
            : p.ready
              ? 'Everything is in. Write the handover, then close.'
              : `${readyCount} of ${gates.length} ready.`}
        </span>
      </div>

      <div className="bg-paper border border-line rounded-[14px] px-4 py-1.5">
        <ul className="m-0 p-0 list-none">
          {gates.map(g => <Gate key={g.label} {...g} />)}
        </ul>
        {flagsOpen > 0 && (
          <p className="m-0 py-2.5 border-t border-bg-2 font-mono text-[10.5px] text-ink-3">
            {flagsOpen} flagged {flagsOpen === 1 ? 'problem' : 'problems'} still open — they don’t hold the close; they stay in the Inbox.
          </p>
        )}
      </div>

      <label className="bg-paper border border-line rounded-[14px] px-4 py-3.5 flex flex-col gap-2">
        <span className="flex justify-between items-baseline gap-2">
          <span className="font-mono text-[10px] font-medium tracking-[0.08em] text-ink-3">KITCHEN HANDOVER</span>
          <span className="font-mono text-[10px] text-ink-3">every opener sees it tomorrow</span>
        </span>
        <textarea
          value={note}
          maxLength={NOTE_MAX}
          rows={3}
          disabled={closed && !canManage}
          onChange={e => saveNote(e.target.value)}
          placeholder="What does tomorrow's crew need to know? e.g. Alpha lowboy door seal is loose — food moved to the walk-in."
          className="w-full border border-line-2 rounded-[9px] px-3 py-2.5 text-[14px] leading-[1.45] text-ink bg-paper resize-y disabled:bg-bg-2"
        />
      </label>

      {canManage && (
        <Link href="/reports" className="bg-paper border border-line rounded-[14px] px-4 min-h-[48px] flex items-center justify-between text-[13.5px] text-ink-2">
          Today’s sales &amp; food cost <span className="font-mono text-[11px] text-gold-2">Reports →</span>
        </Link>
      )}

      {closed ? (
        canManage ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => post('/api/eod/close/reopen')}
            className="h-[50px] rounded-[12px] border border-line-2 bg-paper text-[14px] font-medium text-ink-2 disabled:opacity-50"
          >
            Reopen the day
          </button>
        ) : (
          <p className="m-0 text-center font-mono text-[11px] text-green-text">DAY CLOSED · ASK A MANAGER TO REOPEN</p>
        )
      ) : (
        <button
          type="button"
          disabled={busy || !p.ready}
          onClick={() => post('/api/eod/close/signoff')}
          className="h-[50px] rounded-[12px] text-[14px] font-semibold disabled:bg-line disabled:text-ink-3 bg-ink text-paper"
        >
          {p.ready ? 'Close the day' : `Close the day · ${p.blockers} ${p.blockers === 1 ? 'thing' : 'things'} left`}
        </button>
      )}
    </section>
  )
}
