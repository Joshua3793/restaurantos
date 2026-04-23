'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, Check, Settings2 } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function RcSelector() {
  const { revenueCenters, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (!activeRc) return null

  const hex = rcHex(activeRc.color)

  return (
    <div ref={ref} className="relative px-3 py-2 border-b border-gray-700">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 transition-colors text-left"
      >
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: hex }} />
        <span className="flex-1 text-sm text-gray-100 truncate">{activeRc.name}</span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          {revenueCenters.map(rc => (
            <button
              key={rc.id}
              onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
              <span className="flex-1 text-sm text-gray-100 truncate">{rc.name}</span>
              {rc.id === activeRc.id && <Check size={14} className="text-blue-400" />}
            </button>
          ))}
          <div className="border-t border-gray-700 p-1">
            <Link
              href="/revenue-centers"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
            >
              <Settings2 size={12} />
              Manage Revenue Centers
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
