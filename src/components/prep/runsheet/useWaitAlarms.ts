'use client'
// The wait-over alarm. ONE instance per page (the prep page mounts the desktop
// and phone run sheets at the same time — two hooks would chime twice), fed to
// both as a banner + the per-device mute switch.
//
// When a job's current wait runs out: one short chime, a buzz on phones that
// support it, and — when the tab is hidden and the cook allowed it — a browser
// notification. Repeats every ALARM_REPEAT_MIN minutes until the job moves on.
// Every browser call is guarded: sound blocked before the first tap, no
// AudioContext, no Notification, private-mode storage — none of it throws; the
// banner shows regardless.
//
// In the phone app the alarm also works on a LOCKED phone: every running wait
// is handed to the system as a local notification at its ready time (asking
// for permission the first time a wait starts), and taken back when the wait
// is stopped, moved on, changed or the job is done. The in-page chime stays.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import { onTheGo, alarmShouldRing, type GoRow } from '@/lib/prep-on-the-go'
import { nextAction, type CookItem } from '@/lib/prep-steps'
import { isNative } from '@/lib/capacitor'
import {
  cancelNotifications, notifyPermission, pendingNotificationIds, scheduleNotifications,
  type LocalNotificationSpec,
} from '@/lib/native'

const MUTE_KEY = 'prep.alarms.muted'
const TICK_MS = 15_000

let audioCtx: AudioContext | null = null
function getAudio(): AudioContext | null {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return null
    audioCtx = audioCtx ?? new Ctx()
    return audioCtx
  } catch { return null }
}
/** iPhones (and Chrome before any tap) only let a page make sound after a tap:
 *  create + resume the audio on the first touch and play one silent sample, so
 *  the alarm's later chime is allowed. */
function unlockAudio() {
  try {
    const ctx = getAudio()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const src = ctx.createBufferSource()
    src.buffer = ctx.createBuffer(1, 1, 22050)
    src.connect(ctx.destination)
    src.start(0)
  } catch { /* sound unavailable */ }
}
function chime() {
  try {
    const ctx = getAudio()
    if (!ctx) return
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const tone = (freq: number, at: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.2, ctx.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.15)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + at)
      osc.stop(ctx.currentTime + at + 0.16)
    }
    tone(880, 0)
    tone(660, 0.18)
  } catch { /* sound unavailable — the banner still shows */ }
}

function buzz() {
  try { navigator.vibrate?.([200, 100, 200]) } catch { /* no vibration */ }
}

function notify(row: GoRow<PrepItemRich>) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return
    const next = row.seq ? nextAction(row.seq, row.pos, row.clock) : null
    new Notification(`${row.item.name} is ready`, {
      body: `${row.cur?.phase ?? 'Wait'} done.${next ? ` ${next.label}.` : ''}`,
      tag: `prep-wait-${row.item.id}`,
    })
  } catch { /* notifications unavailable */ }
}

// ── Locked-phone alarms (phone app only) ────────────────────────────────────

const NOTIFY_KIND = 'prep-wait'

/** A stable positive 31-bit id for one wait of one job (FNV-1a of log id + step key). */
export function waitNotificationId(logId: string, stepKey: string): number {
  let h = 0x811c9dc5
  const str = `${logId}|${stepKey}`
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 2_147_483_646) + 1
}

/** "Next: Kale" — the next phase's name, else the next step, else logging the yield. */
function nextWords(seq: CookItem[], pos: number): string {
  const cur = seq[pos], nxt = seq[pos + 1]
  if (!nxt) return 'log yield'
  if (nxt.phase && nxt.phase !== cur?.phase) return nxt.phase
  return nxt.kind === 'STEP' ? `step ${nxt.number}` : (nxt.phase ?? 'next step')
}

interface PlannedAlarm extends LocalNotificationSpec { sig: string }

/** One notification per running wait whose clock is known. */
function plannedAlarms(rows: GoRow<PrepItemRich>[]): PlannedAlarm[] {
  const out: PlannedAlarm[] = []
  for (const r of rows) {
    const logId = r.item.todayLog?.id
    if (!logId || logId.startsWith('_opt_') || !r.seq || !r.cur || r.cur.kind !== 'WAIT' || !r.clock) continue
    const title = `${r.item.name}: ${r.cur.phase ?? 'Wait'} is done — next: ${nextWords(r.seq, r.pos)}`
    const at = new Date(r.clock.readyAtMs)
    out.push({
      id: waitNotificationId(logId, r.cur.key),
      title,
      body: 'Open the prep To Do to move it on.',
      at,
      extra: { kind: NOTIFY_KIND, logId, stepKey: r.cur.key },
      sig: `${at.getTime()}|${title}`,
    })
  }
  return out
}

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}

