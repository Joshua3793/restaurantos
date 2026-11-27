'use client'
import { useState } from 'react'

/**
 * On a shared phone: answers another cook saved with no signal. They only send
 * under that cook's own sign-in, so say whose they are and when they go. A lead
 * (and up) can throw them away — two taps, never a browser pop-up.
 */
export function OthersWaiting({ name, count, canDiscard, onDiscard }: {
  name: string
  count: number
  canDiscard: boolean
  onDiscard: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const first = name.split(' ')[0] || name
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-2 px-3 py-2 text-[12.5px] text-ink-2">
      <span className="flex-1 min-w-0">
        {count} {count === 1 ? 'answer' : 'answers'} from <b className="font-semibold">{name}</b> waiting — {count === 1 ? 'it sends' : 'they send'} when {first} signs in on this phone.
      </span>
      {canDiscard && (confirming ? (
        <span className="flex items-center gap-2">
          <button type="button" onClick={onDiscard} className="min-h-[36px] px-3 rounded-full bg-ink text-paper text-[12px] font-medium">
            Discard {count === 1 ? 'it' : `all ${count}`}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="min-h-[36px] px-3 rounded-full border border-line text-[12px] font-medium">
            Keep
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="min-h-[36px] px-3 rounded-full border border-line bg-paper text-[12px] font-medium">
          Discard
        </button>
      ))}
    </div>
  )
}
