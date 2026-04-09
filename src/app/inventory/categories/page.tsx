'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, Tag } from 'lucide-react'
import { CATEGORY_COLORS } from '@/lib/utils'

interface Category {
  id: string
  name: string
}

interface CategoryStat extends Category {
  count: number
  totalValue: number
}

export default function CategoriesPage() {
  const [cats, setCats] = useState<CategoryStat[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState('')

  const fetchCats = async () => {
    const [catsRes, itemsRes] = await Promise.all([
      fetch('/api/categories').then(r => r.json()),
      fetch('/api/inventory').then(r => r.json()),
    ])
    const items: any[] = Array.isArray(itemsRes) ? itemsRes : []
    const statsMap = new Map<string, { count: number; totalValue: number }>()
    for (const item of items) {
      const prev = statsMap.get(item.category) ?? { count: 0, totalValue: 0 }
      statsMap.set(item.category, {
        count: prev.count + 1,
        totalValue: prev.totalValue + parseFloat(item.stockOnHand) * parseFloat(item.conversionFactor ?? 1) * parseFloat(item.pricePerBaseUnit),
      })
    }
    setCats(catsRes.map((c: Category) => ({
      ...c,
      ...(statsMap.get(c.name) ?? { count: 0, totalValue: 0 }),
    })))
  }

  useEffect(() => { fetchCats() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newName.trim()) return
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (!res.ok) {
      const data = await res.json()
      setError(data.error || 'Failed to add')
      return
    }
    setNewName('')
    fetchCats()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    })
    setEditId(null)
    fetchCats()
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete category "${name}"? Items using it will keep their current category string but it won't appear in this list.`)) return
    await fetch(`/api/categories/${id}`, { method: 'DELETE' })
    fetchCats()
  }

  const totalValue = cats.reduce((s, c) => s + c.totalValue, 0)

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Categories</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage inventory categories — these are assigned to items in your inventory</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <div className="flex-1">
          <input
            value={newName}
            onChange={e => { setNewName(e.target.value); setError('') }}
            placeholder="New category name (e.g. BAKERY)..."
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
        <button type="submit" className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 whitespace-nowrap">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {cats.length === 0 && <div className="text-center py-12 text-gray-400">No categories yet</div>}
        {cats.map(cat => {
          const pct = totalValue > 0 ? (cat.totalValue / totalValue) * 100 : 0
          const colors = CATEGORY_COLORS[cat.name] || 'bg-gray-100 text-gray-700'
          return (
            <div key={cat.id} className="px-4 py-3 flex items-center gap-3">
              <Tag size={14} className="text-gray-300 shrink-0" />

              {editId === cat.id ? (
                <>
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleEdit(cat.id); if (e.key === 'Escape') setEditId(null) }}
                    className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                  />
                  <button onClick={() => handleEdit(cat.id)} className="text-green-600 hover:text-green-700 p-1"><Check size={15} /></button>
                  <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={15} /></button>
                </>
              ) : (
                <>
                  <span className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold w-16 justify-center shrink-0 ${colors}`}>
                    {cat.name}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500">{cat.count} item{cat.count !== 1 ? 's' : ''}</span>
                      <span className="text-xs font-semibold text-gray-700">${cat.totalValue.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="text-xs text-gray-400 w-9 text-right shrink-0">{pct.toFixed(1)}%</span>
                  <button onClick={() => { setEditId(cat.id); setEditName(cat.name) }} className="text-gray-400 hover:text-blue-600 p-1"><Pencil size={13} /></button>
                  <button onClick={() => handleDelete(cat.id, cat.name)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
