'use client'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { itemPills, type CategoryTree, type EditItem, type PillTone } from '@/lib/checklists/edit-format'
import type { Phase } from '@/lib/checklists/rules'

// One category on the editor: header (name, move up / down, Edit), its jobs with
// their tags and move buttons, and "+ Add item".

const TONE: Record<PillTone, string> = {
  red: 'bg-red-soft text-red-text',
  blue: 'bg-blue-soft text-blue-text',
  gold: 'bg-gold-soft text-gold-2',
  grey: 'bg-bg-2 text-ink-3',
}

function MoveButtons({ label, first, last, onMove }: { label: string; first: boolean; last: boolean; onMove: (dir: -1 | 1) => void }) {
  const cls = 'w-11 h-11 grid place-items-center rounded-[9px] text-ink-3 disabled:text-line-2'
  return (
    <span className="flex-none flex">
      <button type="button" aria-label={`Move ${label}up`} disabled={first} onClick={() => onMove(-1)} className={cls}>
        <ChevronUp size={18} aria-hidden />
      </button>
      <button type="button" aria-label={`Move ${label}down`} disabled={last} onClick={() => onMove(1)} className={cls}>
        <ChevronDown size={18} aria-hidden />
      </button>
    </span>
  )
}

export function CategoryCard({
  category,
  phase,
  first,
  last,
  tempUnitName,
  onMove,
  onEdit,
  onMoveItem,
  onOpenItem,
  onAddItem,
}: {
  category: CategoryTree
  phase: Phase
  first: boolean
  last: boolean
  tempUnitName: (id: string | null) => string | null
  onMove: (dir: -1 | 1) => void
  onEdit: () => void
  onMoveItem: (index: number, dir: -1 | 1) => void
  onOpenItem: (item: EditItem) => void
  onAddItem: () => void
}) {
  const items = category.items
  return (
    <section aria-label={category.name} className="bg-paper border border-line rounded-[14px] overflow-hidden">
      <div className="flex items-center gap-1 pl-4 pr-1 py-1 border-b border-line">
        <h3 className="m-0 flex-1 min-w-0 font-mono text-[10px] font-medium tracking-[0.08em] text-ink-2 uppercase truncate">{category.name}</h3>
        <MoveButtons label="category " first={first} last={last} onMove={onMove} />
        <button type="button" aria-label={`Edit ${category.name}`} onClick={onEdit} className="flex-none min-w-[44px] min-h-[44px] px-2 font-mono text-[11px] text-ink-3">
          Edit
        </button>
      </div>

      {items.length === 0 && (
        <p className="m-0 px-4 py-3 text-[13px] text-ink-3 border-b border-bg-2">No jobs here yet.</p>
      )}
      {items.map((it, i) => (
        <div key={it.id} className="flex items-center gap-1 pl-1 pr-1 border-b border-bg-2 min-h-[56px]">
          <button
            type="button"
            onClick={() => onOpenItem(it)}
            className="flex-1 min-w-0 flex items-center gap-2 min-h-[52px] py-1.5 pl-3 pr-1 text-left"
          >
            <span className="flex-1 min-w-0 flex flex-col gap-[5px]">
              <span className="text-[14.5px] font-medium tracking-[-0.01em] text-ink">{it.title}</span>
              <span className="flex gap-1 flex-wrap">
                {itemPills(it, phase, tempUnitName(it.tempUnitId)).map(p => (
                  <span key={p.label} className={`font-mono text-[9.5px] font-medium px-[7px] py-0.5 rounded-full whitespace-nowrap ${TONE[p.tone]}`}>
                    {p.label}
                  </span>
                ))}
              </span>
            </span>
            <span className="flex-none text-ink-4 text-[16px]" aria-hidden>›</span>
          </button>
          <MoveButtons label="" first={i === 0} last={i === items.length - 1} onMove={dir => onMoveItem(i, dir)} />
        </div>
      ))}

      <button type="button" onClick={onAddItem} className="w-full min-h-[48px] px-4 text-left text-[13px] font-medium text-gold-2">
        + Add item
      </button>
    </section>
  )
}
