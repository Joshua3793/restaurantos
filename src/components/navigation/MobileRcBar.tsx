'use client'
import { useState } from 'react'
import { ChevronDown, Check, LayoutGrid, MapPin } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'
import { AlertsBell } from '@/components/AlertsBell'

export function MobileRcBar() {
  const {
    locations, revenueCenters,
    activeKind, activeRcId, activeRc, activeLocationId, activeLocation,
    setActiveRcId, setActiveLocation, setActiveAll,
  } = useRc()
  const [open, setOpen] = useState(false)
  // Picking a location applies a read-only location lens to the current page.
  const pickLocation = (id: string) => { setActiveLocation(id) }

  if (revenueCenters.length === 0 && locations.length === 0) return null

  const isAll = activeKind === 'all'
  const isLoc = activeKind === 'location'
  const hex = isLoc && activeLocation
    ? rcHex(activeLocation.color)
    : activeRc ? rcHex(activeRc.color) : '#6b7280'
  const label = isAll
    ? 'All Revenue Centers'
    : isLoc ? activeLocation?.name : activeRc?.name

  return (
    <>
      <div
        className="md:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-line flex flex-col"
        style={{ borderLeftColor: hex, borderLeftWidth: 3 }}
      >
        {/* Status bar spacer */}
        <div className="pt-safe" />
        <div className="flex items-center justify-between px-4 h-10">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 text-sm font-medium text-ink-2"
        >
          {isAll
            ? <LayoutGrid size={14} className="text-ink-4 shrink-0" />
            : isLoc
              ? <MapPin size={14} className="shrink-0" style={{ color: hex }} />
              : <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          }
          {label}
          <ChevronDown size={14} className="text-ink-4" />
        </button>
          <AlertsBell dropdownAlign="right" />
        </div>
      </div>

      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/40 z-[60]" onClick={() => setOpen(false)} />
          <div className="md:hidden fixed bottom-0 left-0 right-0 max-h-[80vh] overflow-y-auto bg-white rounded-t-2xl z-[70] shadow-xl pb-safe">
            <div className="px-5 pt-4 pb-2 text-sm font-semibold text-ink-2">Revenue Center</div>
            <div className="px-4 pb-8 space-y-1">
              <button
                onClick={() => { setActiveAll(); setOpen(false) }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-bg transition-colors"
              >
                <LayoutGrid size={16} className="text-ink-4 shrink-0" />
                <span className="flex-1 text-sm text-ink-2 text-left">All Revenue Centers</span>
                {isAll && <Check size={16} className="text-blue" />}
              </button>

              {locations.map(loc => (
                <div key={loc.id}>
                  {/* Location header row (selectable) */}
                  <button
                    onClick={() => { pickLocation(loc.id); setOpen(false) }}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-bg transition-colors"
                  >
                    <MapPin size={16} className="shrink-0" style={{ color: rcHex(loc.color) }} />
                    <span className="flex-1 text-sm font-semibold text-ink-2 text-left">{loc.name}</span>
                    {isLoc && loc.id === activeLocationId && <Check size={16} className="text-blue" />}
                  </button>
                  {/* Nested RCs */}
                  {loc.revenueCenters.map(rc => (
                    <button
                      key={rc.id}
                      onClick={() => { setActiveRcId(rc.id); setOpen(false) }}
                      className="w-full flex items-center gap-3 pl-9 pr-3 py-3 rounded-xl hover:bg-bg transition-colors"
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                      <span className="flex-1 text-sm text-ink-2 text-left">{rc.name}</span>
                      <span className="text-xs shrink-0" title={rc.type === 'DRINK' ? 'Drink' : 'Food'}>
                        {rc.type === 'DRINK' ? '🍸' : '🍴'}
                      </span>
                      {activeKind === 'rc' && rc.id === activeRcId && <Check size={16} className="text-blue" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