export interface WaitAlarms {
  /** Jobs whose wait is over, longest-ready first — one banner each. */
  due: GoRow<PrepItemRich>[]
  muted: boolean
  toggleMuted: () => void
  /** Offered in the menu only while the browser has not been asked yet. */
  canAskNotify: boolean
  askNotify: () => void
}

export function useWaitAlarms(items: PrepItemRich[]): WaitAlarms {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [muted, setMuted] = useState(false)
  // Nothing rings or asks for alarm permission until the saved mute is read —
  // a muted cook must never get the lock-screen prompt on page load.
  const [muteRead, setMuteRead] = useState(false)
  const [canAskNotify, setCanAskNotify] = useState(false)
  const lastRang = useRef(new Map<string, number>())

  useEffect(() => {
    const unlock = () => {
      unlockAudio()
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('touchend', unlock)
    }
    document.addEventListener('pointerdown', unlock)
    document.addEventListener('touchend', unlock)
    return () => {
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('touchend', unlock)
    }
  }, [])

  useEffect(() => {
    setMuted(readMuted())
    setMuteRead(true)
    try { setCanAskNotify(typeof Notification !== 'undefined' && Notification.permission === 'default') } catch { /* none */ }
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const due = useMemo(() => onTheGo(items, nowMs).filter(r => r.state === 'ready'), [items, nowMs])

  useEffect(() => {
    const live = new Set(due.map(r => r.item.id))
    for (const id of lastRang.current.keys()) if (!live.has(id)) lastRang.current.delete(id)
    const ringing = due.filter(r => r.clock && alarmShouldRing(r.clock.readyAtMs, lastRang.current.get(r.item.id) ?? null, nowMs))
    if (!muteRead || ringing.length === 0) return
    for (const r of ringing) lastRang.current.set(r.item.id, nowMs)
    if (muted) return
    chime()
    buzz()
    ringing.forEach(notify)
  }, [due, nowMs, muted, muteRead])

  // Locked-phone alarms. Keyed on the plan's signature, not the 15 s tick, so
  // the bridge is only called when a wait actually starts, moves or ends.
  const planned = useMemo(() => plannedAlarms(onTheGo(items, Date.now())), [items])
  const plannedKey = useMemo(() => planned.map(a => `${a.id}:${a.sig}`).sort().join(','), [planned])
  const scheduled = useRef<Map<number, string> | null>(null)   // id → sig handed to the system
  const syncChain = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!isNative() || !muteRead) return
    // Before the list has loaded there is no plan to compare with — wait, so a
    // slow first load never wipes alarms that are still right.
    if (scheduled.current === null && items.length === 0) return
    const want = muted ? [] : planned
    syncChain.current = syncChain.current.then(async () => {
      try {
        // First pass after a page load: take back whatever an earlier visit
        // left pending, then schedule the current plan fresh.
        if (scheduled.current === null) {
          await cancelNotifications(await pendingNotificationIds(NOTIFY_KIND))
          scheduled.current = new Map()
        }
        const have = scheduled.current
        const wantById = new Map(want.map(a => [a.id, a]))
        const stale = [...have.entries()].filter(([id, sig]) => wantById.get(id)?.sig !== sig).map(([id]) => id)
        await cancelNotifications(stale)
        stale.forEach(id => have.delete(id))
        const now = Date.now()
        const fresh = want.filter(a => !have.has(a.id) && a.at.getTime() > now + 1000)
        if (fresh.length === 0) return
        // The first time a wait starts, ask to show alarms on the lock screen.
        if ((await notifyPermission(true)) !== 'granted') return
        if (await scheduleNotifications(fresh)) fresh.forEach(a => have.set(a.id, a.sig))
      } catch { /* the in-page chime still rings */ }
    })
    // plannedKey stands in for `planned` (a new array every items change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannedKey, muted, muteRead, items.length === 0])

  const toggleMuted = useCallback(() => {
    setMuted(m => {
      try { localStorage.setItem(MUTE_KEY, m ? '0' : '1') } catch { /* storage off */ }
      return !m
    })
  }, [])

  const askNotify = useCallback(() => {
    try {
      void Notification.requestPermission().then(() => setCanAskNotify(Notification.permission === 'default')).catch(() => {})
    } catch { /* unsupported */ }
  }, [])

  return { due, muted, toggleMuted, canAskNotify, askNotify }
}
