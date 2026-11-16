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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PrepItemRich } from '@/components/prep/types'
import { onTheGo, alarmShouldRing, type GoRow } from '@/lib/prep-on-the-go'
import { nextAction } from '@/lib/prep-steps'

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
    try { setCanAskNotify(typeof Notification !== 'undefined' && Notification.permission === 'default') } catch { /* none */ }
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const due = useMemo(() => onTheGo(items, nowMs).filter(r => r.state === 'ready'), [items, nowMs])

  useEffect(() => {
    const live = new Set(due.map(r => r.item.id))
    for (const id of lastRang.current.keys()) if (!live.has(id)) lastRang.current.delete(id)
    const ringing = due.filter(r => r.clock && alarmShouldRing(r.clock.readyAtMs, lastRang.current.get(r.item.id) ?? null, nowMs))
    if (ringing.length === 0) return
    for (const r of ringing) lastRang.current.set(r.item.id, nowMs)
    if (muted) return
    chime()
    buzz()
    ringing.forEach(notify)
  }, [due, nowMs, muted])

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
