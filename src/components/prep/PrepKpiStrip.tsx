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

  const cards = [
    { label: 'Total Items',  value: total,       color: 'text-gray-900',   bg: 'bg-white',     border: 'border-gray-100',   filter: '' },
    { label: '911',          value: urgent,      color: 'text-red-600',    bg: 'bg-red-50',    border: 'border-red-200',    filter: '911' },
    { label: 'Needed Today', value: neededToday, color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200', filter: 'NEEDED_TODAY' },
    { label: 'Low Stock',    value: lowStock,    color: 'text-amber-600',  bg: 'bg-amber-50',  border: 'border-amber-200',  filter: 'LOW_STOCK' },
    { label: 'Done Today',   value: done,        color: 'text-green-600',  bg: 'bg-green-50',  border: 'border-green-200',  filter: '' },
    { label: 'Blocked',      value: blocked,     color: 'text-red-500',    bg: 'bg-white',     border: 'border-gray-100',   filter: '' },
  ]

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
      {cards.map(card => (
        <button
          key={card.label}
          onClick={() => card.filter && onFilterPriority(card.filter)}
          className={`${card.bg} border ${card.border} rounded-xl p-3 text-left shadow-sm transition-all ${card.filter ? 'hover:shadow-md hover:scale-[1.02] cursor-pointer' : 'cursor-default'}`}
        >
          <div className="text-xs font-medium text-gray-500 mb-1">{card.label}</div>
          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
        </button>
      ))}
    </div>
  )
}
