export default function Loading() {
  return (
    <div className="p-4 space-y-3 animate-pulse">
      {/* Header + filter bar */}
      <div className="flex items-center justify-between gap-3">
        <div className="h-8 bg-bg-2 rounded w-36" />
        <div className="h-9 bg-bg-2 rounded w-24" />
      </div>
      <div className="flex gap-2">
        <div className="h-9 bg-bg-2 rounded flex-1" />
        <div className="h-9 bg-bg-2 rounded w-24" />
        <div className="h-9 bg-bg-2 rounded w-24" />
      </div>
      {/* Table skeleton */}
      <div className="bg-white rounded-xl border border-line overflow-hidden">
        <div className="h-10 bg-bg border-b border-line" />
        {[1,2,3,4,5,6,7,8].map(i => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-line">
            <div className="h-4 bg-bg-2 rounded w-1/3" />
            <div className="h-4 bg-bg-2 rounded w-16" />
            <div className="h-4 bg-bg-2 rounded w-20 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
