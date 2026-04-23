'use client'
import { useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

export function MobileRcBar() {
  const { revenueCenters, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)

  if (!activeRc) return null
  const hex = rcHex(activeRc.color)

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-100 flex items-center px-4 h-10"
        style={{ borderLeftColor: hex, borderLeftWidth: 3 }}
      >
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700"
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          {activeRc.name}
          <ChevronDown size={14} className="text-gray-400" />
        </button>
      </div>

      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-[70] shadow-xl pb-safe">
            <div className="px-5 pt-4 pb-2 text-sm font-semibold text-gray-700">Revenue Center</div>
            <div className="px-4 pb-8 space-y-1">
              {revenueCenters.map(rc => (
                <button
                  key={rc.id}
                  onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                  <span className="flex-1 text-sm text-gray-800 text-left">{rc.name}</span>
                  {rc.id === activeRc.id && <Check size={16} className="text-blue-500" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
