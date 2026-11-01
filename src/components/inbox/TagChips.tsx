'use client'
import type { TagLite } from '@/lib/inbox/rules'

// Phone: All + one chip per tag, scrolling sideways, each with its count.

export function TagDot({ color, size = 7 }: { color: string; size?: number }) {
  return <span className="flex-none rounded-full" style={{ width: size, height: size, background: color }} aria-hidden />
}

export function TagChips({ tags, counts, total, tagId, onPick }: {
  tags: TagLite[]
  counts: Record<string, number>
  total: number
  tagId: string | null
  onPick: (tagId: string | null) => void
}) {
  const chip = (key: string | null, label: string, count: number, color: string | null) => {
    const on = tagId === key
    return (
      <button
        key={key ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => onPick(key)}
        className={`flex-none flex items-center gap-1.5 min-h-[44px] px-3 rounded-full text-[13px] font-medium border ${
          on ? 'bg-ink text-paper border-ink' : 'bg-paper text-ink-2 border-line'
        }`}
      >
        {color && <TagDot color={color} />}
        {label} <span className="font-mono text-[10.5px] opacity-70">{count}</span>
      </button>
    )
  }
  return (
    <div role="group" aria-label="Filter by tag" className="flex gap-1.5 overflow-x-auto -mr-4 pr-4">
      {chip(null, 'All', total, null)}
      {tags.map(t => chip(t.id, t.name, counts[t.id] ?? 0, t.color))}
    </div>
  )
}
