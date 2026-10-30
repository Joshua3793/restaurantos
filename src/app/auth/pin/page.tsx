'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Keypad, PinDots, PIN_MAX, PIN_MIN } from '@/components/pin/Keypad'

// /auth/pin — public. A cook signs in on their own phone with their Toast
// clock-in PIN. PIN first, then "is this you?"; a phone a manager hasn't OK'd
// yet waits (polling) until a manager OKs it from their own signed-in
// session on Crew sign-in. No app chrome: /auth/* renders outside AppShell's
// chrome (see src/lib/chrome-routes.ts), the same as /login.
//
// The PIN lives in component memory only — never the URL or any storage —
// and is cleared on success, on "No", and 10 minutes after it was typed.

const POLL_MS = 4_000
const PIN_TTL_MS = 10 * 60_000
const GENERIC = 'Could not sign in — try again'

type Step =
  | { kind: 'enter'; error?: string; loginLink?: boolean; notice?: string }
  | { kind: 'confirm'; name: string }
  // deviceId: the request's row id from the POST, so the poll finds its own row.
  | { kind: 'waiting'; name: string; deviceId: string | null }
  | { kind: 'rejected'; name: string }
  | { kind: 'revoked'; name: string }
  | { kind: 'expired'; name: string }
  | { kind: 'locked'; message: string }
  | { kind: 'signingIn' }

type PinReply = { signedIn?: boolean; needsConfirm?: boolean; pending?: boolean; rejected?: boolean; name?: string; id?: string; error?: string }
type StatusReply = { devices: { id?: string; cookName: string; status: string }[]; pairCode?: string }

async function postPin(pin: string, confirm: boolean): Promise<{ status: number; data: PinReply } | null> {
  try {
    const res = await fetch('/api/auth/pin', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(confirm ? { pin, confirm: true } : { pin }),
    })
    const data = (await res.json().catch(() => ({}))) as PinReply
    return { status: res.status, data: data ?? {} }
  } catch {
    return null
  }
}

/** "Sam L." → "SL". */
function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}

const firstWord = (name: string) => name.trim().split(/\s+/)[0] ?? name

// ── Pieces (module scope) ─────────────────────────────────────────────────

const PRIMARY = 'w-full min-h-[50px] rounded-[12px] bg-ink text-paper text-[15px] font-medium disabled:opacity-40'
const SECONDARY = 'w-full min-h-[50px] rounded-[12px] border border-line-2 bg-paper text-ink-2 text-[15px] font-medium disabled:opacity-40'

function Avatar({ text }: { text: string }) {
  return (
    <div className="w-16 h-16 rounded-full bg-ink text-paper grid place-items-center font-mono text-[20px] font-semibold">
      {text}
    </div>
  )
}

function Screen({ children, align = 'center' }: { children: React.ReactNode; align?: 'center' | 'start' }) {
  return (
    <div className="min-h-[100dvh] bg-bg text-ink flex justify-center">
      <div
        className={`w-full max-w-[420px] flex flex-col gap-[22px] ${
          align === 'center' ? 'items-center px-6 pt-14 pb-7' : 'px-4 pt-10 pb-7'
        }`}
      >
        {children}
      </div>
    </div>
  )
}

