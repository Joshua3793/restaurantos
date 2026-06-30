'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronDown, Check, Settings2, LayoutGrid, MapPin } from 'lucide-react'
import { useRc, type Location } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

/** FOOD/DRINK affordance — subtle emoji + label. */
function RcTypeDot({ type }: { type: string }) {
  const drink = type === 'DRINK'
  return (
    <span className="text-[10px] shrink-0" title={drink ? 'Drink' : 'Food'}>
      {drink ? '🍸' : '🍴'}
    </span>
  )
}

/**
 * Two-tier revenue-center switcher (Location → RevenueCenter + "All").
 *  - default: full-width pill for the sidebar.
 *  - compact: small inline pill for the always-visible top bar, so the active
 *    node stays visible even when the nav is collapsed.
 */
export function RcSelector({ compact = false }: { compact?: boolean }) {
  const {
    locations, revenueCenters,
    activeKind, activeRcId, activeRc, activeLocationId, activeLocation,
    setActiveRcId, setActiveLocation, setActiveAll,
  } = useRc()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  if (revenueCenters.length === 0 && locations.length === 0) return null

  const isAll = activeKind === 'all'
  const isLoc = activeKind === 'location'
  const hex = isLoc && activeLocation
    ? rcHex(activeLocation.color)
    : activeRc ? rcHex(activeRc.color) : '#6b7280'
  const label = isAll
    ? 'All Revenue Centers'
    : isLoc ? activeLocation?.name : activeRc?.name

  const menu = (
    <RcMenu
      locations={locations}
      activeKind={activeKind}
      activeRcId={activeRcId}
      activeLocationId={activeLocationId}
      onPickAll={() => { setActiveAll(); setOpen(false) }}
      onPickLocation={(id) => { setActiveLocation(id); setOpen(false); router.push('/location') }}
      onPickRc={(id) => { setActiveRcId(id); setOpen(false) }}
      onManage={() => setOpen(false)}
    />
  )

  // ── Compact (top bar) ─────────────────────────────────────────────────────
  if (compact) {
    return (
      <div ref={ref} className="relative shrink-0">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-md hover:bg-white/5 transition-colors max-w-[200px]"
          title="Active revenue center"
        >
          {isAll
            ? <LayoutGrid size={13} className="text-ink-4 shrink-0" />
            : isLoc
              ? <MapPin size={13} className="shrink-0" style={{ color: hex }} />
              : <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: hex }} />
          }
          <span className="text-[13px] font-medium tracking-[-0.005em] truncate" style={{ color: isAll ? '#d4d4d8' : hex }}>
            {isAll ? 'All RCs' : label}
          </span>
          <ChevronDown size={13} className="text-ink-3 shrink-0" />
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-2 min-w-[240px] max-h-[70vh] overflow-y-auto bg-ink border border-ink-2 rounded-xl shadow-xl z-50">
            {menu}
          </div>
        )}
      </div>
    )
  }

  // ── Default (sidebar) ─────────────────────────────────────────────────────
  return (
    <div ref={ref} className="relative px-3 py-2 border-b border-ink-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 pl-3 pr-2 py-2 rounded-lg transition-colors text-left overflow-hidden relative"
        style={isAll
          ? { backgroundColor: 'rgb(31 41 55)' } // gray-800
          : { backgroundColor: `${hex}22`, borderLeft: `4px solid ${hex}` }
        }
      >
        {isAll
          ? <LayoutGrid size={13} className="text-ink-4 shrink-0" />
          : isLoc
            ? <MapPin size={13} className="shrink-0" style={{ color: hex }} />
            : null
        }
        <span className="flex-1 text-sm font-medium truncate" style={{ color: isAll ? '#d1d5db' : hex }}>
          {label}
        </span>
        <ChevronDown size={14} className="text-ink-4 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 max-h-[70vh] overflow-y-auto bg-ink border border-ink-2 rounded-xl shadow-xl z-50">
          {menu}
        </div>
      )}
    </div>
  )
}

// Shared two-tier dropdown body for both variants.
function RcMenu({
  locations, activeKind, activeRcId, activeLocationId,
  onPickAll, onPickLocation, onPickRc, onManage,
}: {
  locations: Location[]
  activeKind: 'location' | 'rc' | 'all'
  activeRcId: string | null
  activeLocationId: string | null
  onPickAll: () => void
  onPickLocation: (id: string) => void
  onPickRc: (id: string) => void
  onManage: () => void
}) {
  return (
    <>
      <button
        onClick={onPickAll}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-ink-2 transition-colors text-left"
      >
        <LayoutGrid size={10} className="text-ink-4 shrink-0" />
        <span className="flex-1 text-sm text-ink-4 truncate">All Revenue Centers</span>
        {activeKind === 'all' && <Check size={14} className="text-blue" />}
      </button>
      <div className="border-t border-ink-2" />

      {locations.map(loc => {
        const lhex = rcHex(loc.color)
        return (
          <div key={loc.id}>
            {/* Location header row (selectable) */}
            <button
              onClick={() => onPickLocation(loc.id)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-ink-2 transition-colors text-left"
            >
              <MapPin size={12} className="shrink-0" style={{ color: lhex }} />
              <span className="flex-1 text-sm font-medium text-ink-4 truncate">{loc.name}</span>
              {activeKind === 'location' && loc.id === activeLocationId && <Check size={14} className="text-blue" />}
            </button>
            {/* Nested RCs */}
            {loc.revenueCenters.map(rc => (
              <button
                key={rc.id}
                onClick={() => onPickRc(rc.id)}
                className="w-full flex items-center gap-2 pl-9 pr-3 py-2 hover:bg-ink-2 transition-colors text-left"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className="flex-1 text-sm text-ink-4 truncate">{rc.name}</span>
                <RcTypeDot type={rc.type} />
                {activeKind === 'rc' && rc.id === activeRcId && <Check size={14} className="text-blue" />}
              </button>
            ))}
          </div>
        )
      })}

      <div className="border-t border-ink-2 p-1">
        <Link
          href="/revenue-centers"
          onClick={onManage}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-ink-4 hover:text-ink-4 hover:bg-ink-2 transition-colors"
        >
          <Settings2 size={12} />
          Manage Revenue Centers
        </Link>
      </div>
    </>
  )
}
