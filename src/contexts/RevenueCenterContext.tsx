'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface RevenueCenter {
  id: string
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  locationId: string
  description: string | null
  managerName: string | null
  targetFoodCostPct: string | null  // Prisma Decimal → string in JSON (back-compat)
  targetCostPct: string | null      // Prisma Decimal → string in JSON
  notes: string | null
  prepLeadMinutes: number | null
  /** Active services for this RC, ascending by start. Empty ⇒ on-demand. */
  services: { id: string; name: string; timeMinutes: number; endMinutes: number | null }[]
  createdAt: string
}

export interface Location {
  id: string
  name: string
  color: string
  type: string            // 'restaurant' | 'catering' | 'other'
  isDefault: boolean
  isActive: boolean
  revenueCenters: RevenueCenter[]
}

type ActiveKind = 'location' | 'rc' | 'all'
interface ActiveNode { kind: ActiveKind; id: string | null }

interface RcContextValue {
  // existing (keep working):
  revenueCenters: RevenueCenter[]   // flat list of all in-scope RCs (derived from locations)
  activeRcId: string | null         // the active RC id, or null when a Location/all is active
  activeRc: RevenueCenter | null
  setActiveRcId: (id: string | null) => void   // selecting an RC id (null → "all")
  reload: () => Promise<void>
  // new:
  locations: Location[]
  activeKind: ActiveKind
  activeLocationId: string | null
  activeLocation: Location | null
  setActiveLocation: (id: string) => void
  setActiveAll: () => void
  isReadOnly: boolean               // true when activeKind !== 'rc' (Location/all are read-only)
}

const RcContext = createContext<RcContextValue>({
  revenueCenters: [],
  activeRcId: null,
  activeRc: null,
  setActiveRcId: () => {},
  reload: async () => {},
  locations: [],
  activeKind: 'all',
  activeLocationId: null,
  activeLocation: null,
  setActiveLocation: () => {},
  setActiveAll: () => {},
  isReadOnly: true,
})

const NODE_KEY = 'activeNode'
const LEGACY_KEY = 'activeRcId'

function flattenRcs(locations: Location[]): RevenueCenter[] {
  return locations.flatMap(l => l.revenueCenters)
}

// Resolve the active node from storage / legacy migration, falling back to a
// sensible default. Pure — given the loaded locations.
function resolveActiveNode(locations: Location[]): ActiveNode {
  const rcs = flattenRcs(locations)
  const defaultNode = (): ActiveNode => {
    const def = rcs.find(rc => rc.isDefault) ?? rcs[0]
    return def ? { kind: 'rc', id: def.id } : { kind: 'all', id: null }
  }

  if (typeof window === 'undefined') return defaultNode()

  // Preferred: new activeNode key
  const rawNode = localStorage.getItem(NODE_KEY)
  if (rawNode) {
    try {
      const parsed = JSON.parse(rawNode) as ActiveNode
      if (parsed.kind === 'all') return { kind: 'all', id: null }
      if (parsed.kind === 'rc' && parsed.id && rcs.find(rc => rc.id === parsed.id)) {
        return { kind: 'rc', id: parsed.id }
      }
      if (parsed.kind === 'location' && parsed.id && locations.find(l => l.id === parsed.id)) {
        return { kind: 'location', id: parsed.id }
      }
    } catch {
      // fall through to legacy / default
    }
    // stored node no longer valid → default
    return defaultNode()
  }

  // Migrate legacy activeRcId key
  const legacy = localStorage.getItem(LEGACY_KEY)
  if (legacy) {
    if (legacy === 'all') return { kind: 'all', id: null }
    if (rcs.find(rc => rc.id === legacy)) return { kind: 'rc', id: legacy }
  }

  return defaultNode()
}

export function RcProvider({ children }: { children: React.ReactNode }) {
  const [locations, setLocations] = useState<Location[]>([])
  const [active, setActive] = useState<ActiveNode>({ kind: 'all', id: null })

  const persist = (node: ActiveNode) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(NODE_KEY, JSON.stringify(node))
    }
  }

  const load = useCallback(async () => {
    const data: Location[] = await fetch('/api/locations').then(r => r.json())
    const locs = Array.isArray(data) ? data : []
    setLocations(locs)
    // Re-resolve active selection against the freshly loaded locations
    // (handles first load, migration, and a stored node that disappeared).
    setActive(resolveActiveNode(locs))
  }, [])

  useEffect(() => { load() }, [load])

  const revenueCenters = flattenRcs(locations)

  const setActiveRcId = (id: string | null) => {
    if (id === null) { setActiveAll(); return }
    const node: ActiveNode = { kind: 'rc', id }
    setActive(node)
    persist(node)
  }

  const setActiveLocation = (id: string) => {
    const node: ActiveNode = { kind: 'location', id }
    setActive(node)
    persist(node)
  }

  const setActiveAll = () => {
    const node: ActiveNode = { kind: 'all', id: null }
    setActive(node)
    persist(node)
  }

  const activeRcId = active.kind === 'rc' ? active.id : null
  const activeRc = activeRcId ? revenueCenters.find(rc => rc.id === activeRcId) ?? null : null
  const activeLocationId = active.kind === 'location' ? active.id : null
  const activeLocation = activeLocationId ? locations.find(l => l.id === activeLocationId) ?? null : null
  const isReadOnly = active.kind !== 'rc'

  return (
    <RcContext.Provider value={{
      revenueCenters,
      activeRcId,
      activeRc,
      setActiveRcId,
      reload: load,
      locations,
      activeKind: active.kind,
      activeLocationId,
      activeLocation,
      setActiveLocation,
      setActiveAll,
      isReadOnly,
    }}>
      {children}
    </RcContext.Provider>
  )
}

export const useRc = () => useContext(RcContext)
