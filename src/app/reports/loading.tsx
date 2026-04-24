export default function Loading() {
  return (
    <div className="space-y-5 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="h-8 bg-gray-100 rounded w-32 mb-1.5" />
          <div className="h-4 bg-gray-100 rounded w-64" />
        </div>
        <div className="h-9 bg-gray-100 rounded w-44" />
      </div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-100 pb-0">
        {[1,2,3,4,5].map(i => <div key={i} className="h-9 bg-gray-100 rounded-t w-24" />)}
      </div>
      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[1,2,3,4,5].map(i => <div key={i} className="h-24 bg-gray-100 rounded-xl" />)}
      </div>
      {/* Chart placeholders */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 h-64 bg-gray-100 rounded-xl" />
        <div className="h-64 bg-gray-100 rounded-xl" />
      </div>
    </div>
  )
}