function Notice({
  title,
  body,
  primary,
  secondary,
}: {
  title: string
  body: React.ReactNode
  primary?: { label: string; onClick: () => void; disabled?: boolean }
  secondary?: { label: string; onClick: () => void }
}) {
  return (
    <Screen>
      <div className="flex flex-col items-center gap-2.5 text-center">
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">{title}</h1>
        <p className="m-0 text-[15px] leading-[1.45] text-ink-2">{body}</p>
      </div>
      <div className="w-full flex flex-col gap-2.5">
        {primary && (
          <button type="button" className={PRIMARY} disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </button>
        )}
        {secondary && (
          <button type="button" className={SECONDARY} onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
      </div>
    </Screen>
  )
}

function StepRow({ done, title, sub, last }: { done: boolean; title: string; sub: string; last?: boolean }) {
  return (
    <li className={`flex items-center gap-3 px-4 py-3.5 ${last ? '' : 'border-b border-bg-2'}`}>
      {done ? (
        <span className="flex-none w-[26px] h-[26px] rounded-[7px] bg-green text-paper grid place-items-center font-mono text-[14px] font-semibold">✓</span>
      ) : (
        <span className="flex-none w-[26px] h-[26px] rounded-[7px] border-2 border-gold" />
      )}
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className={`text-[15px] ${done ? 'font-medium text-ink-3 line-through' : 'font-semibold text-ink'}`}>{title}</span>
        <span className={`font-mono text-[10.5px] ${done ? 'text-green-text' : 'text-gold-2'}`}>{sub}</span>
      </span>
      {!done && (
        <span className="flex-none font-mono text-[10px] font-medium px-[9px] py-[3px] rounded-full bg-gold-soft text-gold-2">WAITING</span>
      )}
    </li>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function PinSignInPage() {
  const [step, setStep] = useState<Step>({ kind: 'enter' })
  const [pin, setPinState] = useState('')
  const [busy, setBusy] = useState(false)
  const [pairCode, setPairCode] = useState<string | null>(null)
  const [waitError, setWaitError] = useState<string | null>(null)

  // Mirrors of state for async callbacks (component memory only).
  const pinRef = useRef('')
  const busyRef = useRef(false)
  const stepRef = useRef<Step>(step)
  stepRef.current = step
  // Bumped whenever the cook leaves a step (Cancel, No, Try a different PIN):
  // a reply to a POST sent before that is dropped, never applied.
  const epochRef = useRef(0)

  const setPin = useCallback((v: string) => {
    pinRef.current = v
    setPinState(v)
  }, [])

  // Forget the PIN 10 minutes after it was last typed.
  useEffect(() => {
    if (!pin) return
    const t = setTimeout(() => setPin(''), PIN_TTL_MS)
    return () => clearTimeout(t)
  }, [pin, setPin])

  const backToKeypad = useCallback((extra?: Omit<Extract<Step, { kind: 'enter' }>, 'kind'>) => {
    epochRef.current++
    setPin('')
    setPairCode(null)
    setWaitError(null)
    setStep({ kind: 'enter', ...extra })
  }, [setPin])

  /** POST the held PIN and move to whatever state the server answers with. */
  const submit = useCallback(async (confirm: boolean) => {
    if (busyRef.current) return
    const held = pinRef.current
    const from = stepRef.current.kind
    if (held.length < PIN_MIN) {
      // The PIN was forgotten (10 min) — it has to be typed again.
      backToKeypad({ notice: 'Type your PIN again.' })
      return
    }
    const epoch = epochRef.current
    busyRef.current = true
    setBusy(true)
    const r = await postPin(held, confirm)
    busyRef.current = false
    setBusy(false)
    // The cook cancelled while this was in flight: drop the answer.
    if (epoch !== epochRef.current) return

    const generic = () => {
      // A hiccup while waiting keeps the phone waiting; the next poll retries.
      if (from === 'waiting') setWaitError(GENERIC)
      else setStep({ kind: 'enter', error: GENERIC })
    }
    if (!r) return generic()
    const d = r.data
    const name = typeof d.name === 'string' && d.name ? d.name : null

    if (r.status === 200) {
      if (d.signedIn) {
        setPin('')
        setStep({ kind: 'signingIn' })
        // Hard navigation: every provider remounts against the new session (as /login does).
        window.location.assign('/checklist')
        return
      }
      if (!name) return generic()
      setWaitError(null)
      if (d.needsConfirm) return setStep({ kind: 'confirm', name })
      if (d.pending) return setStep({ kind: 'waiting', name, deviceId: typeof d.id === 'string' && d.id ? d.id : null })
      if (d.rejected) return setStep({ kind: 'rejected', name })
      return generic()
    }
    if (r.status === 401) return backToKeypad({ error: 'PIN not recognised' })
    if (r.status === 429) {
      setPin('')
      setWaitError(null)
      setStep({ kind: 'locked', message: d.error || 'Too many tries — wait 15 minutes' })
      return
    }
    if (r.status === 403) {
      const message = d.error || GENERIC
      return backToKeypad({ error: message, loginLink: /email and password/i.test(message) })
    }
    // 409 (this login needs a manager to fix it) and 503 (the PIN was right but
    // the server couldn't finish): show what the server said.
    if ((r.status === 409 || r.status === 503) && typeof d.error === 'string' && d.error) {
      if (from === 'waiting') setWaitError(d.error)
      else setStep({ kind: 'enter', error: d.error })
      return
    }
    generic()
  }, [backToKeypad, setPin])

  // ── Waiting: poll this phone's requests every 4 s while visible ──────────
  // Only while the PIN is still held: once the 10-minute clear runs, the
  // phone can't finish signing in by itself, so polling stops and the screen
  // asks for the PIN again (and the next "Yes, it's me" restarts the request's
  // clock on the server, so a request past 24 h doesn't wait forever).
  const waitingName = step.kind === 'waiting' ? step.name : null
  const waitingId = step.kind === 'waiting' ? step.deviceId : null
  const pinHeld = pin.length > 0
  useEffect(() => {
    if (!waitingName || !pinHeld) return
    let stopped = false
    let inFlight = false
    const tick = async () => {
      if (stopped || inFlight || busyRef.current || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const res = await fetch('/api/auth/pin/status', { cache: 'no-store' })
        if (stopped || !res.ok) return
        const data = (await res.json()) as StatusReply
        if (stopped) return
        setPairCode(data.pairCode ?? null)
        // Match on the request's own row; the display name only if the POST gave no id.
        const devices = data.devices ?? []
        const mine = waitingId ? devices.find(dv => dv.id === waitingId) : devices.find(dv => dv.cookName === waitingName)
        if (!mine) {
          // Pushed out (a newer request took its place) or cleared: ask again.
          setStep({ kind: 'expired', name: waitingName })
        } else if (mine.status === 'APPROVED') {
          if (pinRef.current) await submit(false)
        } else if (mine.status === 'REJECTED') {
          setStep({ kind: 'rejected', name: waitingName })
        } else if (mine.status === 'REVOKED') {
          setStep({ kind: 'revoked', name: waitingName })
        }
      } catch {
        // No connection: the next tick tries again.
      } finally {
        inFlight = false
      }
    }
    tick()
    const id = setInterval(tick, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [waitingName, waitingId, pinHeld, submit])

  // ── Keypad input ─────────────────────────────────────────────────────────
  const addDigit = useCallback((digit: string) => {
    if (pinRef.current.length >= PIN_MAX) return
    setPin(pinRef.current + digit)
    setStep(s => (s.kind === 'enter' && (s.error || s.notice) ? { kind: 'enter' } : s))
  }, [setPin])
  const backspace = useCallback(() => setPin(pinRef.current.slice(0, -1)), [setPin])

  // A hardware keyboard works too (the shared kitchen iPad, a laptop).
  const entering = step.kind === 'enter'
  useEffect(() => {
    if (!entering) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || busyRef.current) return
      if (/^\d$/.test(e.key)) addDigit(e.key)
      else if (e.key === 'Backspace') backspace()
      else if (e.key === 'Enter') {
        // Enter on a focused link or another button is that control's own
        // action. On the Sign in button itself the native click submits.
        const t = e.target instanceof Element ? e.target : null
        const control = t?.closest('a, button')
        if (control) return
        if (pinRef.current.length >= PIN_MIN) submit(false)
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entering, addDigit, backspace, submit])

  // ── Screens ──────────────────────────────────────────────────────────────

  if (step.kind === 'signingIn') {
    return (
      <Screen>
        <div className="flex-1 flex items-center">
          <div className="flex items-center gap-2 bg-green-soft text-green-text rounded-full px-3.5 py-2 font-mono text-[11px] font-medium">
            SIGNED IN · OPENING YOUR LIST…
          </div>
        </div>
      </Screen>
    )
  }

  if (step.kind === 'confirm') {
    return (
      <Screen>
        <div className="flex flex-col items-center gap-2.5 text-center">
          <Avatar text={initials(step.name)} />
          <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">
            <span className="font-fraunces italic font-medium text-gold-2">{step.name}</span>, is this you?
          </h1>
          <p className="m-0 text-[15px] leading-[1.45] text-ink-3">Your PIN matched this name.</p>
        </div>
        <div className="w-full flex flex-col gap-2.5">
          <button type="button" className={PRIMARY} disabled={busy} onClick={() => submit(true)}>
            {busy ? 'One moment…' : 'Yes, it’s me'}
          </button>
          <button type="button" className={SECONDARY} disabled={busy} onClick={() => backToKeypad()}>
            No — try again
          </button>
        </div>
      </Screen>
    )
  }

  if (step.kind === 'waiting') {
    return (
      <Screen align="start">
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">FIRST TIME ON THIS PHONE</div>
          <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Almost in, {firstWord(step.name)}</h1>
          <p className="m-0 text-[15px] leading-[1.45] text-ink-2">A manager needs to OK this phone once. After that it’s just your PIN.</p>
        </div>

        <ol className="list-none m-0 p-0 bg-paper border border-line rounded-[14px] overflow-hidden">
          <StepRow done title="PIN matched" sub={step.name} />
          <StepRow done title="Is this you" sub="Yes" />
          <StepRow done={false} title="Manager OKs this phone" sub="waiting" last />
        </ol>

        <section className="bg-paper border border-line rounded-[14px] px-4 py-4 flex flex-col gap-3">
          <p className="m-0 text-[15px] leading-[1.45] text-ink-2">
            Ask a manager to open <b className="font-semibold text-ink">Crew sign-in</b> on their phone and OK this one.
          </p>
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3">CODE</span>
            <span className="font-mono text-[34px] leading-none font-semibold tracking-[0.12em] text-ink">{pairCode ?? '····'}</span>
          </div>
          <p className="m-0 text-[13px] text-ink-3">The manager will see the same code.</p>
        </section>

        {!pin && (
          // The PIN was cleared (10 min): this phone stopped checking.
          <button type="button" className={PRIMARY} onClick={() => backToKeypad()}>
            Type your PIN again to keep waiting →
          </button>
        )}

        {waitError && <p className="m-0 text-[13px] text-red-text">{waitError}</p>}

        <div className="bg-bg-2 rounded-[12px] px-4 py-3.5 flex flex-col gap-1.5">
          <span className="text-[14px] font-semibold">Why the extra step?</span>
          <span className="text-[13px] leading-[1.45] text-ink-2">
            Your PIN signs your name on every job and opens your tips. The OK makes sure nobody else can use it from their phone.
          </span>
        </div>

        <div className="flex-1" />

        <button type="button" onClick={() => backToKeypad()} className="min-h-[44px] text-[13px] text-ink-3">
          Cancel
        </button>
      </Screen>
    )
  }

  if (step.kind === 'rejected') {
    return (
      <Notice
        title="Not OK’d"
        body={<>This phone wasn’t OK’d for <b className="font-semibold text-ink">{step.name}</b>. Ask a manager.</>}
        secondary={{ label: 'Try a different PIN', onClick: () => backToKeypad() }}
      />
    )
  }

  if (step.kind === 'revoked') {
    return (
      <Notice
        title="Phone switched off"
        body="This phone was switched off. Ask a manager."
        secondary={{ label: 'Try a different PIN', onClick: () => backToKeypad() }}
      />
    )
  }

  if (step.kind === 'expired') {
    return (
      <Notice
        title="Request ran out"
        body="Your request ran out. Tap to ask again."
        primary={{ label: busy ? 'Asking…' : 'Ask again', onClick: () => submit(true), disabled: busy }}
        secondary={{ label: 'Try a different PIN', onClick: () => backToKeypad() }}
      />
    )
  }

  if (step.kind === 'locked') {
    return (
      <Notice
        title="Locked for now"
        body={step.message}
        secondary={{ label: 'Back to the keypad', onClick: () => backToKeypad() }}
      />
    )
  }

  // enter
  return (
    <Screen>
      <div className="flex flex-col items-center gap-2.5 text-center">
        <Avatar text="PIN" />
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Sign in</h1>
        <p className="m-0 text-[15px] leading-[1.45] text-ink-3">Type the PIN you clock in with.</p>
      </div>

      <PinDots length={pin.length} />

      <div className="min-h-[20px] -my-2 text-center" aria-live="assertive">
        {step.error && (
          <p className="m-0 text-[13.5px] text-red-text">
            {step.error}
            {step.loginLink && (
              <>
                {' '}
                <Link href="/login" className="text-gold-2 underline underline-offset-2">Sign in with email →</Link>
              </>
            )}
          </p>
        )}
        {!step.error && step.notice && <p className="m-0 text-[13.5px] text-ink-2">{step.notice}</p>}
      </div>

      <Keypad length={pin.length} disabled={busy} onDigit={addDigit} onBack={backspace} />

      <button
        type="button"
        className={`${PRIMARY} max-w-[300px]`}
        disabled={busy || pin.length < PIN_MIN}
        onClick={() => submit(false)}
      >
        {busy ? 'Checking…' : 'Sign in'}
      </button>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-1">
        <Link href="/login" className="text-[13px] text-gold-2 min-h-[44px] flex items-center">
          Sign in with email instead
        </Link>
        <span className="font-mono text-[10.5px] text-ink-3 text-center">STAYS SIGNED IN ON THIS PHONE · TOO MANY WRONG TRIES PAUSES SIGN-IN FOR 15 MIN</span>
      </div>
    </Screen>
  )
}
