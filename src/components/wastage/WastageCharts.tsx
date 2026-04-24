'use client'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import { formatCurrency } from '@/lib/utils'

const CHART_COLORS = ['#ef4444','#f97316','#eab308','#6b7280','#3b82f6','#a855f7','#22c55e','#9ca3af']

interface Props {
  byReason: { reason: string; cost: number }[]
  byWeek:   { week: string; cost: number }[]
}

export default function WastageCharts({ byReason, byWeek }: Props) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Pie: by reason */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="text-sm font-semibold text-gray-700 mb-3">Cost by Reason</div>
        <div className="flex items-center gap-4">
          <ResponsiveContainer width={140} height={140}>
            <PieChart>
              <Pie
                data={byReason}
                dataKey="cost"
                nameKey="reason"
                cx="50%"
                cy="50%"
                innerRadius={38}
                outerRadius={60}
                paddingAngle={2}
              >
                {byReason.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => formatCurrency(Number(v))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-1.5 min-w-0">
            {byReason.map((d, i) => (
              <div key={d.reason} className="flex items-center gap-2 text-xs">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                <span className="text-gray-600 truncate flex-1">{d.reason}</span>
                <span className="font-semibold text-gray-800 shrink-0">{formatCurrency(d.cost)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bar: weekly trend */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="text-sm font-semibold text-gray-700 mb-3">Weekly Trend</div>
        {byWeek.length > 1 ? (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={byWeek} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `$${v}`} />
              <Tooltip formatter={(v) => [formatCurrency(Number(v)), 'Cost']} />
              <Bar dataKey="cost" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[140px] flex items-center justify-center text-sm text-gray-400">
            Not enough data for trend — expand date range
          </div>
        )}
      </div>
    </div>
  )
}
