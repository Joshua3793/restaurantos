'use client'
import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react'

export interface SoftNotification {
  id: string
  type: 'invoice_ready' | 'invoice_applied'
  sessionId: string
  supplierName: string | null
  invoiceNumber: string | null
  actionLabel: string
  onAction: () => void
}

interface NotificationContextValue {
  notifications: SoftNotification[]
  push: (n: Omit<SoftNotification, 'id'>) => void
  dismiss: (id: string) => void
  dismissAll: () => void
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  push: () => {},
  dismiss: () => {},
  dismissAll: () => {},
})

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<SoftNotification[]>([])
  const counterRef = useRef(0)

  const push = useCallback((n: Omit<SoftNotification, 'id'>) => {
    counterRef.current++
    const id = `notif-${counterRef.current}`
    setNotifications(prev => {
      // Replace any existing notification for the same session
      const filtered = prev.filter(x => x.sessionId !== n.sessionId)
      return [...filtered, { ...n, id }]
    })
  }, [])

  const dismiss = useCallback((id: string) => {
    setNotifications(prev => prev.filter(x => x.id !== id))
  }, [])

  const dismissAll = useCallback(() => setNotifications([]), [])

  return (
    <NotificationContext.Provider value={{ notifications, push, dismiss, dismissAll }}>
      {children}
    </NotificationContext.Provider>
  )
}

export const useNotifications = () => useContext(NotificationContext)
