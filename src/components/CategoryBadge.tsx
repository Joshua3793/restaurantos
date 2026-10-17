'use client'
import { categoryDot } from '@/lib/utils'

// Controla category tag: 7px data-colour dot + name in ink-2 (12.5px/500).
export function CategoryBadge({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center gap-[7px] text-[12.5px] font-medium text-ink-2 tracking-[-0.005em] whitespace-nowrap">
      <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: categoryDot(category) }} />
      {category}
    </span>
  )
}
