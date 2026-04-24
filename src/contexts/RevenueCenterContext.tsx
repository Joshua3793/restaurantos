'use client'
import { createContext, useContext, useState, useEffect, useCallback } from 'react'

export interface RevenueCenter {
  id: string
  name: string
  color: string
  isDefault: boolean
  isActive: boolean
  type: string
  description: string | null
  managerName: string | null
  targetFoodCostPct: string | null  // Prisma Decimal → string in JSON
  notes: string | null
  createdAt: string
}

interface RcContextValue {
  revenueCenters: RevenueCenter[]
  activeRcId: string | null
  activeRc: RevenueCenter | null
  setActiveRcId: (id: string | null) => void
  reload: () => Promise<void>
}

const RcContext = createContext<RcContextValue>({
  revenueCenters: [],
  activeRcId: null,
  activeRc: null,
  setActiveRcId: () => {},
  reload: async () => {},
})

export function RcProvider({ children }: { children: React.ReactNode }) {
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>([])
  const [activeRcId, setActiveRcIdState] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data: RevenueCenter[] = await fetch('/api/revenue-centers').then(r => r.json())
    setRevenueCenters(data)
    setActiveRcIdState(prev => {
      const stored = typeof window !== 'undefined' ? localStorage.getItem('activeRcId') : null
      if (stored === 'all') return null
      if (stored && data.find(rc => rc.id === stored)) return stored
      return data.find(rc => rc.isDefault)?.id ?? data[0]?.id ?? null
    })
  }, [])

  useEffect(() => { load() }, [load])

  const setActiveRcId = (id: string | null) => {
    setActiveRcIdState(id)
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem('activeRcId', id)
      else localStorage.setItem('activeRcId', 'all')
    }
  }

  const activeRc = revenueCenters.find(rc => rc.id === activeRcId) ?? null

  return (
    <RcContext.Provider value={{ revenueCenters, activeRcId, activeRc, setActiveRcId, reload: load }}>
      {children}
    </RcContext.Provider>
  )
}

export const useRc = () => useContext(RcContext)
