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
        <h2 className="text-xl font-bold text-gray-900">Storage Areas</h2>
        <p className="text-sm text-gray-500 mt-0.5">Define where inventory items are physically stored</p>
      </div>

      {/* Add form */}
      <form onSubmit={handleAdd} className="flex gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="New storage area name..."
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button type="submit" className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700">
          <Plus size={15} /> Add
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm divide-y divide-gray-50">
        {areas.length === 0 && <div className="text-center py-12 text-gray-400">No storage areas yet</div>}
        {areas.map(area => (
          <div key={area.id} className="flex items-center gap-3 px-4 py-3">
            <MapPin size={16} className="text-gray-400 shrink-0" />
            {editId === area.id ? (
              <>
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleEdit(area.id); if (e.key === 'Escape') setEditId(null) }}
                  className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none"
                />
                <button onClick={() => handleEdit(area.id)} className="text-green-600 hover:text-green-700"><Check size={16} /></button>
                <button onClick={() => setEditId(null)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </>
            ) : (
              <>
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-800">{area.name}</div>
                  <div className="text-xs text-gray-400">{area._count?.items ?? 0} items</div>
                </div>
                <button onClick={() => { setEditId(area.id); setEditName(area.name) }} className="text-gray-400 hover:text-blue-600 p-1"><Pencil size={14} /></button>
                <button onClick={() => handleDelete(area.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={14} /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
