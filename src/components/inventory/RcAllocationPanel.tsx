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
  /** Convert a baseUnit quantity to countUOM. Allocation/transfer quantities are
   *  stored in baseUnit; the default-RC stockOnHand prop is already in countUOM. */
  toDisplay:    (base: number) => number
  onPulled:     () => void
}

export function RcAllocationPanel({ itemId, stockOnHand, countUOM, defaultRcId, toDisplay, onPulled }: Props) {
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
    setAllocations(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (allocsRes as any[]).map((a: any) => ({
        ...a,
        parLevel:   a.parLevel   !== null && a.parLevel   !== undefined ? Number(a.parLevel)   : null,
        reorderQty: a.reorderQty !== null && a.reorderQty !== undefined ? Number(a.reorderQty) : null,
      }))
    )
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
    setPullRcId(null)      // close pull form
    setPullQty('')
    setPullNotes('')
    setPullError('')
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

  // How much of the on-hand stock has been distributed out of the main pool.
  const allInMain = allocations.length === 0

  return (
    <div className="border border-[#fcd34d] rounded-xl overflow-hidden shadow-[0_1px_0_var(--gold-soft)]">
      <div className="px-4 py-3 bg-gold-soft border-b border-[#fcd34d] flex items-center gap-2.5">
        <span className="w-7 h-7 shrink-0 grid place-items-center rounded-lg bg-white/70 text-gold-2">
          <ArrowRight size={14} />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gold-2 uppercase tracking-wide">Revenue centers</p>
          <p className="text-[11px] text-[#92722f] leading-tight">
            {allInMain
              ? 'All stock is in the main pool — pull some into a revenue center.'
              : `Distributed across ${allocations.length} revenue center${allocations.length === 1 ? '' : 's'}.`}
          </p>
        </div>
      </div>

      <div className="divide-y divide-line">
        {revenueCenters.map(rc => {
          const isDefaultRc  = rc.id === defaultRcId
          const alloc        = allocations.find(a => a.revenueCenterId === rc.id)
          // stockOnHand prop is already countUOM; allocation.quantity is baseUnit → convert.
          const qty          = isDefaultRc ? stockOnHand : (alloc ? toDisplay(Number(alloc.quantity)) : 0)
          const parLevel     = alloc?.parLevel ?? null
          const isBelowPar   = parLevel !== null && qty < parLevel
          const isEditingPar = editParRcId === rc.id
          const isPulling    = pullRcId === rc.id
          const suggested    = isBelowPar && parLevel !== null ? parLevel - qty : null

          return (
            <div
              key={rc.id}
              className={`px-4 py-3 border-l-2 transition-colors ${isBelowPar ? 'border-gold bg-gold-soft/40' : 'border-transparent'}`}
            >
              {/* RC header row */}
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: rcHex(rc.color) }} />
                <span className={`flex-1 text-sm ${isDefaultRc ? 'font-semibold text-ink' : 'text-ink-3'}`}>
                  {rc.name}
                  {isDefaultRc && <span className="text-xs text-ink-4 font-normal ml-1">main pool</span>}
                </span>
                <span className="text-sm font-medium text-ink-2">
                  {qty.toFixed(2)} <span className="text-xs text-ink-4">{countUOM}</span>
                  {parLevel !== null && (
                    <span className={`ml-1 text-xs ${isBelowPar ? 'text-gold' : 'text-ink-4'}`}>
                      / par {parLevel}
                    </span>
                  )}
                </span>
                {isBelowPar && (
                  <span className="text-xs font-semibold bg-gold-soft text-gold-2 rounded-full px-2 py-0.5 shrink-0">
                    ⚠ Below Par
                  </span>
                )}
                <button
                  onClick={() => isEditingPar ? setEditParRcId(null) : openParEdit(rc.id, alloc)}
                  className="text-xs text-ink-4 hover:text-ink-3 shrink-0 p-1"
                  title={isEditingPar ? 'Cancel' : 'Edit par level'}
                >
                  {isEditingPar ? <X size={12} /> : <Pencil size={12} />}
                </button>
                {!isDefaultRc && (
                  <button
                    onClick={() => {
                      setEditParRcId(null)   // close par edit form
                      setEditParLevel('')
                      setEditReorderQty('')
                      setParError('')
                      setPullRcId(isPulling ? null : rc.id)
                      setPullQty('')
                      setPullNotes('')
                      setPullError('')
                    }}
                    className={`text-xs font-medium flex items-center gap-1 px-2.5 py-1 rounded-lg transition-colors ${
                      isPulling
                        ? 'bg-gold/15 text-gold border border-gold/30'
                        : 'bg-gold/10 text-gold hover:bg-gold/15 border border-blue-soft'
                    }`}
                  >
                    Pull <ArrowRight size={11} />
                  </button>
                )}
              </div>

              {/* Below-par suggestion */}
              {isBelowPar && suggested !== null && !isEditingPar && (
                <div className="mt-1.5 ml-4 text-xs text-gold-2 bg-gold-soft border border-gold-soft rounded-lg px-2.5 py-1.5">
                  📦 Suggested order: <strong>{suggested.toFixed(2)} {countUOM}</strong> (par − current)
                </div>
              )}

              {/* Par edit form */}
              {isEditingPar && (
                <div className="mt-2 ml-4 space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-ink-3 block mb-0.5">Par Level ({countUOM})</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={editParLevel}
                        onChange={e => setEditParLevel(e.target.value)}
                        placeholder="e.g. 10"
                        className="w-full border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-ink-3 block mb-0.5">Order Qty (auto)</label>
                      <input
                        type="number"
                        min="0.01"
                        step="any"
                        value={editReorderQty}
                        onChange={e => setEditReorderQty(e.target.value)}
                        placeholder="auto"
                        className="w-full border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                      />
                    </div>
                  </div>
                  {parError && <p className="text-xs text-red">{parError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSavePar(rc.id)}
                      disabled={savingPar}
                      className="flex items-center gap-1 px-3 py-1.5 bg-ink text-paper [&_svg]:text-gold rounded-lg text-xs font-medium hover:bg-ink-2 disabled:opacity-50"
                    >
                      <Check size={11} /> {savingPar ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditParRcId(null)}
                      className="px-3 py-1.5 text-ink-3 border border-line rounded-lg text-xs hover:bg-bg"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Pull form */}
              {isPulling && (
                <div className="mt-3 pl-4 space-y-2">
                  <div className="text-xs text-ink-3">
                    Available: <span className="font-medium text-ink-2">{stockOnHand.toFixed(2)} {countUOM}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={pullQty}
                      onChange={e => setPullQty(e.target.value)}
                      placeholder="Quantity"
                      className="flex-1 border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
                    />
                    <div className="flex items-center justify-center px-2.5 bg-bg-2 rounded-lg text-sm text-ink-3 font-medium shrink-0">
                      {countUOM}
                    </div>
                    <button
                      onClick={() => handlePull(rc.id)}
                      disabled={pulling || !pullQty}
                      className="px-3 py-1.5 bg-ink text-paper [&_svg]:text-gold rounded-lg text-sm font-medium hover:bg-ink-2 disabled:opacity-50"
                    >
                      {pulling ? '…' : 'Pull'}
                    </button>
                  </div>
                  <input
                    value={pullNotes}
                    onChange={e => setPullNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-line rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                  />
                  {pullError && <p className="text-xs text-red">{pullError}</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {transfers.length > 0 && (
        <div className="border-t border-line">
          <button
            onClick={() => setShowHistory(h => !h)}
            className="w-full flex items-center gap-1 px-4 py-2 text-xs text-ink-4 hover:text-ink-3"
          >
            {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Transfer history ({transfers.length})
          </button>
          {showHistory && (
            <div className="px-4 pb-3 space-y-1">
              {transfers.slice(0, 10).map(t => (
                <div key={t.id} className="flex items-center gap-1.5 text-xs text-ink-3">
                  <span style={{ color: rcHex(t.fromRc.color) }}>●</span>
                  {t.fromRc.name}
                  <ArrowRight size={10} />
                  <span style={{ color: rcHex(t.toRc.color) }}>●</span>
                  {t.toRc.name}
                  <span className="ml-auto font-medium">{toDisplay(Number(t.quantity)).toFixed(2)} {countUOM}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
