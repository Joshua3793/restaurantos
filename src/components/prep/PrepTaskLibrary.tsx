'use client'
import { useMemo, useRef, useState } from 'react'
import { Plus, GripVertical, Trash2, X, Check } from 'lucide-react'
import type { PrepTaskRow, LinkedItemSummary } from './types'

interface Props {
  rows: PrepTaskRow[]
  inventory: LinkedItemSummary[]
  disabled?: boolean            // true when no specific RC is selected
  onCreate: (name: string, linkedInventoryItemId: string | null) => void
  onToggleActive: (taskId: string, next: boolean) => void
  onDelete: (taskId: string) => void
  onReorder: (orderedIds: string[]) => void
}

// Lightweight fuzzy: case-insensitive subsequence match, ranked by match tightness.
function fuzzyFilter(items: LinkedItemSummary[], q: string): LinkedItemSummary[] {
  const query = q.toLowerCase().trim()
  if (!query) return items.slice(0, 8)
  const scored: { item: LinkedItemSummary; score: number }[] = []
  for (const item of items) {
    const name = item.itemName.toLowerCase()
    let qi = 0
    let firstIdx = -1
    for (let i = 0; i < name.length && qi < query.length; i++) {
      if (name[i] === query[qi]) { if (qi === 0) firstIdx = i; qi++ }
    }
    if (qi === query.length) scored.push({ item, score: firstIdx + (name.length - query.length) })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, 8).map(s => s.item)
}

export default function PrepTaskLibrary({
  rows, inventory, disabled, onCreate, onToggleActive, onDelete, onReorder,
}: Props) {
  const [draft, setDraft] = useState('')
  const [linkedItem, setLinkedItem] = useState<LinkedItemSummary | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null) // null = picker closed
  const dragId = useRef<string | null>(null)

  const suggestions = useMemo(
    () => (mentionQuery === null ? [] : fuzzyFilter(inventory, mentionQuery)),
    [mentionQuery, inventory],
  )

  function onDraftChange(value: string) {
    setDraft(value)
    const at = value.lastIndexOf('@')
    if (at >= 0 && !linkedItem) setMentionQuery(value.slice(at + 1))
    else setMentionQuery(null)
  }

  function pickItem(item: LinkedItemSummary) {
    setLinkedItem(item)
    // strip the "@query" fragment from the draft text
    const at = draft.lastIndexOf('@')
    setDraft(at >= 0 ? draft.slice(0, at).trimEnd() : draft)
    setMentionQuery(null)
  }

  function submit() {
    const name = draft.trim()
    if (!name) return
    onCreate(name, linkedItem?.id ?? null)
    setDraft(''); setLinkedItem(null); setMentionQuery(null)
  }

  function handleDrop(targetId: string) {
    const src = dragId.current
    dragId.current = null
    if (!src || src === targetId) return
    const ids = rows.map(r => r.id)
    const from = ids.indexOf(src)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
  }

  return (
    <section className="mb-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Tasks</h3>

      {disabled ? (
        <p className="text-[13px] text-ink-3 italic">Select a revenue center to manage tasks.</p>
      ) : (
        <>
          <ul className="space-y-1">
            {rows.map(row => (
              <li
                key={row.id}
                draggable
                onDragStart={() => { dragId.current = row.id }}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(row.id)}
                className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5"
              >
                <GripVertical size={14} className="text-ink-4 cursor-grab shrink-0" />
                <span className="text-[14px] text-ink flex-1">{row.name}</span>
                {row.linkedInventoryItem && (
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap">
                    {row.linkedInventoryItem.itemName}
                  </span>
                )}
                <button
                  onClick={() => onToggleActive(row.id, !row.activeToday)}
                  title={row.activeToday ? "Remove from today's list" : "Add to today's list"}
                  className={`shrink-0 px-2.5 py-1 rounded-[8px] text-[12px] font-medium inline-flex items-center gap-1 whitespace-nowrap transition-colors group ${
                    row.activeToday
                      ? 'bg-green-soft text-green-text border border-green-soft hover:border-red hover:bg-red-soft hover:text-red'
                      : 'bg-ink text-paper hover:bg-ink-2'
                  }`}
                >
                  {row.activeToday
                    ? <><Check size={12} className="text-green group-hover:text-red" /> On list <span className="opacity-50 ml-0.5">✕</span></>
                    : <><span className="text-gold font-semibold">+</span> Add</>}
                </button>
                <button onClick={() => onDelete(row.id)} aria-label={`Delete ${row.name}`}
                        className="text-ink-4 hover:text-red-text shrink-0">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>

          <div className="relative mt-2">
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-line bg-paper px-2 py-1.5">
                {linkedItem && (
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap flex items-center gap-1">
                    {linkedItem.itemName}
                    <button onClick={() => setLinkedItem(null)} aria-label="Remove linked ingredient">
                      <X size={11} />
                    </button>
                  </span>
                )}
                <input
                  value={draft}
                  onChange={e => onDraftChange(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submit() }}
                  placeholder="New task… (type @ to link an ingredient)"
                  className="flex-1 bg-transparent text-[14px] text-ink outline-none min-w-0"
                />
              </div>
              <button onClick={submit}
                      className="flex items-center gap-1 rounded-lg bg-ink text-paper px-2.5 py-1.5 text-[13px]">
                <Plus size={14} /> Add
              </button>
            </div>

            {mentionQuery !== null && suggestions.length > 0 && (
              <ul className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-line bg-paper shadow-lg">
                {suggestions.map(item => (
                  <li key={item.id}>
                    <button onClick={() => pickItem(item)}
                            className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-bg-2">
                      {item.itemName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  )
}
