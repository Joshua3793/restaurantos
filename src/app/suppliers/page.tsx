'use client'
import { useState, useCallback, useEffect } from 'react'
import { SupplierList } from '@/components/suppliers/SupplierList'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierFormModal } from '@/components/suppliers/SupplierFormModal'
import { SupplierSummary } from '@/components/suppliers/types'
import Link from 'next/link'

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editSupplier, setEditSupplier] = useState<SupplierSummary | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fetchSuppliers = useCallback(() => {
    fetch('/api/suppliers').then(r => r.json()).then((data: SupplierSummary[]) => {
      setSuppliers(data)
      // Auto-select first supplier if none selected
      setSelectedId(prev => prev ?? (data[0]?.id ?? null))
    })
  }, [])

  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])

  const selectedSupplier = suppliers.find(s => s.id === selectedId) ?? null

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    setSelectedId(prev => (prev === id ? null : prev))
    fetchSuppliers()
  }

  return (
    <>
      {/* Desktop: split panel */}
      <div className="hidden sm:flex h-[calc(100vh-64px)] overflow-hidden">
        <SupplierList
          suppliers={suppliers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAdd={() => setShowAdd(true)}
        />
        {selectedId ? (
          <SupplierDetail
            key={selectedId}
            supplierId={selectedId}
            supplier={selectedSupplier}
            onEdit={setEditSupplier}
            onDelete={handleDelete}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
            Select a supplier to view details
          </div>
        )}
      </div>

      {/* Mobile: full-width list only (detail navigates to /suppliers/[id]) */}
      <div className="sm:hidden flex flex-col h-[calc(100vh-64px)]">
        <div className="px-4 pt-3 pb-2 shrink-0 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Suppliers</h1>
          <button
            onClick={() => setShowAdd(true)}
            className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm font-semibold hover:bg-blue-700"
          >
            + Add
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {suppliers
            .sort((a, b) => b.monthSpend - a.monthSpend)
            .map(s => {
              const pct = s.prevMonthSpend === 0 ? null
                : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
              const pctColor = pct === null ? 'text-gray-400'
                : pct >= 15 ? 'text-red-500' : pct > 0 ? 'text-green-600' : 'text-gray-500'
              return (
                <Link
                  key={s.id}
                  href={`/suppliers/${s.id}`}
                  className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-white hover:bg-gray-50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name}</p>
                    <p className={`text-xs mt-0.5 ${pctColor}`}>
                      {s.monthSpend === 0 ? '$0 this month'
                        : `$${s.monthSpend.toLocaleString()} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`}
                    </p>
                    <p className="text-xs text-gray-400">{s._count.inventory} items · {s.invoiceCount} invoices</p>
                  </div>
                  <span className="text-gray-300 text-lg">›</span>
                </Link>
              )
            })}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <SupplierFormModal supplier={null} onClose={() => setShowAdd(false)} onSaved={fetchSuppliers} />
      )}

      {/* Edit modal */}
      {editSupplier && (
        <SupplierFormModal supplier={editSupplier} onClose={() => setEditSupplier(null)} onSaved={fetchSuppliers} />
      )}
    </>
  )
}
