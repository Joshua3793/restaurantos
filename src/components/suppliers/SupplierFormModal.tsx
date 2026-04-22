'use client'
import { useState, useEffect } from 'react'
import { X, Plus } from 'lucide-react'
import { SupplierForm, SupplierSummary } from './types'

const emptyForm: SupplierForm = {
  name: '', contactName: '', phone: '', email: '',
  orderPlatform: '', cutoffDays: '', deliveryDays: '',
  aliases: [],
}

const fields: { key: keyof Omit<SupplierForm, 'aliases'>; label: string; required?: boolean; placeholder?: string }[] = [
  { key: 'name',          label: 'Company Name',   required: true },
  { key: 'contactName',   label: 'Contact Name' },
  { key: 'phone',         label: 'Phone' },
  { key: 'email',         label: 'Email' },
  { key: 'orderPlatform', label: 'Order Platform', placeholder: 'e.g. Online Portal, Phone, Email' },
  { key: 'cutoffDays',    label: 'Cutoff Days',    placeholder: 'e.g. Monday, Wednesday' },
  { key: 'deliveryDays',  label: 'Delivery Days',  placeholder: 'e.g. Tuesday, Thursday' },
]

interface Props {
  supplier: SupplierSummary | null  // null = add mode
  onClose: () => void
  onSaved: () => void
}

export function SupplierFormModal({ supplier, onClose, onSaved }: Props) {
  const [form, setForm] = useState<SupplierForm>(emptyForm)
  const [saving, setSaving] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  // Track which existing alias IDs to delete (edit mode)
  const [aliasesToDelete, setAliasesToDelete] = useState<string[]>([])

  useEffect(() => {
    if (supplier) {
      setForm({
        name: supplier.name,
        contactName: supplier.contactName ?? '',
        phone: supplier.phone ?? '',
        email: supplier.email ?? '',
        orderPlatform: supplier.orderPlatform ?? '',
        cutoffDays: supplier.cutoffDays ?? '',
        deliveryDays: supplier.deliveryDays ?? '',
        aliases: supplier.aliases?.map(a => a.name) ?? [],
      })
      setAliasesToDelete([])
    } else {
      setForm(emptyForm)
      setAliasesToDelete([])
    }
  }, [supplier])

  const handleAddAlias = () => {
    const trimmed = newAlias.trim()
    if (!trimmed || form.aliases.includes(trimmed)) return
    setForm(prev => ({ ...prev, aliases: [...prev.aliases, trimmed] }))
    setNewAlias('')
  }

  const handleRemoveAlias = (name: string) => {
    setForm(prev => ({ ...prev, aliases: prev.aliases.filter(a => a !== name) }))
    // In edit mode, track existing alias IDs that need to be deleted
    if (supplier) {
      const existing = supplier.aliases?.find(a => a.name === name)
      if (existing) setAliasesToDelete(prev => [...prev, existing.id])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const { aliases, ...supplierData } = form

      if (supplier) {
        // Edit: update supplier fields
        await fetch(`/api/suppliers/${supplier.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(supplierData),
        })

        // Delete removed aliases
        await Promise.all(
          aliasesToDelete.map(id =>
            fetch(`/api/suppliers/${supplier.id}/aliases/${id}`, { method: 'DELETE' })
          )
        )

        // Add new aliases (ones not in the original supplier.aliases)
        const originalNames = new Set(supplier.aliases?.map(a => a.name) ?? [])
        const newAliases = aliases.filter(name => !originalNames.has(name))
        await Promise.all(
          newAliases.map(name =>
            fetch(`/api/suppliers/${supplier.id}/aliases`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            })
          )
        )
      } else {
        // Create: POST with aliases array
        await fetch('/api/suppliers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...supplierData, aliases }),
        })
      }

      onSaved()
      onClose()
    } catch {
      alert('Failed to save supplier. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-900">
            {supplier ? 'Edit Supplier' : 'Add Supplier'}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          {fields.map(f => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {f.label}{f.required && ' *'}
              </label>
              <input
                required={f.required}
                value={form[f.key] as string}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? ''}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}

          {/* Invoice Names section */}
          <div className="pt-1">
            <label className="block text-xs font-medium text-gray-600 mb-2">Invoice Names</label>
            <p className="text-xs text-gray-400 mb-2">OCR names from invoices that map to this supplier</p>
            {form.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {form.aliases.map(name => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded-md text-xs font-mono text-gray-700"
                  >
                    {name}
                    <button
                      type="button"
                      onClick={() => handleRemoveAlias(name)}
                      className="text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddAlias() } }}
                placeholder="Add invoice name…"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
              <button
                type="button"
                onClick={handleAddAlias}
                className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 transition-colors"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-gray-200 rounded-lg py-2 text-sm hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-blue-600 text-white rounded-lg py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : supplier ? 'Save Changes' : 'Add Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
