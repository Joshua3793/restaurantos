import { computeWorkloadMinutes, formatMinutes } from '@/lib/prep-utils'
import type { PrepItemRich } from './types'

interface Props {
  items: PrepItemRich[]
  onFilterPriority?: (p: string) => void
}

export function PrepKpiStrip({ items, onFilterPriority }: Props) {
  const total       = items.length
  const isComplete  = (i: PrepItemRich) => i.todayLog?.status === 'DONE' || i.todayLog?.status === 'PARTIAL'
  const critical    = items.filter(i => i.priority === '911'          && !isComplete(i)).length
  const neededToday = items.filter(i => i.priority === 'NEEDED_TODAY' && !isComplete(i)).length
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
      <span className="text-gray-500">
        <span className="font-semibold text-gray-800">{total}</span> on list
      </span>
      {critical > 0 && (
        <button
          onClick={() => onFilterPriority?.('911')}
          className={`font-semibold text-red-600 ${onFilterPriority ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
        >
          {critical} × Critical
        </button>
      )}
      {neededToday > 0 && (
        <button
          onClick={() => onFilterPriority?.('NEEDED_TODAY')}
          className={`font-semibold text-orange-600 ${onFilterPriority ? 'hover:underline cursor-pointer' : 'cursor-default'}`}
        >
          {neededToday} needed today
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
