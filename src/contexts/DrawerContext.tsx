'use client'
import { createContext, useContext, useState, useCallback } from 'react'

interface DrawerContextValue {
  isAnyDrawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
}

const DrawerContext = createContext<DrawerContextValue>({
  isAnyDrawerOpen: false,
  setDrawerOpen: () => {},
})

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0)
  const setDrawerOpen = useCallback((open: boolean) => {
    setCount(n => open ? n + 1 : Math.max(0, n - 1))
  }, [])
  return (
    <DrawerContext.Provider value={{ isAnyDrawerOpen: count > 0, setDrawerOpen }}>
      {children}
    </DrawerContext.Provider>
  )
}

export const useDrawer = () => useContext(DrawerContext)
