export default function Loading() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {/* KPI strip */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
        {[1,2,3,4,5].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl" />)}
      </div>
      {/* Filters */}
      <div className="flex gap-2">
        <div className="h-9 bg-gray-100 rounded flex-1" />
        <div className="h-9 bg-gray-100 rounded w-28" />
      </div>
      {/* Prep item rows */}
      {[1,2,3,4,5,6,7].map(i => (
        <div key={i} className="h-20 bg-gray-100 rounded-xl" />
      ))}
    </div>
  )
}
