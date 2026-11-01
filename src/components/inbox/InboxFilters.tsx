'use client'
import type { TagLite } from '@/lib/inbox/rules'
import type { InboxView } from './format'
import { TagDot } from './TagChips'

// Desktop filter column: Status, Tag, Where, From.

function FilterButton({ on, onClick, children, count }: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
  count: number
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex justify-between items-center gap-2 min-h-[36px] px-2.5 rounded-lg text-[13.5px] text-left ${
        on ? 'bg-ink text-paper' : 'bg-transparent text-ink-2 hover:bg-bg-2'
      }`}
    >
      <span className="flex items-center gap-2 min-w-0">{children}</span>
      <span className="flex-none font-mono text-[11px]">{count}</span>
    </button>
  )
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="font-mono text-[10px] tracking-[0.08em] text-ink-3 px-2.5 pb-1.5">{children}</div>
)

const SELECT = 'h-10 border border-line-2 rounded-[9px] px-2.5 text-[13px] bg-paper text-ink min-w-0'

export function InboxFilters({
  view, statusCounts, onView,
  tags, tagCounts, tagTotal, tagId, onTag,
  places, place, onPlace,
  people, from, onFrom,
}: {
  view: InboxView
  statusCounts: Record<InboxView, number>
  onView: (v: InboxView) => void
  tags: TagLite[]
  tagCounts: Record<string, number>
  tagTotal: number
  tagId: string | null
  onTag: (id: string | null) => void
  places: string[]
  place: string | null
  onPlace: (p: string | null) => void
  people: Array<{ id: string; name: string }>
  from: string | null
  onFrom: (id: string | null) => void
}) {
  const STATUS: Array<[InboxView, string]> = [
    ['open', 'Open'], ['snoozed', 'Snoozed'], ['waiting', 'Waiting on someone'], ['done', 'Done'],
  ]
  return (
    <aside aria-label="Filters" className="flex flex-col gap-[18px] min-w-0">
      <div className="flex flex-col gap-1">
        <Label>STATUS</Label>
        {STATUS.map(([v, label]) => (
          <FilterButton key={v} on={view === v} onClick={() => onView(v)} count={statusCounts[v]}>{label}</FilterButton>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <Label>TAG</Label>
        <FilterButton on={tagId === null} onClick={() => onTag(null)} count={tagTotal}>All tags</FilterButton>
        {tags.map(t => (
          <FilterButton key={t.id} on={tagId === t.id} onClick={() => onTag(t.id)} count={tagCounts[t.id] ?? 0}>
            <TagDot color={t.color} />
            <span className="truncate">{t.name}</span>
          </FilterButton>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 px-2.5">
        <label className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] tracking-[0.08em] text-ink-3">WHERE</span>
          <select aria-label="Where" value={place ?? ''} onChange={e => onPlace(e.target.value || null)} className={SELECT}>
            <option value="">All stations</option>
            {places.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 mt-1.5">
          <span className="font-mono text-[10px] tracking-[0.08em] text-ink-3">FROM</span>
          <select aria-label="From" value={from ?? ''} onChange={e => onFrom(e.target.value || null)} className={SELECT}>
            <option value="">Anyone</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>
    </aside>
  )
}
