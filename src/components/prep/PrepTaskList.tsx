'use client'
import { X } from 'lucide-react'
import type { PrepTaskRow } from './types'
import TaskName from './TaskName'

interface Props {
  rows: PrepTaskRow[]   // pass only activeToday rows
  onDone: (taskId: string) => void
  onRemove: (taskId: string) => void
  asBlock?: boolean     // render as a board .block card (desktop grid) vs a plain section (mobile)
}

export default function PrepTaskList({ rows, onDone, onRemove, asBlock }: Props) {
  if (rows.length === 0) return null

  const inner = (row: PrepTaskRow) => (
    <>
      <input
        type="checkbox"
        checked={false}
        onChange={() => onDone(row.id)}
        className="shrink-0"
        aria-label={`Mark ${row.name} done`}
      />
      <span className="text-[14px] text-ink flex-1 min-w-0">
        <TaskName name={row.name} linkedInventoryItem={row.linkedInventoryItem} />
      </span>
      <button onClick={() => onRemove(row.id)} aria-label={`Remove ${row.name} from today`}
              className="text-ink-4 hover:text-red-text shrink-0">
        <X size={14} />
      </button>
    </>
  )

  if (asBlock) {
    return (
      <div className="block">
        <div className="bk-head">
          <span className="bk-dot dot-gray" />
          <span className="bk-title">TASKS</span>
          <span className="bk-meta">· {rows.length} item{rows.length > 1 ? 's' : ''}</span>
        </div>
        <div className="bk-body">
          {rows.map(row => (
            <div key={row.id} className="flex items-center gap-2 px-3.5 py-2 border-b border-line last:border-b-0">
              {inner(row)}
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <section className="mb-4">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 mb-2">Tasks</h3>
      <ul className="space-y-1">
        {rows.map(row => (
          <li key={row.id}
              className="flex items-center gap-2 rounded-lg border border-line bg-paper px-2 py-1.5">
            {inner(row)}
          </li>
        ))}
      </ul>
    </section>
  )
}
