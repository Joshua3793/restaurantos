import { computeWorkloadMinutes, formatMinutes } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Props {
  items: PrepItemRich[]
  onFilterPriority: (p: string) => void
}

export function PrepKpiStrip({ items, onFilterPriority }: Props) {
  const total       = items.length
  const urgent      = items.filter(i => i.priority === '911').length
  const neededToday = items.filter(i => i.priority === 'NEEDED_TODAY').length
  const lowStock    = items.filter(i => i.priority === 'LOW_STOCK').length
  const done        = items.filter(i => i.todayLog?.status === 'DONE').length
  const blocked     = items.filter(i => i.isBlocked || i.todayLog?.status === 'BLOCKED').length

  const workloadMinutes   = computeWorkloadMinutes(items)
  const formattedWorkload = formatMinutes(workloadMinutes)

  if (total === 0) return null

  if (done === total) {
    return (
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="font-semibold text-green-600">✓ All done!</span>
        <span className="text-gray-400">{done} / {total} done</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4 text-sm flex-wrap">
      {urgent > 0 && (
        <button onClick={() => onFilterPriority('911')} className="font-semibold text-red-600 hover:underline cursor-pointer">
          {urgent} × 911
        </button>
      )}
      {neededToday > 0 && (
        <button onClick={() => onFilterPriority('NEEDED_TODAY')} className="font-semibold text-orange-600 hover:underline cursor-pointer">
          {neededToday} needed today
        </button>
      )}
      {lowStock > 0 && (
        <button onClick={() => onFilterPriority('LOW_STOCK')} className="text-amber-600 hover:underline cursor-pointer">
          {lowStock} low stock
        </button>
      )}
      <span className="text-gray-400">{done} / {total} done</span>
      {workloadMinutes > 0 && (
        <span className="text-gray-500">{formattedWorkload} remaining</span>
      )}
      {blocked > 0 && (
        <span className="text-red-500">{blocked} blocked</span>
      )}
    </div>
  )
}
