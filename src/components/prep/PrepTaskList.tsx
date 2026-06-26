'use client'
import { X } from 'lucide-react'
import type { PrepTaskRow } from './types'

interface Props {
  rows: PrepTaskRow[]   // pass only activeToday rows
  onDone: (taskId: string) => void
  onRemove: (taskId: string) => void
}

export default function PrepTaskList({ rows, onDone, onRemove }: Props) {
  if (rows.length === 0) return null
  return (
    <section className="mb-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Tasks</h3>
      <ul className="space-y-1">
        {rows.map(row => (
          <li key={row.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5">
            <input
              type="checkbox"
              checked={false}
              onChange={() => onDone(row.id)}
              className="shrink-0"
              aria-label={`Mark ${row.name} done`}
            />
            <span className="text-[14px] text-ink flex-1">{row.name}</span>
            {row.linkedInventoryItem && (
              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-gold-soft text-gold-2 whitespace-nowrap">
                {row.linkedInventoryItem.itemName}
              </span>
            )}
            <button onClick={() => onRemove(row.id)} aria-label={`Remove ${row.name} from today`}
                    className="text-ink-4 hover:text-red-text shrink-0">
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
