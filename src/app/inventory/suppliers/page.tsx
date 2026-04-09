'use client'
import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, X, Truck } from 'lucide-react'

interface Supplier {
  id: string; name: string; contactName?: string | null
  phone?: string | null; email?: string | null
  orderPlatform?: string | null; cutoffDays?: string | null
  deliveryDays?: string | null; _count?: { inventory: number }
}

const emptyForm = { name: '', contactName: '', phone: '', email: '', orderPlatform: '', cutoffDays: '', deliveryDays: '' }

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null)
  const [form, setForm] = useState(emptyForm)

  const fetchSuppliers = () => fetch('/api/suppliers').then(r => r.json()).then(setSuppliers)
  useEffect(() => { fetchSuppliers() }, [])

  const openAdd = () => { setForm(emptyForm); setEditSupplier(null); setShowForm(true) }
  const openEdit = (s: Supplier) => {
    setForm({ name: s.name, contactName: s.contactName || '', phone: s.phone || '', email: s.email || '', orderPlatform: s.orderPlatform || '', cutoffDays: s.cutoffDays || '', deliveryDays: s.deliveryDays || '' })
    setEditSupplier(s)
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (editSupplier) {
      await fetch(`/api/suppliers/${editSupplier.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    } else {
      await fetch('/api/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    }
    setShowForm(false)
    fetchSuppliers()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    fetchSuppliers()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Suppliers</h2>
          <p className="text-sm text-gray-500 mt-0.5">Manage your supplier contacts and ordering information</p>
        </div>
        <button onClick={openAdd} className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700">
          <Plus size={15} /> Add Supplier
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {suppliers.map(s => (
          <div key={s.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Truck size={15} className="text-blue-600" />
                </div>
                <div>
                  <div className="font-semibold text-gray-900 text-sm">{s.name}</div>
                  <div className="text-xs text-gray-400">{s._count?.inventory ?? 0} items</div>
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => openEdit(s)} className="text-gray-400 hover:text-blue-600 p-1"><Pencil size={14} /></button>
                <button onClick={() => handleDelete(s.id)} className="text-gray-400 hover:text-red-500 p-1"><Trash2 size={14} /></button>
              </div>
            </div>
            <div className="space-y-1 text-xs text-gray-600">
              {s.contactName && <div><span className="text-gray-400">Contact:</span> {s.contactName}</div>}
              {s.phone && <div><span className="text-gray-400">Phone:</span> {s.phone}</div>}
              {s.email && <div><span className="text-gray-400">Email:</span> {s.email}</div>}
              {s.orderPlatform && <div><span className="text-gray-400">Order via:</span> {s.orderPlatform}</div>}
              {s.cutoffDays && <div><span className="text-gray-400">Cutoff:</span> {s.cutoffDays}</div>}
              {s.deliveryDays && <div><span className="text-gray-400">Delivery:</span> {s.deliveryDays}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative bg-white rounded-xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-lg">{editSupplier ? 'Edit Supplier' : 'Add Supplier'}</h3>
              <button onClick={() => setShowForm(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
              {([
                { key: 'name', label: 'Company Name *', required: true, placeholder: '' },
                { key: 'contactName', label: 'Contact Name', required: false, placeholder: '' },
                { key: 'phone', label: 'Phone', required: false, placeholder: '' },
                { key: 'email', label: 'Email', required: false, placeholder: '' },
                { key: 'orderPlatform', label: 'Order Platform', required: false, placeholder: 'e.g. Online Portal, Phone, Email' },
                { key: 'cutoffDays', label: 'Cutoff Days', required: false, placeholder: 'e.g. Monday, Wednesday' },
                { key: 'deliveryDays', label: 'Delivery Days', required: false, placeholder: 'e.g. Tuesday, Thursday' },
              ] as { key: keyof typeof emptyForm; label: string; required: boolean; placeholder: string }[]).map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{f.label}</label>
                  <input
                    required={f.required}
                    value={form[f.key]}
                    onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm hover:bg-blue-700">{editSupplier ? 'Save Changes' : 'Add Supplier'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
