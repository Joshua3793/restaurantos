'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { rcHex } from '@/lib/rc-colors'

interface RC {
  id: string
  name: string
  color: string
  isDefault: boolean
}

interface ItemMin {
  id: string
  itemName: string
  stockOnHand: number
  countUOM: string
  baseUnit: string
}

interface Props {
  item: ItemMin
  revenueCenters: RC[]
  activeRcId: string | null
  onClose: () => void
  onSuccess: () => void
}

export function PullModal({ item, revenueCenters, activeRcId, onClose, onSuccess }: Props) {
  const nonDefaultRcs = revenueCenters.filter(rc => !rc.isDefault)

  const initialRcId = (() => {
    if (activeRcId && !revenueCenters.find(rc => rc.id === activeRcId)?.isDefault) return activeRcId
    return nonDefaultRcs[0]?.id ?? ''
  })()

  const [rcId, setRcId]     = useState(initialRcId)
  const [qty, setQty]       = useState('')
  const [notes, setNotes]   = useState('')
  const [pulling, setPulling] = useState(false)
  const [error, setError]   = useState('')

  const available = parseFloat(String(item.stockOnHand))
  const countUOM  = item.countUOM || item.baseUnit
  const targetRc  = revenueCenters.find(rc => rc.id === rcId)

  const handlePull = async () => {
    if (!rcId || !qty) return
    const qtyNum = parseFloat(qty)
    if (isNaN(qtyNum) || qtyNum <= 0) { setError('Enter a valid quantity'); return }
    if (qtyNum > available) { setError(`Only ${available.toFixed(2)} ${countUOM} available`); return }

    setPulling(true)
    setError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: item.id, rcId, quantity: qtyNum, notes: notes || null }),
    })
    setPulling(false)
    if (!res.ok) {
      const d = await res.json()
      setError(d.error || 'Pull failed')
      return
    }
    onSuccess()
  }

  if (nonDefaultRcs.length === 0) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 sm:mx-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Pull Stock</h3>
            <p className="text-sm text-gray-500 mt-0.5">{item.itemName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100">
            <X size={18} className="text-gray-400" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Available stock */}
          <div className="bg-gray-50 rounded-xl px-3 py-2.5 flex items-center justify-between">
            <span className="text-xs text-gray-500">Available (main pool)</span>
            <span className="font-semibold text-gray-900">
              {available.toFixed(2)} <span className="text-xs font-normal text-gray-400">{countUOM}</span>
            </span>
          </div>

          {/* Target RC selector (only if multiple) */}
          {nonDefaultRcs.length > 1 ? (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Pull to</label>
              <div className="space-y-1">
                {nonDefaultRcs.map(rc => (
                  <button
                    key={rc.id}
                    onClick={() => setRcId(rc.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm transition-colors ${
                      rcId === rc.id
                        ? 'border-blue-300 bg-blue-50 text-blue-800 font-medium'
                        : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                    {rc.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <span>Pulling to:</span>
              <span className="flex items-center gap-1.5 font-medium text-gray-900">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(nonDefaultRcs[0].color) }} />
                {nonDefaultRcs[0].name}
              </span>
            </div>
          )}

          {/* Qty + UOM */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Quantity</label>
            <div className="flex gap-2">
              <input
                type="number"
                min="0"
                step="any"
                value={qty}
                onChange={e => setQty(e.target.value)}
                placeholder="0"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handlePull()}
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex items-center justify-center px-3 bg-gray-100 rounded-xl text-sm font-medium text-gray-600 shrink-0 min-w-[3rem]">
                {countUOM}
              </div>
            </div>
          </div>

          {/* Notes */}
          <input
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none"
          />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            onClick={handlePull}
            disabled={pulling || !qty || !rcId || available <= 0}
            className="w-full py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {pulling ? 'Pulling…' : `Pull to ${targetRc?.name ?? '…'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
