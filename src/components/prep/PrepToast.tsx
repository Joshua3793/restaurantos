'use client'
import { useCallback, useRef, useState } from 'react'
import { IcCheck } from './icons'

interface ToastAction { label: string; onClick: () => void }
interface ToastState { msg: string; action?: ToastAction }

// A plain toast reads and vanishes; one carrying an action has to be readable
// AND reachable, so it holds more than twice as long.
const PLAIN_MS = 2600
// Undo stays up long enough to read the list and change your mind.
const ACTION_MS = 10000

export function usePrepToast() {
  const [state, setState] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((m: string, action?: ToastAction) => {
    setState({ msg: m, action })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), action ? ACTION_MS : PLAIN_MS)
  }, [])

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setState(null)
  }, [])

  // Phones: sit above the bottom tab bar (~60px) and the home bar, not under them.
  const toastNode = (
    <div className={`fixed left-1/2 -translate-x-1/2 z-[120] bottom-6 max-md:bottom-[calc(env(safe-area-inset-bottom,0px)_+_80px)] max-md:w-max max-md:max-w-[calc(100vw_-_32px)] transition-all duration-200 ${state ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5 pointer-events-none'}`}>
      <div className="bg-ink text-paper text-sm font-medium px-[18px] py-[11px] rounded-[11px] shadow-2xl flex items-center gap-2.5">
        <IcCheck className="text-green w-[15px] h-[15px]" /> {state?.msg}
        {state?.action && (
          <button
            type="button"
            onClick={() => { state.action?.onClick(); dismiss() }}
            // Phones: a 44px-tall tap area that fills the toast without making it taller.
            className="ml-1.5 pl-3 border-l border-ink-3 text-gold font-semibold cursor-pointer shrink-0 max-md:min-h-[44px] max-md:-my-[11px] max-md:pr-3 max-md:-mr-[10px] max-md:inline-flex max-md:items-center"
          >
            {state.action.label}
          </button>
        )}
      </div>
    </div>
  )

  return { toast, toastNode }
}
