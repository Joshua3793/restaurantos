'use client'
import { useState } from 'react'
import { ChevronDown, Check, LayoutGrid } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import { AlertsBell } from '@/components/AlertsBell'

export function MobileRcBar() {
  const { revenueCenters, activeRcId, activeRc, setActiveRcId } = useRc()
  const [open, setOpen] = useState(false)

  if (revenueCenters.length === 0) return null

  const isAll = activeRcId === null
  const hex = activeRc ? rcHex(activeRc.color) : '#6b7280'

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-gray-100 flex items-center justify-between px-4 h-10"
        style={{ borderLeftColor: hex, borderLeftWidth: 3 }}
      >
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 text-sm font-medium text-gray-700"
        >
          {isAll
            ? <LayoutGrid size={14} className="text-gray-400 shrink-0" />
            : <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          }
          {isAll ? 'All Revenue Centers' : activeRc?.name}
          <ChevronDown size={14} className="text-gray-400" />
        </button>
        <AlertsBell dropdownAlign="right" />
      </div>

      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl z-[70] shadow-xl pb-safe">
            <div className="px-5 pt-4 pb-2 text-sm font-semibold text-gray-700">Revenue Center</div>
            <div className="px-4 pb-8 space-y-1">
              <button
                onClick={() => { setActiveRcId(null); setOpen(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
              >
                <LayoutGrid size={16} className="text-gray-400 shrink-0" />
                <span className="flex-1 text-sm text-gray-800 text-left">All Revenue Centers</span>
                {isAll && <Check size={16} className="text-blue-500" />}
              </button>
              {revenueCenters.map(rc => (
                <button
                  key={rc.id}
                  onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-50 transition-colors"
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                  <span className="flex-1 text-sm text-gray-800 text-left">{rc.name}</span>
                  {rc.id === activeRcId && <Check size={16} className="text-blue-500" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
