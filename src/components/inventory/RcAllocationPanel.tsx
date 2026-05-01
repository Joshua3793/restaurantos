'use client'
import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, ChevronDown, ChevronUp } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface Allocation {
  revenueCenterId: string
  quantity: number
  revenueCenter: { id: string; name: string; color: string }
}

interface Transfer {
  id: string
  fromRc: { name: string; color: string }
  toRc: { name: string; color: string }
  quantity: number
  notes: string | null
  createdAt: string
}

interface Props {
  itemId: string
  stockOnHand: number
  countUOM: string
  defaultRcId: string | null
  onPulled: () => void
}

export function RcAllocationPanel({ itemId, stockOnHand, countUOM, defaultRcId, onPulled }: Props) {
  const { revenueCenters } = useRc()
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [transfers, setTransfers]     = useState<Transfer[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [pullRcId, setPullRcId]       = useState<string | null>(null)
  const [pullQty, setPullQty]         = useState('')
  const [pullNotes, setPullNotes]     = useState('')
  const [pulling, setPulling]         = useState(false)
  const [pullError, setPullError]     = useState('')

  const loadData = useCallback(async () => {
    const [allocsRes, transferRes] = await Promise.all([
      fetch(`/api/stock-allocations?itemId=${itemId}`).then(r => r.json()),
      fetch(`/api/stock-transfers?itemId=${itemId}`).then(r => r.json()),
    ])
    setAllocations(allocsRes)
    setTransfers(transferRes)
  }, [itemId])

  useEffect(() => { loadData() }, [loadData])

  const handlePull = async (rcId: string) => {
    if (!pullQty) return
    setPulling(true)
    setPullError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: itemId,
        rcId,
        quantity: parseFloat(pullQty),
        notes: pullNotes || null,
      }),
    })
    setPulling(false)
    if (!res.ok) {
      const d = await res.json()
      setPullError(d.error || 'Pull failed')
      return
    }
    setPullRcId(null)
    setPullQty('')
    setPullNotes('')
    setPullError('')
    loadData()
    onPulled()
  }

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock by Revenue Center</p>
      </div>

      <div className="divide-y divide-gray-50">
        {revenueCenters.map(rc => {
          const isDefaultRc = rc.id === defaultRcId
          const alloc = allocations.find(a => a.revenueCenterId === rc.id)
          const qty = isDefaultRc
            ? stockOnHand
            : alloc ? Number(alloc.quantity) : 0
          const isPulling = pullRcId === rc.id

          return (
            <div key={rc.id} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isDefaultRc ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                  {rc.name}
                  {isDefaultRc && <span className="text-xs text-gray-400 font-normal ml-1">main pool</span>}
                </span>
                <span className="text-sm font-medium text-gray-700">
                  {qty.toFixed(2)} <span className="text-xs text-gray-400">{countUOM}</span>
                </span>
                {!isDefaultRc && (
                  <button
                    onClick={() => {
                      setPullRcId(isPulling ? null : rc.id)
                      setPullQty('')
                      setPullNotes('')
                      setPullError('')
                    }}
                    className={`text-xs font-medium flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                      isPulling
                        ? 'bg-gold/15 text-gold border border-gold/30'
                        : 'bg-gold/10 text-gold hover:bg-gold/15 border border-blue-100'
                    }`}
                  >
                    Pull <ArrowRight size={11} />
                  </button>
                )}
              </div>

              {isPulling && (
                <div className="mt-3 pl-4 space-y-2">
                  <div className="text-xs text-gray-500">
                    Available: <span className="font-medium text-gray-700">{stockOnHand.toFixed(2)} {countUOM}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={pullQty}
                      onChange={e => setPullQty(e.target.value)}
                      placeholder="Quantity"
                      className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                    <div className="flex items-center justify-center px-2.5 bg-gray-100 rounded-lg text-sm text-gray-600 font-medium shrink-0">
                      {countUOM}
                    </div>
                    <button
                      onClick={() => handlePull(rc.id)}
                      disabled={pulling || !pullQty}
                      className="px-3 py-1.5 bg-gold text-white rounded-lg text-sm font-medium hover:bg-[#a88930] disabled:opacity-50"
                    >
                      {pulling ? '…' : 'Pull'}
                    </button>
                  </div>
                  <input
                    value={pullNotes}
                    onChange={e => setPullNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                  />
                  {pullError && <p className="text-xs text-red-500">{pullError}</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {transfers.length > 0 && (
        <div className="border-t border-gray-100">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center gap-1 px-4 py-2 text-xs text-gray-400 hover:text-gray-600"
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Transfer history ({transfers.length})
          </button>
          {showHistory && (
            <div className="px-4 pb-3 space-y-1">
              {transfers.slice(0, 10).map(t => (
                <div key={t.id} className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span style={{ color: rcHex(t.fromRc.color) }}>●</span>
                  {t.fromRc.name}
                  <ArrowRight size={10} />
                  <span style={{ color: rcHex(t.toRc.color) }}>●</span>
                  {t.toRc.name}
                  <span className="ml-auto font-medium">{Number(t.quantity).toFixed(2)} {countUOM}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
