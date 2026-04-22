'use client'
import { useState } from 'react'
import { SupplierSummary } from './types'
import { formatCurrency } from '@/lib/utils'

interface Props {
  suppliers: SupplierSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
}

export function SupplierList({ suppliers, selectedId, onSelect, onAdd }: Props) {
  const [search, setSearch] = useState('')

  const filtered = suppliers.filter(s => {
    const q = search.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.aliases?.some(a => a.name.toLowerCase().includes(q))
    )
  })

  // Sort by monthSpend descending
  const sorted = [...filtered].sort((a, b) => b.monthSpend - a.monthSpend)

  const spendLabel = (s: SupplierSummary) => {
    if (s.monthSpend === 0) return '$0 this month'
    const pct = s.prevMonthSpend === 0
      ? null
      : Math.round(((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100)
    return `${formatCurrency(s.monthSpend)} this month${pct !== null ? ` · ${pct >= 0 ? '↑' : '↓'}${Math.abs(pct)}%` : ''}`
  }

  const spendColor = (s: SupplierSummary) => {
    if (s.monthSpend === 0) return 'text-gray-400'
    if (s.prevMonthSpend === 0) return 'text-gray-500'
    const pct = ((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100
    if (pct >= 15) return 'text-red-500'
    if (pct > 0) return 'text-green-600'
    return 'text-gray-500'
  }

  return (
    <div className="flex flex-col w-full sm:w-[280px] shrink-0 bg-gray-50 border-r border-gray-200 h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          className="flex-1 bg-white border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={onAdd}
          className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-blue-700 shrink-0 transition-colors"
        >
          + Add
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <div className="py-12 text-center text-sm text-gray-400">No suppliers found</div>
        )}
        {sorted.map(s => {
          const selected = s.id === selectedId
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left flex border-b border-gray-100 transition-colors overflow-hidden ${
                selected ? 'bg-blue-50' : 'bg-white hover:bg-gray-50'
              }`}
            >
              <div className={`w-1 shrink-0 ${selected ? 'bg-blue-500' : 'bg-transparent'}`} />
              <div className="flex-1 min-w-0 px-3 py-3">
                <p className={`text-sm font-semibold truncate ${selected ? 'text-blue-700' : 'text-gray-900'}`}>
                  {s.name}
                </p>
                {s.aliases && s.aliases.length > 0 && (
                  <p className="text-xs text-gray-400 truncate mt-0.5 font-mono">
                    {s.aliases[0].name}
                  </p>
                )}
                <p className={`text-xs mt-0.5 font-medium ${spendColor(s)}`}>
                  {spendLabel(s)}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {s._count.inventory} item{s._count.inventory !== 1 ? 's' : ''} · {s.invoiceCount} invoice{s.invoiceCount !== 1 ? 's' : ''}
                </p>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
