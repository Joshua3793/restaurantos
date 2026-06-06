'use client'
import { CATEGORY_COLORS } from '@/lib/utils'

export function CategoryBadge({ category }: { category: string }) {
  const colors = CATEGORY_COLORS[category] || 'bg-bg-2 text-ink-2'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors}`}>
      {category}
    </span>
  )
}
