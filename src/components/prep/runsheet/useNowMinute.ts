'use client'
// Prep run-sheet — the live clock hook.
// Ticks every 30s and exposes both an epoch (`nowMs`, for elapsed-timer math on
// the in-progress rail) and minutes-since-Pacific-local-midnight (`nowMin`, the
// basis every start-by comparison in the ladder uses). The restaurant runs on
// Pacific time regardless of server/browser TZ — mirrors the businessDateLocal
// convention in src/lib/eod-close.ts rather than reinventing the math.
import { useState, useEffect } from 'react'

const RESTAURANT_TZ = 'America/Los_Angeles'

// Minutes since Pacific-local midnight for the given instant.
function pacificMinuteOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RESTAURANT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms))
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  // Some engines emit '24' for midnight with hour12:false — normalize to 0.
  return (h % 24) * 60 + m
}

export function useNowMinute(): { nowMs: number; nowMin: number } {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return { nowMs, nowMin: pacificMinuteOfDay(nowMs) }
}
