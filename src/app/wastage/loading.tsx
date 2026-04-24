export default function Loading() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-gray-100 rounded w-36" />
        <div className="h-9 bg-gray-100 rounded w-28" />
      </div>
      {/* Summary banner */}
      <div className="h-16 bg-red-50 border border-red-100 rounded-xl" />
      {/* Filters */}
      <div className="flex gap-2">
        <div className="h-9 bg-gray-100 rounded w-36" />
        <div className="h-9 bg-gray-100 rounded w-32" />
        <div className="h-9 bg-gray-100 rounded w-32" />
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-40 bg-gray-100 rounded-xl" />
        <div className="h-40 bg-gray-100 rounded-xl" />
      </div>
      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="h-10 bg-gray-50 border-b border-gray-100" />
        {[1,2,3,4,5].map(i => (
          <div key={i} className="flex gap-4 px-4 py-3 border-b border-gray-50">
            <div className="h-4 bg-gray-100 rounded w-24" />
            <div className="h-4 bg-gray-100 rounded w-32" />
            <div className="h-4 bg-gray-100 rounded w-16 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
