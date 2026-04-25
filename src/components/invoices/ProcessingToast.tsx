'use client'
import { useEffect } from 'react'
import { CheckCircle2, X } from 'lucide-react'

interface Props {
  supplierName: string | null
  invoiceNumber: string | null
  onReview: () => void
  onDismiss: () => void
}

export function ProcessingToast({ supplierName, invoiceNumber, onReview, onDismiss }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [onDismiss])

  const label = supplierName ?? invoiceNumber ?? 'Invoice'

  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-6 sm:bottom-8 z-[70] w-[calc(100vw-32px)] sm:w-80 bg-white border border-gray-200 rounded-2xl shadow-xl flex items-start gap-3 p-4 animate-in slide-in-from-bottom-4 duration-300">
      <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
        <CheckCircle2 size={16} className="text-green-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">Ready for review</p>
        <button
          onClick={onReview}
          className="mt-2 text-xs font-semibold text-blue-600 hover:text-blue-800"
        >
          Review now →
        </button>
      </div>
      <button onClick={onDismiss} className="text-gray-300 hover:text-gray-500 shrink-0">
        <X size={14} />
      </button>
    </div>
  )
}
