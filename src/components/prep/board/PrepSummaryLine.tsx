'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { toBoardRow } from './prep-board-utils'

const Info = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>)
const Chart = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>)

export function PrepSummaryLine({ items, view }: { items: PrepItemRich[]; view: 'todo' | 'smart' }) {
  const rows = items.map(toBoardRow)
  const crit = rows.filter(r => r.urgency === 'critical').length
  const low = rows.filter(r => r.urgency === 'low').length
  const par = rows.filter(r => r.urgency === 'par').length

  if (view === 'todo') {
    const list = rows.filter(r => r.onList)
    const done = list.filter(r => r.status === 'done').length
    const blocked = list.filter(r => r.stockOut).length
    const removed = list.filter(r => r.status === 'skipped').length
    return (
      <div className="summary">
        <span className="s"><b>{done}/{list.length}</b> done</span>
        <span className="s crit"><span className="dot dot-red" /><b>{list.filter(r => r.urgency === 'critical').length}</b> critical</span>
        <span className="s low"><b>{blocked}</b> blocked on stock</span>
        <span className="s"><b>{removed}</b> removed</span>
        <span className="hint"><Info /> carries over daily until done or removed</span>
      </div>
    )
  }
  return (
    <div className="summary">
      <span className="s"><b>{rows.length}</b> active</span>
      <span className="s crit"><span className="dot dot-red" /><b>{crit}</b> critical</span>
      <span className="s low"><span className="dot dot-amber" /><b>{low}</b> low / needed today</span>
      <span className="s par"><span className="dot dot-green" /><b>{par}</b> on par</span>
      <span className="hint"><Chart /> computed live from theoretical stock · resets at next count</span>
    </div>
  )
}
