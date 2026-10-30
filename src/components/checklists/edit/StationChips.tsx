'use client'
import { useRef } from 'react'
import { chipName, type EditStation } from '@/lib/checklists/edit-format'

// The editor's station chips: the shared list ("Everyone") first, then the
// stations in their order, scrolling sideways. The selected station gets an
// "Edit" chip; a long-press on any station chip opens the same menu.

const LONG_PRESS_MS = 500

const CHIP = 'flex-none flex items-center gap-1.5 min-h-[44px] px-3 rounded-full text-[13px] font-medium whitespace-nowrap'

function StationChip({
  s,
  selected,
  onSelect,
  onLongPress,
}: {
  s: EditStation
  selected: boolean
  onSelect: () => void
  onLongPress: (() => void) | null
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onPointerDown={() => {
        fired.current = false
        if (!onLongPress) return
        clear()
        timer.current = setTimeout(() => { fired.current = true; onLongPress() }, LONG_PRESS_MS)
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={e => { if (onLongPress) e.preventDefault() }}
      onClick={() => {
        if (fired.current) { fired.current = false; return }
        onSelect()
      }}
      className={`${CHIP} select-none [-webkit-touch-callout:none] ${selected ? 'bg-ink text-paper border border-ink' : 'bg-paper text-ink-2 border border-line'}`}
    >
      <span className="w-[7px] h-[7px] rounded-full" style={{ background: s.color }} aria-hidden />
      {chipName(s)}
    </button>
  )
}

export function StationChips({
  stations,
  selectedId,
  onSelect,
  onEdit,
  onAdd,
}: {
  /** Already in chip order (shared first). */
  stations: EditStation[]
  selectedId: string | null
  onSelect: (id: string) => void
  onEdit: (s: EditStation) => void
  onAdd: () => void
}) {
  return (
    <div role="group" aria-label="Stations" className="flex gap-1.5 overflow-x-auto -mr-4 pr-4 pb-0.5">
      {stations.map(s => (
        <span key={s.id} className="flex-none flex gap-1.5">
          <StationChip
            s={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onLongPress={s.isShared ? null : () => { onSelect(s.id); onEdit(s) }}
          />
          {s.id === selectedId && !s.isShared && (
            <button
              type="button"
              aria-label={`Edit ${s.name}`}
              onClick={() => onEdit(s)}
              className={`${CHIP} bg-paper text-ink-3 border border-line-2 font-mono text-[11px]`}
            >
              Edit
            </button>
          )}
        </span>
      ))}
      <button type="button" onClick={onAdd} className={`${CHIP} border border-dashed border-line-2 text-ink-2`}>
        + Station
      </button>
    </div>
  )
}
