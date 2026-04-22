'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { SupplierDetail } from '@/components/suppliers/SupplierDetail'
import { SupplierFormModal } from '@/components/suppliers/SupplierFormModal'
import { SupplierSummary } from '@/components/suppliers/types'

export default function SupplierDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [supplier, setSupplier] = useState<SupplierSummary | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    fetch('/api/suppliers')
      .then(r => r.json())
      .then((data: SupplierSummary[]) => {
        setSupplier(data.find(s => s.id === params.id) ?? null)
      })
  }, [params.id])

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this supplier? Inventory items will be unlinked.')) return
    await fetch(`/api/suppliers/${id}`, { method: 'DELETE' })
    router.push('/suppliers')
  }

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Back button */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 shrink-0 bg-white">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={16} /> Suppliers
        </button>
      </div>

      <SupplierDetail
        supplierId={params.id}
        supplier={supplier}
        onEdit={() => setEditing(true)}
        onDelete={handleDelete}
      />

      {editing && supplier && (
        <SupplierFormModal
          supplier={supplier}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            fetch('/api/suppliers')
              .then(r => r.json())
              .then((data: SupplierSummary[]) => setSupplier(data.find(s => s.id === params.id) ?? null))
          }}
        />
      )}
    </div>
  )
}
