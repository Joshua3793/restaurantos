'use client'
import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { SupplierForm, SupplierSummary } from './types'

const emptyForm: SupplierForm = {
  name: '', contactName: '', phone: '', email: '',
  orderPlatform: '', cutoffDays: '', deliveryDays: '',
}

const fields: { key: keyof SupplierForm; label: string; required?: boolean; placeholder?: string }[] = [
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
      })
    } else {
      setForm(emptyForm)
    }
  }, [supplier])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch(
        supplier ? `/api/suppliers/${supplier.id}` : '/api/suppliers',
        {
          method: supplier ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        }
      )
      if (!res.ok) throw new Error(await res.text())
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
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
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
                value={form[f.key]}
                onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder ?? ''}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
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
