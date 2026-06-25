'use client'
import { useMemo, useRef, useState } from 'react'
import { Plus, GripVertical, Trash2, Check } from 'lucide-react'
import type { PrepTaskRow, LinkedItemSummary } from './types'
import TaskName from './TaskName'

interface Props {
  rows: PrepTaskRow[]
  inventory: LinkedItemSummary[]
  disabled?: boolean            // true when no specific RC is selected
  asBlock?: boolean             // render as a board .block card (desktop grid) vs a plain section (mobile)
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
  rows, inventory, disabled, asBlock, onCreate, onToggleActive, onDelete, onReorder,
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
    // Open the picker while actively typing a mention: text after the last '@'
    // with no space yet. A completed/inserted mention (has a trailing space) closes it.
    const at = value.lastIndexOf('@')
    const frag = at >= 0 ? value.slice(at + 1) : null
    setMentionQuery(frag !== null && !frag.includes(' ') ? frag : null)
  }

  function pickItem(item: LinkedItemSummary) {
    // Insert "@<item> " inline at the '@' the user typed, so the tag lives where
    // the text is — e.g. "Slice @Salmon (is already cured)".
    const at = draft.lastIndexOf('@')
    const before = at >= 0 ? draft.slice(0, at) : draft
    setDraft(`${before}@${item.itemName} `)
    setLinkedItem(item)
    setMentionQuery(null)
  }

  function submit() {
    const name = draft.trim()
    if (!name) return
    // Only keep the link if its inline mention survived in the text.
    const linkedId = linkedItem && name.includes(`@${linkedItem.itemName}`) ? linkedItem.id : null
    onCreate(name, linkedId)
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

  // Inner controls for one library row (grip · name · Add/On-list · delete).
  const rowInner = (row: PrepTaskRow) => (
    <>
      <GripVertical size={14} className="text-ink-4 cursor-grab shrink-0" />
      <span className="text-[14px] text-ink flex-1 min-w-0">
        <TaskName name={row.name} linkedInventoryItem={row.linkedInventoryItem} />
      </span>
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
    </>
  )

  // The "new task" input + @-mention dropdown (shared by both layouts).
  const inputArea = (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center rounded-lg border border-line bg-paper px-2 py-1.5">
          <input
            value={draft}
            onChange={e => onDraftChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="New task… (type @ to tag an ingredient)"
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
  )

  // ── Board .block card (desktop grid) ──
  if (asBlock) {
    return (
      <div className="block prep-tasks">
        <div className="bk-head">
          <span className="bk-dot dot-gray" />
          <span className="bk-title">TASKS</span>
          {!disabled && <span className="bk-meta">· {rows.length} item{rows.length === 1 ? '' : 's'}</span>}
        </div>
        <div className="bk-body">
          {disabled ? (
            <p className="text-[13px] text-ink-3 italic px-3.5 py-2.5">Select a revenue center to manage tasks.</p>
          ) : (
            <>
              {rows.map(row => (
                <div
                  key={row.id}
                  draggable
                  onDragStart={() => { dragId.current = row.id }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(row.id)}
                  className="flex items-center gap-2 px-3.5 py-2 border-b border-line"
                >
                  {rowInner(row)}
                </div>
              ))}
              <div className="px-3.5 py-2.5">{inputArea}</div>
            </>
          )}
        </div>
      </div>
    )
  }

  // ── Plain section (mobile) ──
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
                {rowInner(row)}
              </li>
            ))}
          </ul>
          <div className="mt-2">{inputArea}</div>
        </>
      )}
    </section>
  )
}
