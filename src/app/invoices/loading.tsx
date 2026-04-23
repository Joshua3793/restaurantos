export default function Loading() {
  return (
    <div className="flex flex-col h-[calc(100vh-64px)] animate-pulse">
      <div className="px-4 pt-3 pb-1 shrink-0">
        <div className="h-7 bg-gray-100 rounded w-24" />
      </div>
      {/* KPI strip */}
      <div className="px-4 py-2 shrink-0">
        <div className="grid grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <div key={i} className="h-16 bg-gray-100 rounded-xl" />)}
        </div>
      </div>
      {/* List */}
      <div className="flex-1 overflow-hidden px-4 space-y-2 pt-2">
        {[1,2,3,4,5,6].map(i => (
          <div key={i} className="h-16 bg-gray-100 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
