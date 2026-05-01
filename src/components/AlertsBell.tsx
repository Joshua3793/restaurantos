'use client'
import { useEffect, useState, useRef } from 'react'
import { Bell, TrendingUp, TrendingDown, ChevronRight, X, Check, FileText, CheckCircle2 } from 'lucide-react'
import Link from 'next/link'
import { formatCurrency } from '@/lib/utils'
import { useNotifications } from '@/contexts/NotificationContext'

interface PriceAlert {
  id: string
  previousPrice: number
  newPrice: number
  changePct: number
  direction: string
  acknowledged: boolean
  inventoryItem: { id: string; itemName: string }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface RecipeAlert {
  id: string
  previousCost: number
  newCost: number
  changePct: number
  newFoodCostPct: number | null
  exceededThreshold: boolean
  acknowledged: boolean
  recipe: { id: string; name: string; menuPrice: number | null }
  session: { id: string; supplierName: string | null; invoiceDate: string | null }
}

interface AlertsBellProps {
  dropdownAlign?: 'left' | 'right'
}

export function AlertsBell({ dropdownAlign = 'left' }: AlertsBellProps) {
  const [open, setOpen] = useState(false)
  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>([])
  const [recipeAlerts, setRecipeAlerts] = useState<RecipeAlert[]>([])
  const [totalUnread, setTotalUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { notifications, dismiss, dismissAll } = useNotifications()

  const fetchAlerts = async () => {
    try {
      const data = await fetch('/api/invoices/alerts').then(r => r.json())
      setPriceAlerts(data.priceAlerts || [])
      setRecipeAlerts(data.recipeAlerts || [])
      setTotalUnread(data.totalUnread || 0)
    } catch {}
  }

  useEffect(() => {
    fetchAlerts()
    const interval = setInterval(fetchAlerts, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const acknowledgeAll = async () => {
    await fetch('/api/invoices/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acknowledgeAll: true }),
    })
    dismissAll()
    fetchAlerts()
  }

  const badgeCount = totalUnread + notifications.length

  const dropdownPos = dropdownAlign === 'right' ? 'right-0' : 'left-0'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <Bell size={18} />
        {badgeCount > 0 && (
          <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center leading-none">
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute ${dropdownPos} top-full mt-2 w-[min(320px,calc(100vw-16px))] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden`}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50">
            <span className="font-semibold text-gray-900 text-sm">Notifications</span>
            <div className="flex items-center gap-2">
              {(badgeCount > 0) && (
                <button
                  onClick={acknowledgeAll}
                  className="text-xs text-gold hover:underline flex items-center gap-1"
                >
                  <Check size={10} /> Mark all read
                </button>
              )}
              <button onClick={() => setOpen(false)}>
                <X size={14} className="text-gray-400" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && priceAlerts.length === 0 && recipeAlerts.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                No notifications
              </div>
            ) : (
              <>
                {/* Soft / transient notifications */}
                {notifications.map(n => (
                  <div key={n.id} className="px-4 py-3 border-b border-gray-50 bg-gold/10/40 hover:bg-gold/10 transition-colors">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${n.type === 'invoice_ready' ? 'bg-gold/15' : 'bg-green-100'}`}>
                        {n.type === 'invoice_ready'
                          ? <FileText size={12} className="text-blue-500" />
                          : <CheckCircle2 size={12} className="text-green-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800">
                          {n.type === 'invoice_ready' ? 'Invoice Ready' : 'Invoice Applied'}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {n.supplierName ?? 'Unknown supplier'}
                          {n.invoiceNumber ? ` · #${n.invoiceNumber}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { n.onAction(); dismiss(n.id); setOpen(false) }}
                          className="text-xs font-medium text-gold hover:underline px-1.5 py-0.5"
                        >
                          {n.actionLabel}
                        </button>
                        <button onClick={() => dismiss(n.id)}>
                          <X size={12} className="text-gray-300 hover:text-gray-500" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* DB price alerts */}
                {priceAlerts.map(alert => (
                  <div key={alert.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${alert.direction === 'UP' ? 'bg-red-100' : 'bg-green-100'}`}>
                        {alert.direction === 'UP'
                          ? <TrendingUp size={12} className="text-red-500" />
                          : <TrendingDown size={12} className="text-green-500" />
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{alert.inventoryItem.itemName}</p>
                        <p className="text-xs text-gray-500">
                          {formatCurrency(Number(alert.previousPrice))} → {formatCurrency(Number(alert.newPrice))}
                          {' '}<span className={`font-semibold ${alert.direction === 'UP' ? 'text-red-600' : 'text-green-600'}`}>
                            ({alert.direction === 'UP' ? '+' : ''}{Number(alert.changePct).toFixed(1)}%)
                          </span>
                        </p>
                        {alert.session.supplierName && (
                          <p className="text-[10px] text-gray-400">{alert.session.supplierName}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* DB recipe alerts */}
                {recipeAlerts.map(alert => (
                  <div key={alert.id} className="px-4 py-3 border-b border-gray-50 hover:bg-gray-50">
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 p-1 rounded-full ${alert.exceededThreshold ? 'bg-red-100' : 'bg-amber-100'}`}>
                        <TrendingUp size={12} className={alert.exceededThreshold ? 'text-red-500' : 'text-amber-500'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{alert.recipe.name}</p>
                        {alert.exceededThreshold && alert.newFoodCostPct !== null && (
                          <p className="text-xs text-red-600 font-semibold">
                            Food cost {(Number(alert.newFoodCostPct) * 100).toFixed(1)}% — exceeds 30% threshold
                          </p>
                        )}
                        <p className="text-xs text-gray-500">Recipe cost changed</p>
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Footer */}
          <Link
            href="/invoices"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1 px-4 py-2.5 text-xs text-gold hover:bg-gold/10 transition-colors border-t border-gray-50"
          >
            View all invoices <ChevronRight size={12} />
          </Link>
        </div>
      )}
    </div>
  )
}
