'use client'
import { createContext, useContext, useCallback, useRef, useState } from 'react'
import { IcCheck } from './icons'

type ToastFn = (msg: string) => void
const ToastCtx = createContext<ToastFn>(() => {})
export const usePrepToast = () => useContext(ToastCtx)

export function PrepToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((m: string) => {
    setMsg(m)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setMsg(null), 2600)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className={`fixed left-1/2 -translate-x-1/2 z-[120] bottom-6 transition-all duration-200 ${msg ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5 pointer-events-none'}`}>
        <div className="bg-ink text-paper text-sm font-medium px-[18px] py-[11px] rounded-[11px] shadow-2xl flex items-center gap-2.5">
          <IcCheck className="text-green w-[15px] h-[15px]" /> {msg}
        </div>
      </div>
    </ToastCtx.Provider>
  )
}
