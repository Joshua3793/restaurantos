export default function Loading() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-gray-100 rounded w-24" />
        <div className="h-9 bg-gray-100 rounded w-28" />
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <div key={i} className="h-20 bg-gray-100 rounded-xl" />)}
      </div>
      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="h-10 bg-gray-50 border-b border-gray-100" />
        {[1,2,3,4,5,6].map(i => (
          <div key={i} className="flex gap-4 px-4 py-3 border-b border-gray-50">
            <div className="h-4 bg-gray-100 rounded w-24" />
            <div className="h-4 bg-gray-100 rounded w-20" />
            <div className="h-4 bg-gray-100 rounded w-16 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
