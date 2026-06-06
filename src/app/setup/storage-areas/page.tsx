'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Check, X, MapPin } from 'lucide-react'

interface StorageArea {
  id: string
  name: string
  _count?: { items: number }
}

export default function StorageAreasPage() {
  const [areas, setAreas] = useState<StorageArea[]>([])
  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const fetchAreas = () => fetch('/api/storage-areas').then(r => r.json()).then(setAreas)
  useEffect(() => { fetchAreas() }, [])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    await fetch('/api/storage-areas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) })
    setNewName('')
    fetchAreas()
  }

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return
    await fetch(`/api/storage-areas/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: editName.trim() }) })
    setEditId(null)
    fetchAreas()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this storage area? Items will be unlinked.')) return
    await fetch(`/api/storage-areas/${id}`, { method: 'DELETE' })
    fetchAreas()
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-xl font-bold text-ink">Storage Areas</h2>
        <p className="text-sm text-ink-3 mt-0.5">Define where inventory items are physically stored</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New storage area name..."
          className="flex-1 border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <button type="submit" className="flex items-center gap-2 bg-ink text-paper [&_svg]:text-gold px-3 py-2 rounded-lg text-sm hover:bg-ink-2">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-line shadow-sm divide-y divide-line">
        {areas.length === 0 && <div className="text-center py-12 text-ink-4">No storage areas yet</div>}
        {areas.map(area => (
          <div key={area.id} className="flex items-center gap-3 px-4 py-3">
            <MapPin size={16} className="text-ink-4 shrink-0" />
            {editId === area.id ? (
              <>
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleEdit(area.id); if (e.key === 'Escape') setEditId(null) }}
                  className="flex-1 border border-blue rounded px-2 py-1 text-sm focus:outline-none"
                />
                <button onClick={() => handleEdit(area.id)} className="text-green hover:text-green-text"><Check size={16} /></button>
                <button onClick={() => setEditId(null)} className="text-ink-4 hover:text-ink-3"><X size={16} /></button>
              </>
            ) : (
              <>
                <div className="flex-1">
                  <div className="text-sm font-medium text-ink-2">{area.name}</div>
                  <div className="text-xs text-ink-4">{area._count?.items ?? 0} items</div>
                </div>
                <button onClick={() => { setEditId(area.id); setEditName(area.name) }} className="text-ink-4 hover:text-gold p-1"><Pencil size={14} /></button>
                <button onClick={() => handleDelete(area.id)} className="text-ink-4 hover:text-red p-1"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
