'use client'
import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react'
import { useToast } from '@/components/Toast'

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
  const toast = useToast()
  const toastShowRef = useRef(toast.show)
  toastShowRef.current = toast.show

  const push = useCallback((n: Omit<SoftNotification, 'id'>) => {
    counterRef.current++
    const id = `notif-${counterRef.current}`
    setNotifications(prev => {
      // Replace any existing notification for the same session
      const filtered = prev.filter(x => x.sessionId !== n.sessionId)
      return [...filtered, { ...n, id }]
    })

    // Fire toast side-effect
    const supplierLabel = n.supplierName ?? 'Unknown supplier'
    const invoiceSuffix = n.invoiceNumber ? ` · #${n.invoiceNumber}` : ''
    const message = supplierLabel + invoiceSuffix

    if (n.type === 'invoice_ready') {
      toastShowRef.current({ type: 'info', title: 'Invoice ready to review', message })
    } else if (n.type === 'invoice_applied') {
      toastShowRef.current({ type: 'success', title: 'Invoice applied', message })
    }
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
