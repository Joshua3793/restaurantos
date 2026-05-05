'use client'

export function StockStatus({ stock, parLevel }: { stock: number; parLevel?: number | null }) {
  if (stock <= 0) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
      Out of Stock
    </span>
  )
  if (parLevel != null && stock < parLevel) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
      Low Stock
    </span>
  )
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
      In Stock
    </span>
  )
}
