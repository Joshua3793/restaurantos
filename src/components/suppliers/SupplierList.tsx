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
    if (s.monthSpend === 0) return 'text-ink-4'
    if (s.prevMonthSpend === 0) return 'text-ink-3'
    const pct = ((s.monthSpend - s.prevMonthSpend) / s.prevMonthSpend) * 100
    if (pct >= 15) return 'text-red'
    if (pct > 0) return 'text-green'
    return 'text-ink-3'
  }

  return (
    <div className="flex flex-col w-full sm:w-[280px] shrink-0 bg-bg border-r border-line h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line shrink-0">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search suppliers…"
          className="flex-1 bg-white border border-line rounded-lg px-3 py-1.5 text-xs text-ink-2 placeholder-ink-4 focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <button
          onClick={onAdd}
          className="bg-ink text-paper [&_svg]:text-gold rounded-lg px-3 py-1.5 text-xs font-semibold hover:bg-ink-2 shrink-0 transition-colors"
        >
          + Add
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 && (
          <div className="py-12 text-center text-sm text-ink-4">No suppliers found</div>
        )}
        {sorted.map(s => {
          const selected = s.id === selectedId
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left flex border-b border-line transition-colors overflow-hidden ${
                selected ? 'bg-gold/10' : 'bg-white hover:bg-bg'
              }`}
            >
              <div className={`w-1 shrink-0 ${selected ? 'bg-gold/100' : 'bg-transparent'}`} />
              <div className="flex-1 min-w-0 px-3 py-3">
                <p className={`text-sm font-semibold truncate ${selected ? 'text-gold' : 'text-ink'}`}>
                  {s.name}
                </p>
                {s.aliases && s.aliases.length > 0 && (
                  <p className="text-xs text-ink-4 truncate mt-0.5 font-mono">
                    {s.aliases[0].name}
                  </p>
                )}
                <p className={`text-xs mt-0.5 font-medium ${spendColor(s)}`}>
                  {spendLabel(s)}
                </p>
                <p className="text-xs text-ink-4 mt-0.5">
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
