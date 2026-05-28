export default function Loading() {
  return (
    <div className="p-4 space-y-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 bg-gray-100 rounded w-32" />
        <div className="h-9 bg-gray-100 rounded w-28" />
      </div>
      {/* Session cards */}
      <div className="space-y-3">
        {[1,2,3].map(i => (
          <div key={i} className="h-24 bg-gray-100 rounded-xl" />
        ))}
      </div>
      <div className="h-[300px] bg-gray-100 rounded-xl" />
    </div>
  )
}
