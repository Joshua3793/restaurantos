'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { ChevronDown, Check, Settings2, LayoutGrid } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function RcSelector() {
  const { revenueCenters, activeRcId, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (revenueCenters.length === 0) return null

  const isAll = activeRcId === null
  const hex = activeRc ? rcHex(activeRc.color) : '#6b7280'

  return (
    <div ref={ref} className="relative px-3 py-2 border-b border-gray-700">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg transition-colors text-left overflow-hidden relative"
        style={isAll
          ? { backgroundColor: 'rgb(31 41 55)' } // gray-800
          : { backgroundColor: `${hex}22`, borderLeft: `4px solid ${hex}` }
        }
      >
        {isAll
          ? <LayoutGrid size={13} className="text-gray-400 shrink-0" />
          : null
        }
        <span className="flex-1 text-sm font-medium truncate" style={{ color: isAll ? '#d1d5db' : hex }}>
          {isAll ? 'All Revenue Centers' : activeRc?.name}
        </span>
        <ChevronDown size={14} className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <button
            onClick={() => { setActiveRcId(null); setOpen(false) }}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
          >
            <LayoutGrid size={10} className="text-gray-400 shrink-0" />
            <span className="flex-1 text-sm text-gray-100 truncate">All Revenue Centers</span>
            {isAll && <Check size={14} className="text-blue-400" />}
          </button>
          <div className="border-t border-gray-700" />
          {revenueCenters.map(rc => (
            <button
              key={rc.id}
              onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
            >
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
              <span className="flex-1 text-sm text-gray-100 truncate">{rc.name}</span>
              {rc.id === activeRcId && <Check size={14} className="text-blue-400" />}
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
