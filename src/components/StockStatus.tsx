'use client'

export function StockStatus({ stock, parLevel }: { stock: number; parLevel?: number | null }) {
  if (stock <= 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-soft text-red-text">
      Out of Stock
    </span>
  )
  if (parLevel != null && stock < parLevel) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gold-soft text-gold-2">
      Low Stock
    </span>
  )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-soft text-green-text">
      In Stock
    </span>
  )
}
