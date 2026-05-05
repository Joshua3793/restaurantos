'use client'
import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, ChevronDown, ChevronUp, Pencil, X, Check } from 'lucide-react'
import { useRc } from '@/contexts/RevenueCenterContext'
import { rcHex } from '@/lib/rc-colors'

interface Allocation {
  revenueCenterId: string
  quantity: number
  parLevel:   number | null
  reorderQty: number | null
  revenueCenter: { id: string; name: string; color: string }
}

interface Transfer {
  id: string
  fromRc: { name: string; color: string }
  toRc:   { name: string; color: string }
  quantity: number
  notes: string | null
  createdAt: string
}

interface Props {
  itemId:       string
  stockOnHand:  number
  countUOM:     string
  defaultRcId:  string | null
  onPulled:     () => void
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

  const [editParRcId,    setEditParRcId]    = useState<string | null>(null)
  const [editParLevel,   setEditParLevel]   = useState('')
  const [editReorderQty, setEditReorderQty] = useState('')
  const [savingPar,      setSavingPar]      = useState(false)
  const [parError,       setParError]       = useState('')

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

  const openParEdit = (rcId: string, alloc: Allocation | undefined) => {
    setEditParRcId(rcId)
    setEditParLevel(alloc?.parLevel != null ? String(alloc.parLevel) : '')
    setEditReorderQty(alloc?.reorderQty != null ? String(alloc.reorderQty) : '')
    setParError('')
  }

  const handleSavePar = async (rcId: string) => {
    setSavingPar(true)
    setParError('')
    const res = await fetch('/api/stock-allocations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inventoryItemId: itemId,
        rcId,
        parLevel:   editParLevel   === '' ? null : Number(editParLevel),
        reorderQty: editReorderQty === '' ? null : Number(editReorderQty),
      }),
    })
    setSavingPar(false)
    if (!res.ok) {
      const d = await res.json()
      setParError(d.error || 'Save failed')
      return
    }
    setEditParRcId(null)
    setEditParLevel('')
    setEditReorderQty('')
    setParError('')
    loadData()
  }

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Stock by Revenue Center</p>
      </div>

      <div className="divide-y divide-gray-50">
        {revenueCenters.map(rc => {
          const isDefaultRc  = rc.id === defaultRcId
          const alloc        = allocations.find(a => a.revenueCenterId === rc.id)
          const qty          = isDefaultRc ? stockOnHand : (alloc ? Number(alloc.quantity) : 0)
          const parLevel     = alloc?.parLevel ?? null
          const isBelowPar   = parLevel !== null && qty < parLevel
          const isEditingPar = editParRcId === rc.id
          const isPulling    = pullRcId === rc.id
          const suggested    = isBelowPar && parLevel !== null ? parLevel - qty : null

          return (
            <div
              key={rc.id}
              className={`px-4 py-3 border-l-2 transition-colors ${isBelowPar ? 'border-amber-400 bg-amber-50/40' : 'border-transparent'}`}
            >
              {/* RC header row */}
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isDefaultRc ? 'font-semibold text-gray-900' : 'text-gray-600'}`}>
                  {rc.name}
                  {isDefaultRc && <span className="text-xs text-gray-400 font-normal ml-1">main pool</span>}
                </span>
                <span className="text-sm font-medium text-gray-700">
                  {qty.toFixed(2)} <span className="text-xs text-gray-400">{countUOM}</span>
                  {parLevel !== null && (
                    <span className={`ml-1 text-xs ${isBelowPar ? 'text-amber-600' : 'text-gray-400'}`}>
                      / par {parLevel}
                    </span>
                  )}
                </span>
                {isBelowPar && (
                  <span className="text-xs font-semibold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5 shrink-0">
                    ⚠ Below Par
                  </span>
                )}
                <button
                  onClick={() => isEditingPar ? setEditParRcId(null) : openParEdit(rc.id, alloc)}
                  className="text-xs text-gray-400 hover:text-gray-600 shrink-0 p-1"
                  title={isEditingPar ? 'Cancel' : 'Edit par level'}
                >
                  {isEditingPar ? <X size={12} /> : <Pencil size={12} />}
                </button>
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

              {/* Below-par suggestion */}
              {isBelowPar && suggested !== null && !isEditingPar && (
                <div className="mt-1.5 ml-4 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                  📦 Suggested order: <strong>{suggested.toFixed(2)} {countUOM}</strong> (par − current)
                </div>
              )}

              {/* Par edit form */}
              {isEditingPar && (
                <div className="mt-2 ml-4 space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Par Level ({countUOM})</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editParLevel}
                        onChange={e => setEditParLevel(e.target.value)}
                        placeholder="e.g. 10"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-gray-500 block mb-0.5">Order Qty (auto)</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editReorderQty}
                        onChange={e => setEditReorderQty(e.target.value)}
                        placeholder="auto"
                        className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                  </div>
                  {parError && <p className="text-xs text-red-500">{parError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSavePar(rc.id)}
                      disabled={savingPar}
                      className="flex items-center gap-1 px-3 py-1.5 bg-gold text-white rounded-lg text-xs font-medium hover:bg-[#a88930] disabled:opacity-50"
                    >
                      <Check size={11} /> {savingPar ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditParRcId(null)}
                      className="px-3 py-1.5 text-gray-500 border border-gray-200 rounded-lg text-xs hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Pull form */}
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
