'use client'
import type { PrepItemRich } from '@/components/prep/types'
import { toBoardRow } from './prep-board-utils'

const Chart = () => (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>)

// SMART PREP ONLY — the To-Do variant died with the board it summarised (the run
// sheet has its own status band). See PrepRow for the full note.
export function PrepSummaryLine({ items }: { items: PrepItemRich[] }) {
  const rows = items.map(toBoardRow)
  const crit = rows.filter(r => r.urgency === 'critical').length
  const low = rows.filter(r => r.urgency === 'low').length
  const par = rows.filter(r => r.urgency === 'par').length

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
