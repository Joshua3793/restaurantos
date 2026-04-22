// src/components/suppliers/SupplierDetail.tsx
'use client'
import { useEffect, useState, useCallback } from 'react'
import { Pencil, Trash2, Loader2 } from 'lucide-react'
import { SupplierSummary, SupplierIntelligence } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  supplierId: string
  onEdit: (supplier: SupplierSummary) => void
  onDelete: (id: string) => void
  // supplier contact info from the already-loaded list (avoids extra fetch on desktop)
  supplier: SupplierSummary | null
}

function changePctColor(pct: number): string {
  return pct > 0 ? 'text-red-500' : pct < 0 ? 'text-green-600' : 'text-gray-400'
}

export function SupplierDetail({ supplierId, onEdit, onDelete, supplier }: Props) {
  const [intel, setIntel] = useState<SupplierIntelligence | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchIntel = useCallback(async () => {
    setLoading(true)
    const data = await fetch(`/api/suppliers/${supplierId}/intelligence`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
    setIntel(data)
    setLoading(false)
  }, [supplierId])

  useEffect(() => { fetchIntel() }, [fetchIntel])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Dark header */}
      <div className="bg-slate-800 text-white px-5 py-4 shrink-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold truncate">{supplier?.name ?? '—'}</h2>
          <div className="text-xs text-slate-400 mt-0.5 space-y-0.5">
            {(supplier?.contactName || supplier?.phone || supplier?.email) && (
              <p className="truncate">
                {[supplier?.contactName, supplier?.phone, supplier?.email].filter(Boolean).join(' · ')}
              </p>
            )}
            {(supplier?.orderPlatform || supplier?.cutoffDays || supplier?.deliveryDays) && (
              <p className="truncate">
                {[
                  supplier?.orderPlatform && `Order via: ${supplier.orderPlatform}`,
                  supplier?.cutoffDays && `Cutoff: ${supplier.cutoffDays}`,
                  supplier?.deliveryDays && `Delivery: ${supplier.deliveryDays}`,
                ].filter(Boolean).join(' · ')}
              </p>
            )}
            {supplier?.aliases && supplier.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {supplier.aliases.map(a => (
                  <span
                    key={a.id}
                    className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono text-[10px]"
                  >
                    {a.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {supplier && (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onEdit(supplier)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Pencil size={12} /> Edit
            </button>
            <button
              onClick={() => onDelete(supplier.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 hover:bg-red-500/30 text-red-300 transition-colors"
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-gray-300" />
        </div>
      ) : !intel ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
          Failed to load intelligence data
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="flex gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 shrink-0">
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Month</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.monthSpend)}</p>
              <p className={`text-[10px] font-medium ${changePctColor(intel.monthSpendChangePct)}`}>
                {intel.monthSpendChangePct === 0 ? '— vs last month'
                  : `${intel.monthSpendChangePct > 0 ? '↑' : '↓'} ${Math.abs(intel.monthSpendChangePct)}% vs last month`}
              </p>
            </div>
            <div className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
              <p className="text-[10px] text-gray-400 uppercase tracking-wide">This Year</p>
              <p className="text-lg font-bold text-gray-900 leading-tight">{formatCurrency(intel.yearSpend)}</p>
              <p className="text-[10px] text-gray-400">{intel.yearInvoiceCount} invoice{intel.yearInvoiceCount !== 1 ? 's' : ''} approved</p>
            </div>
            <div className={`flex-1 rounded-lg px-3 py-2.5 border ${intel.priceChanges.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-gray-200'}`}>
              <p className={`text-[10px] uppercase tracking-wide ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                Price Changes
              </p>
              <p className={`text-lg font-bold leading-tight ${intel.priceChanges.length > 0 ? 'text-amber-700' : 'text-gray-900'}`}>
                {intel.priceChanges.length} item{intel.priceChanges.length !== 1 ? 's' : ''}
              </p>
              <p className={`text-[10px] ${intel.priceChanges.length > 0 ? 'text-amber-600' : 'text-gray-400'}`}>last 90 days</p>
            </div>
          </div>

          {/* Body: two-column grid */}
          <div className="flex-1 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-100">

            {/* Price Changes */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Price Changes</h3>
              {intel.priceChanges.length === 0 ? (
                <p className="text-sm text-gray-400">No price changes in the last 90 days</p>
              ) : (
                <div className="space-y-2">
                  {intel.priceChanges.map((pc) => (
                    <div key={`${pc.itemName}-${pc.date}`} className="bg-white border border-gray-100 rounded-lg px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-gray-900 truncate">{pc.itemName}</span>
                        <span className={`text-xs font-bold shrink-0 ${pc.pctChange > 0 ? 'text-red-500' : 'text-green-600'}`}>
                          {pc.pctChange > 0 ? '↑' : '↓'} {Math.abs(Math.round(pc.pctChange))}%
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {formatCurrency(pc.oldPrice)} → <span className="font-semibold text-gray-700">{formatCurrency(pc.newPrice)}</span>
                        {' · '}{pc.date}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Items Supplied */}
            <div className="px-4 py-4">
              <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">
                Items Supplied ({intel.items.length})
              </h3>
              {intel.items.length === 0 ? (
                <p className="text-sm text-gray-400">No inventory items linked to this supplier</p>
              ) : (
                <div className="bg-white border border-gray-100 rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Item</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Price</span>
                    <span className="text-[10px] font-semibold text-gray-400 uppercase">Unit</span>
                  </div>
                  {intel.items.map(item => (
                    <div key={item.id} className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-2 border-b border-gray-50 last:border-0 items-center">
                      <span className="text-xs text-gray-900 truncate">{item.itemName}</span>
                      <span className="text-xs font-semibold text-gray-700">{formatCurrency(item.pricePerBaseUnit)}</span>
                      <span className="text-[10px] text-gray-400">/{item.baseUnit}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
