'use client'
import { useEffect, useRef, useState } from 'react'

// Type-to-search picker with an optional "+ Add …" row, shared by the inventory
// item drawer (category, storage area) and its supplier boxes (supplier).

export function Combobox({ items, value, placeholder, onSelect, onAddNew }: {
  items: { id: string; name: string }[]
  value: string
  placeholder?: string
  onSelect: (id: string, name: string) => void
  onAddNew?: (name: string) => Promise<{ id: string; name: string } | null>
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const filtered = items.filter(i => i.name.toLowerCase().includes(query.toLowerCase()))
  const exactMatch = items.some(i => i.name.toLowerCase() === query.toLowerCase())
  return (
    <div ref={ref} className="relative">
      <input
        value={open ? query : value}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { setOpen(true); setQuery('') }}
        placeholder={placeholder}
        className="w-full border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold"
      />
      {open && (
        <div className="absolute z-10 top-full left-0 right-0 bg-white border border-line rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
          {filtered.map(i => (
            <button key={i.id} type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-gold/10"
              onClick={() => { onSelect(i.id, i.name); setOpen(false); setQuery('') }}
            >{i.name}</button>
          ))}
          {!exactMatch && query && onAddNew && (
            <button type="button"
              className="w-full text-left px-3 py-2 text-sm text-gold font-medium hover:bg-gold/10"
              onClick={async () => { const r = await onAddNew(query); if (r) { onSelect(r.id, r.name); setOpen(false); setQuery('') } }}
            >+ Add &quot;{query}&quot;</button>
          )}
          {filtered.length === 0 && !query && <div className="px-3 py-2 text-xs text-ink-4">No options</div>}
        </div>
      )}
    </div>
  )
}
